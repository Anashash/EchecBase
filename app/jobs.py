"""Tâches de fond : import + analyse Stockfish des débuts de partie."""
import threading
import time
import traceback

import chess

from . import config, db, engine, importer

status = {"running": False, "step": "", "done": 0, "total": 0, "eta": None, "error": None,
          "last_run": None, "added": 0}
_thread = None
_stop = threading.Event()
_phase = {"step": None, "t0": 0.0, "done0": 0}


def _progress(step, done, total):
    """done/total : compteurs globaux (parties déjà traitées comprises), eta : secondes restantes estimées."""
    now = time.time()
    if _phase["step"] != step:
        _phase.update(step=step, t0=now, done0=done)
    eta = None
    progressed, elapsed = done - _phase["done0"], now - _phase["t0"]
    if progressed > 0 and elapsed > 0 and done < total:
        eta = int((total - done) * elapsed / progressed)
    status.update(step=step, done=done, total=total, eta=eta)


def start(do_import=True):
    global _thread
    if status["running"] or not config.active_profile():
        return False
    _stop.clear()
    _phase["step"] = None
    status.update(running=True, error=None, step="Démarrage", done=0, total=0, eta=None, added=0)
    _thread = threading.Thread(target=_run, args=(do_import,), daemon=True)
    _thread.start()
    return True


def stop():
    _stop.set()


def wait(timeout):
    """Attend la fin de la tâche en cours (après stop())."""
    if _thread is not None:
        _thread.join(timeout)


def _run(do_import):
    try:
        if do_import:
            status["added"] = importer.import_chesscom(_progress, _stop)
        analyse_pending()
        if not _stop.is_set():
            from . import training
            training.sync()
        if not _stop.is_set() and config.load().get("auto_review", True):
            review_pending()
    except Exception as e:
        traceback.print_exc()
        status["error"] = str(e)
    finally:
        status.update(running=False, step="Terminé" if not status["error"] else "Erreur",
                      last_run=int(time.time()))


def analyse_pending():
    cfg = config.load()
    plies, depth = int(cfg["analysis_plies"]), int(cfg["analysis_depth"])
    con = db.connect()
    try:
        pending = [r[0] for r in con.execute(
            "SELECT id FROM games WHERE analyzed=0 ORDER BY played_at DESC")]
        total = con.execute("SELECT COUNT(*) FROM games").fetchone()[0]
        done = total - len(pending)
        for gid in pending:
            if _stop.is_set():
                break
            _progress("Analyse des débuts", done, total)
            analyse_game(con, gid, plies, depth)
            done += 1
        _progress("Analyse des débuts", done, total)
    finally:
        con.close()


def review_pending():
    """Analyse complète (toute la partie) des parties qui ne l'ont pas encore eue, des plus récentes aux plus anciennes,
    limitée aux N derniers mois si review_months est réglé."""
    from . import review
    con = db.connect()
    try:
        def counts(cutoff):
            r = con.execute("SELECT COUNT(*), SUM(reviewed) FROM games WHERE played_at>=?", (cutoff,)).fetchone()
            return r[0], r[1] or 0

        months, cutoff = config.load().get("review_months"), config.review_cutoff()
        pending = con.execute("SELECT id, played_at FROM games WHERE reviewed=0 AND played_at>=? "
                              "ORDER BY played_at DESC", (cutoff,)).fetchall()
        total, done = counts(cutoff)
        for gid, played_at in pending:
            if _stop.is_set():
                break
            # La période a pu être réduite dans les Réglages pendant l'analyse (parties triées : on peut s'arrêter)
            if config.load().get("review_months") != months:
                months, cutoff = config.load().get("review_months"), config.review_cutoff()
                total, done = counts(cutoff)
            if played_at < cutoff:
                break
            if review.busy(gid):
                continue
            _progress("Analyse complète", done, total)
            st = review._status.setdefault(gid, {})
            st.update(running=True, done=0, total=0, error=None)
            try:
                if review.review_game(con, gid, st, _stop):
                    done += 1
            finally:
                st["running"] = False
        _progress("Analyse complète", done, total)
    finally:
        con.close()


def analyse_game(con, gid, plies, depth):
    moves = con.execute(
        "SELECT ply, fen, fen_after, uci FROM moves WHERE game_id=? AND ply<? ORDER BY ply",
        (gid, plies)).fetchall()
    for m in moves:
        ev = engine.eval_position(m["fen"], depth, con)
        after_board = engine.board_from_key(m["fen_after"])
        before = db.winp(ev["cp"], ev["mate"])
        if after_board.is_checkmate():
            after = 100.0
        else:
            ev2 = engine.eval_position(m["fen_after"], depth, con)
            after = 100.0 - db.winp(ev2["cp"], ev2["mate"])
        best_san = None
        if ev["best"]:
            b = engine.board_from_key(m["fen"])
            best_san = b.san(chess.Move.from_uci(ev["best"]))
        loss = 0.0 if m["uci"] == ev["best"] else max(0.0, before - after)
        con.execute(
            "UPDATE moves SET wp_before=?, wp_after=?, loss=?, best_uci=?, best_san=? WHERE game_id=? AND ply=?",
            (round(before, 2), round(after, 2), round(loss, 2), ev["best"], best_san, gid, m["ply"]))
        # Valide tout de suite : ne jamais garder un verrou d'écriture pendant que Stockfish calcule.
        con.commit()
    con.execute("UPDATE games SET analyzed=1 WHERE id=?", (gid,))
    con.commit()


def reset_analysis():
    con = db.connect()
    con.execute("UPDATE games SET analyzed=0")
    con.execute("UPDATE moves SET wp_before=NULL, wp_after=NULL, loss=NULL, best_uci=NULL, best_san=NULL")
    con.commit()
    con.close()
