"""Bilan de partie façon Chess.com : analyse complète, classification des coups, précision,
et indices pour le coach (pièce laissée en prise, mat raté…)."""
import math
import threading
import traceback

import chess

from . import config, db, engine, repertoire

VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}
PIECE_FR = {chess.PAWN: "pion", chess.KNIGHT: "cavalier", chess.BISHOP: "fou", chess.ROOK: "tour",
            chess.QUEEN: "dame", chess.KING: "roi"}

# Coups « charnières » : ceux qui font basculer la partie
KEY_CLASSES = {"brilliant", "great", "blunder", "mistake", "miss"}

# ---------------------------------------------------------------------------
# Analyse complète (toute la partie, multipv 2 pour détecter les coups uniques)
# ---------------------------------------------------------------------------

_status = {}  # gid -> {"running", "done", "total", "error"}
_lock = threading.Lock()


def status(gid):
    g = db.one("SELECT reviewed FROM games WHERE id=?", (gid,))
    st = dict(_status.get(gid, {"running": False, "done": 0, "total": 0, "error": None}))
    st["reviewed"] = bool(g and g["reviewed"])
    return st


def start(gid):
    with _lock:
        st = _status.get(gid)
        if st and st["running"]:
            return status(gid)
        _status[gid] = {"running": True, "done": 0, "total": 0, "error": None}
    threading.Thread(target=_run, args=(gid,), daemon=True).start()
    return status(gid)


def _eval_mp(con, fen_key, depth):
    """Évalue une position en multipv 2. Met à jour evals (meilleur coup) et renvoie (wp1, wp2|None, best)."""
    board = engine.board_from_key(fen_key)
    if board.is_game_over():
        ev = engine.eval_position(fen_key, depth, con)
        return db.winp(ev["cp"], ev["mate"]), None, None
    infos = engine.batch().analyse(board, depth, multipv=min(2, board.legal_moves.count()),
                                   max_time=config.load().get("analysis_max_time"))
    lines = []
    for info in infos:
        s = info["score"].pov(board.turn)
        pv = info.get("pv", [])
        lines.append((s.score(), s.mate(), pv))
    cp, mate, pv = lines[0]
    old = con.execute("SELECT depth FROM evals WHERE fen=?", (fen_key,)).fetchone()
    if not old or old["depth"] <= depth:
        con.execute("INSERT OR REPLACE INTO evals VALUES(?,?,?,?,?,?)",
                    (fen_key, depth, cp, mate, pv[0].uci() if pv else None, " ".join(m.uci() for m in pv[:8])))
        con.commit()
    wp2 = db.winp(lines[1][0], lines[1][1]) if len(lines) > 1 else None
    return db.winp(cp, mate), wp2, (pv[0].uci() if pv else None)


def review_game(con, gid, st, stop=None):
    """Analyse complète d'une partie (st reçoit la progression). Renvoie False si interrompue."""
    depth = int(config.load()["analysis_depth"])
    moves = con.execute("SELECT ply, fen, fen_after, uci FROM moves WHERE game_id=? ORDER BY ply",
                        (gid,)).fetchall()
    st["total"] = len(moves)
    cache = {}
    for i, m in enumerate(moves):
        if stop is not None and stop.is_set():
            return False
        if m["fen"] not in cache:
            cache[m["fen"]] = _eval_mp(con, m["fen"], depth)
        if m["fen_after"] not in cache:
            cache[m["fen_after"]] = _eval_mp(con, m["fen_after"], depth)
        wp1, wp2, best = cache[m["fen"]]
        after_board = engine.board_from_key(m["fen_after"])
        after = 100.0 if after_board.is_checkmate() else 100.0 - cache[m["fen_after"]][0]
        loss = 0.0 if m["uci"] == best else max(0.0, wp1 - after)
        best_san = engine.board_from_key(m["fen"]).san(chess.Move.from_uci(best)) if best else None
        gap = round(wp1 - wp2, 2) if wp2 is not None else None
        con.execute("UPDATE moves SET wp_before=?, wp_after=?, loss=?, best_uci=?, best_san=?, gap=? "
                    "WHERE game_id=? AND ply=?",
                    (round(wp1, 2), round(after, 2), round(loss, 2), best, best_san, gap, gid, m["ply"]))
        con.commit()
        st["done"] = i + 1
    con.execute("UPDATE games SET reviewed=1, analyzed=1 WHERE id=?", (gid,))
    con.commit()
    persist(con, gid)
    return True


def persist(con, gid):
    """Enregistre la classe de chaque coup et le bilan de la partie (précision, brillants, gaffes)."""
    g = dict(con.execute("SELECT * FROM games WHERE id=?", (gid,)).fetchone())
    moves = [dict(r) for r in con.execute("SELECT * FROM moves WHERE game_id=? ORDER BY ply", (gid,))]
    summary = annotate(g, moves, con)
    con.executemany("UPDATE moves SET rc=? WHERE game_id=? AND ply=?", [(m["rc"], gid, m["ply"]) for m in moves])
    me = g["my_color"]
    them = "black" if me == "white" else "white"
    con.execute("UPDATE games SET acc_me=?, acc_opp=?, n_brilliant=?, n_great=?, n_blunder=? WHERE id=?",
                (summary[me]["accuracy"], summary[them]["accuracy"], summary[me]["counts"].get("brilliant", 0),
                 summary[me]["counts"].get("great", 0), summary[me]["counts"].get("blunder", 0), gid))
    con.commit()


def busy(gid):
    st = _status.get(gid)
    return bool(st and st["running"])


def _run(gid):
    st = _status[gid]
    con = db.connect()
    try:
        review_game(con, gid, st)
    except Exception as e:
        traceback.print_exc()
        st["error"] = str(e)
    finally:
        st["running"] = False
        con.close()


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

# Réglages de la détection des coups brillants
SAC_MIN_DEFICIT = 2      # perte de matériel minimale (en pions) pour parler de sacrifice
SAC_HORIZON = 4          # le matériel doit tomber dans les 2 premières réponses adverses (sinon le
                         # sacrifice appartient à un coup ultérieur de la variante)
SHALLOW_DEPTH = 6        # si Stockfish trouve déjà le coup à cette profondeur, il est « facile »
BRILLIANT_MAX_BEFORE = 90  # au-delà, la partie était déjà gagnée : pas de brillant
BRILLIANT_MIN_AFTER = 45   # après le coup, la position ne doit pas être mauvaise


def _material(board, color):
    return sum(VALUES[p.piece_type] for p in board.piece_map().values() if p.color == color)


def _pv_sacrifice(board, move, pv_after):
    """Vrai sacrifice : en suivant la meilleure suite de Stockfish après le coup, on se retrouve
    avec au moins SAC_MIN_DEFICIT pions de matériel en moins, et pas seulement le temps d'une reprise.
    Couvre aussi les pièces laissées en prise ailleurs que sur la case jouée (découverte, clouage levé…)."""
    me = board.turn
    start = _material(board, me) - _material(board, not me)
    b = board.copy()
    balances = []
    for uci in [move.uci()] + pv_after:
        mv = chess.Move.from_uci(uci)
        if mv not in b.legal_moves:
            break
        b.push(mv)
        balances.append(_material(b, me) - _material(b, not me) - start)
    # balances[k] après le demi-coup k (0 = notre coup, 1 = réponse adverse, 2 = notre coup suivant…)
    for k in range(1, min(len(balances), SAC_HORIZON), 2):
        if balances[k] <= -SAC_MIN_DEFICIT:
            # Le déficit doit survivre à notre coup suivant (sinon c'est un simple échange)
            if k + 1 >= len(balances) or balances[k + 1] <= -SAC_MIN_DEFICIT:
                return True
    return False


def _hard_to_find(con, fen_key, uci):
    """Le coup n'est-il PAS déjà le premier choix de Stockfish à faible profondeur ? (mis en cache)"""
    r = con.execute("SELECT best FROM shallow_cache WHERE fen=? AND depth=?", (fen_key, SHALLOW_DEPTH)).fetchone()
    if r is None:
        info = engine.live().analyse(engine.board_from_key(fen_key), SHALLOW_DEPTH,
                                    max_time=config.load().get("analysis_max_time"))
        pv = info.get("pv", [])
        best = pv[0].uci() if pv else None
        con.execute("INSERT OR REPLACE INTO shallow_cache VALUES(?,?,?)", (fen_key, SHALLOW_DEPTH, best))
        con.commit()
    else:
        best = r["best"]
    return best != uci


def _free_capture(board, uci):
    """Si le coup uci prend une pièce (≥ cavalier) sans contrepartie évidente : (nom, case)."""
    if not uci:
        return None
    mv = chess.Move.from_uci(uci)
    if not board.is_capture(mv) or board.is_en_passant(mv):
        return None
    victim = board.piece_at(mv.to_square)
    attacker = board.piece_at(mv.from_square)
    if not victim or VALUES[victim.piece_type] < 3:
        return None
    defended = bool(board.attackers(victim.color, mv.to_square))
    if defended and VALUES[attacker.piece_type] >= VALUES[victim.piece_type]:
        return None
    return PIECE_FR[victim.piece_type], chess.square_name(mv.to_square)


def accuracy(loss):
    """Précision d'un coup (formule Lichess) à partir de la perte de % de gain."""
    return max(0.0, min(100.0, 103.1668 * math.exp(-0.04354 * loss) - 3.1669))


# Calibrage sur la précision Chess.com : régression linéaire sur 22 bilans de tes parties
# (moyenne des précisions par coup → précision Chess.com), écart moyen ~3,7 points en validation croisée.
CC_SLOPE, CC_OFFSET = 1.943, -94.7


def game_accuracy(move_accuracies):
    if not move_accuracies:
        return None
    mean = sum(move_accuracies) / len(move_accuracies)
    return round(max(0.0, min(100.0, CC_SLOPE * mean + CC_OFFSET)), 1)


def annotate(game, moves, con):
    """Ajoute à chaque coup : rc (classe façon Chess.com), key (charnière), hint (indices pour le coach)
    et calcule la précision des deux camps."""
    t = config.load()["thresholds"]
    rep = repertoire.graph(game["my_color"], con)
    evals = {}
    keys = {m["fen"] for m in moves} | {m["fen_after"] for m in moves}
    for i in range(0, len(keys), 500):
        chunk = list(keys)[i:i + 500]
        for r in con.execute(f"SELECT * FROM evals WHERE fen IN ({','.join('?' * len(chunk))})", chunk):
            evals[r["fen"]] = dict(r)

    in_book = True
    acc = {"white": [], "black": []}
    counts = {"white": {}, "black": {}}
    prev = None
    for m in moves:
        side = "white" if m["ply"] % 2 == 0 else "black"
        m["side"] = side
        hint = {}
        board = engine.board_from_key(m["fen"])
        move = chess.Move.from_uci(m["uci"])
        if m["loss"] is None:
            m["rc"], m["key"], m["hint"] = None, False, {}
            prev = m
            continue
        loss = m["loss"]
        best = m["uci"] == m["best_uci"] or loss < 1
        ev_before = evals.get(m["fen"]) or {}
        ev_after = evals.get(m["fen_after"]) or {}

        # Indices pour le coach
        if ev_before.get("mate") and ev_before["mate"] > 0 and not best:
            hint["missed_mate"] = ev_before["mate"]
        if ev_after.get("mate") and ev_after["mate"] > 0:
            hint["allowed_mate"] = ev_after["mate"]
        if ev_after.get("mate") and ev_after["mate"] < 0:
            hint["mate_in"] = -ev_after["mate"]  # après ce coup, son auteur a un mat forcé
        # Reprise immédiate, coup forcé, parade d'échec : jamais « difficiles à trouver »
        recapture = (prev is not None and board.is_capture(move)
                     and move.to_square == chess.parse_square(prev["uci"][2:4]))
        if recapture:
            hint["recap"] = True
        if board.legal_moves.count() == 1:
            hint["forced"] = True
        if not best:
            fc = _free_capture(board, m["best_uci"])
            if fc:
                hint["missed_capture"] = {"piece": fc[0], "sq": fc[1]}
            after_board = engine.board_from_key(m["fen_after"])
            reply = ev_after.get("best")
            fc2 = _free_capture(after_board, reply) if reply else None
            if fc2:
                hint["hung"] = {"piece": fc2[0], "sq": fc2[1], "reply": after_board.san(chess.Move.from_uci(reply))}
        moved = board.piece_at(move.from_square)
        hint["piece"] = PIECE_FR[moved.piece_type] if moved else ""

        # Théorie : coups du répertoire tant qu'on y est
        book = False
        if in_book:
            if any(e["uci"] == m["uci"] for e in rep.get(m["fen"], [])):
                book = True
            else:
                in_book = False

        prev_err = prev is not None and prev["loss"] is not None and prev["loss"] >= t["mistake"]
        if loss >= t["blunder"]:
            rc = "blunder"
        elif prev_err and loss >= t["inaccuracy"] and m["wp_before"] >= 60:
            rc = "miss"  # l'adversaire venait de se tromper et on ne l'a pas puni
        elif loss >= t["mistake"]:
            rc = "mistake"
        elif loss >= t["inaccuracy"]:
            rc = "inaccuracy"
        elif book:
            rc = "book"
        elif (best and m["wp_before"] < BRILLIANT_MAX_BEFORE and m["wp_after"] >= BRILLIANT_MIN_AFTER
              and board.legal_moves.count() > 2
              and _pv_sacrifice(board, move, (ev_after.get("pv") or "").split())
              and _hard_to_find(con, m["fen"], m["uci"])):
            rc = "brilliant"
        elif best and m["gap"] is not None and m["gap"] >= 15 and m["wp_before"] < 90 and not recapture:
            rc = "great"  # seul bon coup (et pas une simple reprise)
        elif m["uci"] == m["best_uci"]:
            rc = "best"
        elif loss < 2:
            rc = "excellent"
        else:
            rc = "good"

        # Évidence de l'erreur (0 = subtile … 3 = énorme), pour doser le coach
        if rc in ("blunder", "mistake", "miss", "inaccuracy"):
            lvl = {"inaccuracy": 0, "mistake": 1, "miss": 1, "blunder": 2}[rc]
            if hint.get("allowed_mate", 99) <= 3 or hint.get("missed_mate", 99) <= 3:
                lvl = max(lvl, 2)
            if (hint.get("allowed_mate") == 1 or hint.get("missed_mate") == 1
                    or (rc == "blunder" and (hint.get("hung") or hint.get("missed_capture")))):
                lvl = 3
            hint["level"] = lvl
        # Coup « difficile » : seul bon coup, mais pas une évidence (reprise, parade d'échec, prise
        # d'une pièce au moins aussi forte que celle qui prend…)
        victim = board.piece_at(move.to_square)
        natural_take = victim is not None and moved is not None and VALUES[victim.piece_type] >= VALUES[moved.piece_type]
        if rc in ("brilliant", "great") or (rc == "best" and m["gap"] is not None and m["gap"] >= 8
                                             and not recapture and not natural_take and not board.is_check()
                                             and not board.is_castling(move)
                                             and board.legal_moves.count() > 2):
            hint["hard"] = True

        m["rc"], m["key"], m["hint"] = rc, rc in KEY_CLASSES, hint
        acc[side].append(accuracy(loss))
        counts[side][rc] = counts[side].get(rc, 0) + 1
        prev = m

    summary = {}
    for side in ("white", "black"):
        a = acc[side]
        summary[side] = {"accuracy": game_accuracy(a), "counts": counts[side]}
    return summary
