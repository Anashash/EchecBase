"""Entraînement par répétition espacée : répertoire, positions ratées et quiz de la formation."""
import json
import random
import time

import chess

from . import config, db, engine, repertoire

try:  # module optionnel, absent du dépôt public
    from . import courses
except ImportError:
    courses = None

DAY = 86400


def sync():
    """(Re)construit les cartes à partir du répertoire et des erreurs analysées."""
    t = config.load()["thresholds"]
    con = db.connect()
    try:
        existing = {r["id"]: dict(r) for r in con.execute("SELECT id, active FROM training")}
        wanted = {}
        for color in ("white", "black"):
            g, paths = repertoire.paths(color, con)
            for fen, es in g.items():
                if not repertoire.is_my_turn(fen, color) or fen not in paths:
                    continue
                sans, ucis = paths[fen]
                wanted[f"rep:{color}:{fen}"] = ("rep", color, fen, [e["uci"] for e in es], ucis,
                                                {"sans": sans, "expected": [e["san"] for e in es]})
        q = ("SELECT m.fen, g.my_color color, COUNT(*) n, SUM(m.loss>=?) errors, MAX(m.game_id) gid, MAX(m.ply) ply "
             "FROM moves m JOIN games g ON g.id=m.game_id WHERE m.mine=1 AND m.loss IS NOT NULL AND m.ply<? "
             "GROUP BY m.fen, g.my_color HAVING SUM(m.loss>=?) >= 1")
        plies = int(config.load()["analysis_plies"])
        for r in con.execute(q, (plies, t["mistake"], t["mistake"])):
            ev = con.execute("SELECT best FROM evals WHERE fen=?", (r["fen"],)).fetchone()
            if not ev or not ev["best"]:
                continue
            ex = con.execute("SELECT game_id, ply FROM moves WHERE fen=? AND mine=1 AND loss>=? LIMIT 1",
                             (r["fen"], t["mistake"])).fetchone()
            line = con.execute("SELECT uci, san FROM moves WHERE game_id=? AND ply<? ORDER BY ply",
                               (ex["game_id"], ex["ply"])).fetchall()
            bad = con.execute("SELECT san, COUNT(*) c FROM moves WHERE fen=? AND mine=1 AND loss>=? "
                              "GROUP BY uci ORDER BY c DESC LIMIT 1", (r["fen"], t["mistake"])).fetchone()
            b = engine.board_from_key(r["fen"])
            wanted[f"fix:{r['color']}:{r['fen']}"] = (
                "fix", r["color"], r["fen"], [ev["best"]], [x["uci"] for x in line],
                {"sans": [x["san"] for x in line], "expected": [b.san(chess.Move.from_uci(ev["best"]))],
                 "bad": bad["san"] if bad else None, "n": r["n"], "errors": r["errors"]})
        # Quiz des leçons terminées
        if courses is not None:
            wanted.update(courses.training_cards())
        for cid, (kind, color, fen, answers, ucis, info) in wanted.items():
            if cid in existing:
                con.execute("UPDATE training SET answers=?, line=?, info=?, active=1 WHERE id=?",
                            (json.dumps(answers), json.dumps(ucis), json.dumps(info), cid))
            else:
                con.execute("INSERT INTO training(id,kind,color,fen,answers,line,info,due) VALUES(?,?,?,?,?,?,?,0)",
                            (cid, kind, color, fen, json.dumps(answers), json.dumps(ucis), json.dumps(info)))
        for cid, r in existing.items():
            if cid not in wanted and r["active"]:
                con.execute("UPDATE training SET active=0 WHERE id=?", (cid,))
        con.commit()
    finally:
        con.close()


KINDS = ("rep", "fix", "course")


def _where(kind):
    return " AND kind=?" if kind in KINDS else "", ((kind,) if kind in KINDS else ())


def counts():
    now = int(time.time())
    out = {}
    for kind in KINDS + ("all",):
        w, p = _where(kind)
        r = db.one("SELECT COUNT(*) total, SUM(due<=?) due, SUM(reps=0 AND last IS NULL) new "
                   "FROM training WHERE active=1" + w, (now,) + p)
        out[kind] = {k: r[k] or 0 for k in ("total", "due", "new")}
    return out


def _card(r):
    c = dict(r)
    c["line"] = json.loads(c["line"] or "[]")
    info = json.loads(c["info"] or "{}")
    c["sans"] = info.get("sans", [])
    c["bad"] = info.get("bad")
    c["n"] = info.get("n")
    if c["kind"] == "course":
        c["quiz"] = {k: info.get(k) for k in ("q", "type", "options", "title", "course", "lesson")}
    c.pop("answers")
    c.pop("info")
    return c


def next_card(kind="all", exclude=None):
    now = int(time.time())
    w, p = _where(kind)
    params = (now,) + p
    sql = "SELECT * FROM training WHERE active=1 AND due<=?" + w
    if exclude:
        sql += " AND id<>?"
        params += (exclude,)
    # D'abord les cartes déjà vues et dues, puis les nouvelles (dans l'ordre de la ligne)
    rs = db.rows(sql + " AND last IS NOT NULL ORDER BY due LIMIT 20", params)
    if rs:
        return _card(random.choice(rs[:5]))
    rs = db.rows(sql + " AND last IS NULL ORDER BY kind DESC, length(line), id LIMIT 1", params)
    return _card(rs[0]) if rs else None


def answer(cid, uci):
    con = db.connect()
    try:
        r = con.execute("SELECT * FROM training WHERE id=?", (cid,)).fetchone()
        if not r:
            return {"error": "carte inconnue"}
        info = json.loads(r["info"] or "{}")
        if r["kind"] == "course":
            q = courses and courses.find_quiz(info["course"], info["lesson"], info["qid"])
            if not q:
                return {"error": "ce quiz n'existe plus"}
            res = courses.check_quiz(q, uci)
            if "error" not in res:
                _schedule(con, r, res["correct"])
                con.commit()
            return res
        answers = set(json.loads(r["answers"]))
        board = engine.board_from_key(r["fen"])
        move = chess.Move.from_uci(uci)
        if move not in board.legal_moves:
            return {"error": "coup illégal"}
        san = board.san(move)
        rep_moves = {e["uci"] for e in repertoire.graph(r["color"], con).get(r["fen"], [])}
        correct, note, loss = False, "", None
        if uci in answers:
            correct = True
        elif r["kind"] == "fix" and uci in rep_moves:
            correct, note = True, "C'est le coup de ton répertoire."
        elif r["kind"] == "fix":
            _, _, loss = engine.move_loss(r["fen"], uci)
            if loss < config.load()["thresholds"]["inaccuracy"]:
                correct, note = True, "Pas le premier choix de Stockfish, mais tout à fait jouable."
            else:
                note = f"Ce coup perd environ {loss:.0f} % de chances de gain."
        else:
            note = "Ce n'est pas le coup de ton répertoire."
        _schedule(con, r, correct)
        con.commit()
        return {"correct": correct, "played": san, "expected": info.get("expected", []),
                "expected_uci": json.loads(r["answers"]), "note": note, "loss": loss}
    finally:
        con.close()


def _schedule(con, r, correct):
    now = int(time.time())
    ease, interval, reps, lapses = r["ease"], r["interval"], r["reps"], r["lapses"]
    if correct:
        reps += 1
        interval = 1 if reps == 1 else 3 if reps == 2 else round(interval * ease, 1)
        ease = min(3.0, ease + 0.05)
        due = now + int(interval * DAY)
    else:
        reps, lapses = 0, lapses + 1
        ease = max(1.3, ease - 0.2)
        interval = 0
        due = now + 600  # revue dans 10 minutes
    con.execute("UPDATE training SET ease=?, interval=?, reps=?, lapses=?, due=?, last=? WHERE id=?",
                (ease, interval, reps, lapses, due, now, r["id"]))
