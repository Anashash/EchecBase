"""Statistiques : positions problématiques, ouvertures, arbre de mes parties, écarts au répertoire."""
import io
import re
from collections import defaultdict

import chess
import chess.pgn

from . import config, db, engine, repertoire, review


def _thr():
    return config.load()["thresholds"]


def _plies():
    return int(config.load()["analysis_plies"])


def classify(loss):
    if loss is None:
        return None
    t = _thr()
    if loss >= t["blunder"]:
        return "blunder"
    if loss >= t["mistake"]:
        return "mistake"
    if loss >= t["inaccuracy"]:
        return "inaccuracy"
    return None


def _color_filter(color, alias="g"):
    if color in ("white", "black"):
        return f" AND {alias}.my_color='{color}'"
    return ""


def overview():
    con = db.connect()
    try:
        t = _thr()
        g = con.execute(
            "SELECT COUNT(*) n, SUM(analyzed) analyzed, MIN(played_at) first, MAX(played_at) last FROM games").fetchone()
        by_color = {r["my_color"]: dict(r) for r in con.execute(
            "SELECT my_color, COUNT(*) n, SUM(analyzed) analyzed, AVG(my_score) score, "
            "SUM(my_score=1) wins, SUM(my_score=0.5) draws, SUM(my_score=0) losses "
            "FROM games GROUP BY my_color")}
        err = con.execute(
            "SELECT g.my_color, COUNT(*) moves, SUM(m.loss>=?) inacc, SUM(m.loss>=?) mistakes, SUM(m.loss>=?) blunders "
            "FROM moves m JOIN games g ON g.id=m.game_id WHERE m.mine=1 AND m.loss IS NOT NULL AND m.ply<? "
            "GROUP BY g.my_color",
            (t["inaccuracy"], t["mistake"], t["blunder"], _plies())).fetchall()
        for r in err:
            by_color.setdefault(r["my_color"], {}).update(dict(r))
        rv = con.execute("SELECT SUM(reviewed) reviewed, SUM(n_brilliant) brilliant, SUM(n_great) great, "
                         "AVG(acc_me) acc FROM games").fetchone()
        # Analyse complète : avancement sur la période choisie (review_months)
        win = con.execute("SELECT COUNT(*) n, SUM(reviewed) reviewed FROM games WHERE played_at>=?",
                          (config.review_cutoff(),)).fetchone()
        return {"games": g["n"] or 0, "analyzed": g["analyzed"] or 0, "first": g["first"], "last": g["last"],
                "by_color": by_color, "reviewed": rv["reviewed"] or 0, "brilliant": rv["brilliant"] or 0,
                "great": rv["great"] or 0, "accuracy": rv["acc"],
                "plies": _plies(), "review_months": int(config.load().get("review_months") or 0),
                "review_total": win["n"] or 0, "review_done": win["reviewed"] or 0}
    finally:
        con.close()


def _example_line(con, gid, ply):
    return [r["san"] for r in con.execute(
        "SELECT san FROM moves WHERE game_id=? AND ply<? ORDER BY ply", (gid, ply))]


def problems(color=None, min_errors=1, limit=40, min_seen=1):
    """Positions où je me trompe, les plus fréquentes d'abord : nombre de fautes (imprécision ou pire),
    puis perte cumulée. min_errors : fautes minimum, min_seen : nombre de fois rencontrée minimum."""
    t = _thr()
    con = db.connect()
    try:
        q = ("SELECT m.fen, COUNT(*) n, SUM(m.loss>=:mi) errors, SUM(m.loss>=:ina) faults, "
             "SUM(CASE WHEN m.loss>=:ina THEN m.loss ELSE 0 END) cost, AVG(m.loss) avg_loss, "
             "AVG(g.my_score) score, MIN(m.ply) ply, MAX(g.my_color) color "
             "FROM moves m JOIN games g ON g.id=m.game_id "
             "WHERE m.mine=1 AND m.loss IS NOT NULL AND m.ply<:plies" + _color_filter(color) +
             " GROUP BY m.fen HAVING faults >= :me AND n >= :seen ORDER BY faults DESC, cost DESC LIMIT :lim")
        out = []
        for r in con.execute(q, {"mi": t["mistake"], "ina": t["inaccuracy"], "me": max(1, min_errors), "seen": min_seen,
                                 "lim": limit, "plies": _plies()}):
            item = dict(r)
            played = [dict(x) for x in con.execute(
                "SELECT m.uci, m.san, COUNT(*) n, AVG(m.loss) avg_loss, AVG(g.my_score) score "
                "FROM moves m JOIN games g ON g.id=m.game_id WHERE m.fen=? AND m.mine=1" + _color_filter(color) +
                " GROUP BY m.uci ORDER BY n DESC", (r["fen"],))]
            for p in played:
                p["cls"] = classify(p["avg_loss"])
            ev = con.execute("SELECT * FROM evals WHERE fen=?", (r["fen"],)).fetchone()
            item["played"] = played
            if ev and ev["best"]:
                b = engine.board_from_key(r["fen"])
                item["best_uci"] = ev["best"]
                item["best_san"] = b.san(chess.Move.from_uci(ev["best"]))
                item["wp"] = round(db.winp(ev["cp"], ev["mate"]), 1)
            ex = con.execute(
                "SELECT m.game_id, m.ply FROM moves m JOIN games g ON g.id=m.game_id "
                "WHERE m.fen=? AND m.mine=1" + _color_filter(color) + " ORDER BY g.played_at DESC LIMIT 1",
                (r["fen"],)).fetchone()
            item["line"] = _example_line(con, ex["game_id"], ex["ply"])
            item["games"] = [x[0] for x in con.execute(
                "SELECT DISTINCT game_id FROM moves WHERE fen=? AND mine=1", (r["fen"],))]
            out.append(item)
        return out
    finally:
        con.close()


def openings(color=None):
    t = _thr()
    plies = _plies()
    con = db.connect()
    try:
        q = ("SELECT g.my_color color, g.opening, COUNT(DISTINCT g.id) games, SUM(g.analyzed) analyzed, AVG(g.my_score) score "
             "FROM games g WHERE 1=1" + _color_filter(color) + " GROUP BY g.my_color, g.opening")
        res = {(r["color"], r["opening"]): dict(r) for r in con.execute(q)}
        q2 = ("SELECT g.my_color color, g.opening, SUM(m.loss>=?) errors, AVG(m.loss) avg_loss "
              "FROM moves m JOIN games g ON g.id=m.game_id WHERE m.mine=1 AND m.ply<? AND m.loss IS NOT NULL" +
              _color_filter(color) + " GROUP BY g.my_color, g.opening")
        for r in con.execute(q2, (t["mistake"], plies)):
            k = (r["color"], r["opening"])
            if k in res:
                res[k]["errors"] = r["errors"]
                res[k]["avg_loss"] = r["avg_loss"]
        out = sorted(res.values(), key=lambda x: -x["games"])
        for o in out:
            o["errors_per_game"] = round((o.get("errors") or 0) / o["analyzed"], 2) if o["analyzed"] else None
        return out
    finally:
        con.close()


def my_tree(fen_key, color=None):
    """Coups joués dans mes parties depuis une position."""
    con = db.connect()
    try:
        q = ("SELECT m.uci, m.san, m.mine, COUNT(*) n, AVG(g.my_score) score, AVG(m.loss) avg_loss "
             "FROM moves m JOIN games g ON g.id=m.game_id WHERE m.fen=?" + _color_filter(color) +
             " GROUP BY m.uci, m.mine ORDER BY n DESC")
        out = [dict(r) for r in con.execute(q, (fen_key,))]
        for o in out:
            o["cls"] = classify(o["avg_loss"]) if o["mine"] else None
        return out
    finally:
        con.close()


def games_list(color=None, limit=500):
    t = _thr()
    plies = _plies()
    con = db.connect()
    try:
        q = ("SELECT g.id, g.url, g.played_at, g.time_class, g.time_control, g.white, g.black, g.white_elo, "
             "g.black_elo, g.my_color, g.result, g.my_score, g.opening, g.eco, g.analyzed, g.termination, "
             "g.reviewed, g.acc_me, g.acc_opp, g.cc_acc_me, g.n_brilliant, g.n_great, g.n_blunder, "
             "(SELECT SUM(m.loss>=?) FROM moves m WHERE m.game_id=g.id AND m.mine=1 AND m.ply<?) errors, "
             "(SELECT SUM(m.loss>=?) FROM moves m WHERE m.game_id=g.id AND m.mine=1 AND m.ply<?) blunders "
             "FROM games g WHERE 1=1" + _color_filter(color) + " ORDER BY g.played_at DESC LIMIT ?")
        games = [dict(r) for r in con.execute(q, (t["mistake"], plies, t["blunder"], plies, limit))]
        graphs = {c: repertoire.graph(c, con) for c in ("white", "black")}
        moves_by_game = defaultdict(list)
        ids = [g["id"] for g in games]
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            for m in con.execute(
                    f"SELECT game_id, ply, fen, uci, san FROM moves WHERE game_id IN ({','.join('?' * len(chunk))}) "
                    "AND ply<60 ORDER BY game_id, ply", chunk):
                moves_by_game[m["game_id"]].append(dict(m))
        for g in games:
            g["rep"] = repertoire.compare_game(moves_by_game[g["id"]], g["my_color"], graphs[g["my_color"]])
        return games
    finally:
        con.close()


def game_detail(gid):
    con = db.connect()
    try:
        g = con.execute("SELECT * FROM games WHERE id=?", (gid,)).fetchone()
        if not g:
            return None
        g = dict(g)
        pgn = g.pop("pgn", None)
        moves = [dict(r) for r in con.execute("SELECT * FROM moves WHERE game_id=? ORDER BY ply", (gid,))]
        for m in moves:
            m["cls"] = classify(m["loss"])
        _add_clocks(g, moves, pgn)
        g["end_reason"] = end_reason(g["termination"])
        g["moves"] = moves
        rep_graph = repertoire.graph(g["my_color"], con)
        g["rep"] = repertoire.compare_game(moves, g["my_color"], rep_graph)
        if g["rep"]:
            # Partie jouée avant que la prépa concernée n'existe ? (le coach ne gronde pas pour ça)
            prepared = rep_graph.get(g["rep"]["fen"]) if g["rep"]["type"] in ("deviation", "other") else None
            stamps = [e["added_at"] for e in (prepared or [x for v in rep_graph.values() for x in v])]
            g["rep"]["before"] = bool(stamps) and g["played_at"] * 1000 < min(stamps)
        # Longueur de la ligne de répertoire la plus longue (en demi-coups), pour situer la prépa de la partie
        _, rep_paths = repertoire.paths(g["my_color"], con)
        g["rep_depth_max"] = max((len(p[0]) for p in rep_paths.values()), default=0)
        # Nombre de demi-coups de théorie suivis dans mes autres parties de la même couleur
        g["rep_book_lens"] = [r["n"] for r in con.execute(
            "SELECT COUNT(*) n FROM moves m JOIN games x ON x.id=m.game_id "
            "WHERE x.my_color=? AND x.reviewed=1 AND m.rc='book' GROUP BY m.game_id", (g["my_color"],))]
        g["summary"] = review.annotate(g, moves, con)
        return g
    finally:
        con.close()


def _time_control(tc):
    """« 180+2 » -> (180, 2). None pour les parties par correspondance (« 1/86400 »)."""
    m = re.fullmatch(r"(\d+)(?:\+(\d+))?", tc or "")
    return (int(m[1]), int(m[2] or 0)) if m else None


def _add_clocks(g, moves, pgn):
    """Temps restant après chaque coup (m["clock"], en s) et temps passé dessus (m["spent"]),
    lus dans les commentaires [%clk] du PGN Chess.com."""
    tc = _time_control(g.get("time_control"))
    g["base_time"], g["increment"] = tc if tc else (None, 0)
    if not pgn or not tc:
        return
    game = chess.pgn.read_game(io.StringIO(pgn))
    last = {0: tc[0], 1: tc[0]}  # dernier temps connu par camp (0 = Blancs)
    for i, node in enumerate(game.mainline() if game else []):
        if i >= len(moves):
            break
        clk = node.clock()
        if clk is None:
            continue
        side = i % 2
        moves[i]["clock"] = round(clk, 1)
        moves[i]["spent"] = round(max(0.0, last[side] + (tc[1] if i >= 2 else 0) - clk), 1)
        last[side] = clk


def end_reason(termination):
    """Motif de fin à partir de l'en-tête Termination de Chess.com."""
    t = (termination or "").lower()
    for key, reason in (("checkmate", "mate"), ("resignation", "resign"), ("timeout vs insufficient", "draw_time"),
                        ("on time", "time"), ("abandon", "abandon"), ("repetition", "draw_repetition"),
                        ("stalemate", "draw_stalemate"), ("agreement", "draw_agreed"),
                        ("insufficient", "draw_insufficient"), ("50", "draw_50")):
        if key in t:
            return reason
    return "draw_other" if "drawn" in t else "other"


def deviations(color=None, kind=None):
    """Agrège les sorties de répertoire : mes écarts (deviation) et les coups adverses non prévus (uncovered),
    triés par nombre d'occurrences. Les parties jouées dans une autre ouverture sont ignorées."""
    games = games_list(color, limit=100000)
    agg = {}
    covered = other = in_rep = 0
    counts = {"deviation": 0, "uncovered": 0}
    for g in games:
        r = g["rep"]
        if not r:
            continue
        if r["type"] == "other":
            other += 1
            continue
        in_rep += 1
        if r["type"] == "end":
            covered += 1
            continue
        counts[r["type"]] += 1
        if kind and r["type"] != kind:
            continue
        k = (g["my_color"], r["type"], r["fen"], r["uci"])
        a = agg.setdefault(k, {"color": g["my_color"], "type": r["type"], "fen": r["fen"], "uci": r["uci"],
                               "san": r["san"], "expected": r["expected"], "expected_uci": r["expected_uci"],
                               "ply": r["ply"], "n": 0, "score_sum": 0, "games": []})
        a["n"] += 1
        a["score_sum"] += g["my_score"]
        a["games"].append(g["id"])
    con = db.connect()
    try:
        items = sorted(agg.values(), key=lambda x: -x["n"])
        for a in items:
            a["score"] = a.pop("score_sum") / a["n"]
            a["line"] = _example_line(con, a["games"][0], a["ply"])
        return {"items": items, "followed": covered, "total": in_rep, "other": other, "counts": counts}
    finally:
        con.close()


def special_moves(rc="brilliant"):
    """Mes coups d'une catégorie donnée (brilliant, great…) dans toutes les parties analysées en entier."""
    con = db.connect()
    try:
        out = []
        for r in con.execute(
                "SELECT m.game_id, m.ply, m.fen, m.uci, m.san, m.loss, g.played_at, g.my_color, g.white, g.black, "
                "g.white_elo, g.black_elo, g.my_score, g.opening, g.time_class FROM moves m JOIN games g ON g.id=m.game_id "
                "WHERE m.mine=1 AND m.rc=? ORDER BY g.played_at DESC, m.ply", (rc,)):
            item = dict(r)
            item["line"] = _example_line(con, r["game_id"], r["ply"])
            out.append(item)
        return out
    finally:
        con.close()
