"""Répertoire d'ouvertures : un graphe de coups par couleur (les transpositions sont gérées par la clé de position)."""
import time
from collections import defaultdict, deque

import chess

from . import db, engine


def edges(color, con=None):
    own = con is None
    con = con or db.connect()
    try:
        return [dict(r) for r in con.execute(
            "SELECT fen, uci, san, fen_after, added_at FROM repertoire WHERE color=? ORDER BY added_at", (color,))]
    finally:
        if own:
            con.close()


def graph(color, con=None):
    g = defaultdict(list)
    for e in edges(color, con):
        g[e["fen"]].append(e)
    return g


def is_my_turn(fen_key, color):
    return (fen_key.split(" ")[1] == "w") == (color == "white")


def add_line(color, ucis, replace=False, dry_run=False):
    """Ajoute une ligne depuis la position initiale. Si un autre coup est déjà prévu pour nous
    dans une position de la ligne, renvoie le conflit (sauf replace=True). dry_run : vérifie sans écrire."""
    con = db.connect()
    try:
        g = graph(color, con)
        board = chess.Board()
        plan = []
        for i, uci in enumerate(ucis):
            move = chess.Move.from_uci(uci)
            if move not in board.legal_moves:
                return {"ok": False, "error": f"Coup illégal : {uci}"}
            fen = engine.key(board)
            san = board.san(move)
            existing = [e for e in g.get(fen, []) if e["uci"] != uci]
            if existing and board.turn == (color == "white") and not replace:
                return {"ok": False, "conflict": True, "ply": i, "fen": fen,
                        "existing": existing[0]["san"], "new": san}
            board.push(move)
            plan.append((fen, uci, san, engine.key(board), bool(existing) and is_my_turn(fen, color)))
        if dry_run:
            return {"ok": True}
        now = int(time.time() * 1000)
        for n, (fen, uci, san, fen_after, conflict) in enumerate(plan):
            if conflict:
                con.execute("DELETE FROM repertoire WHERE color=? AND fen=? AND uci<>?", (color, fen, uci))
            con.execute("INSERT OR IGNORE INTO repertoire VALUES(?,?,?,?,?,?)",
                        (color, fen, uci, san, fen_after, now + n))
        _prune(con, color)
        con.commit()
        return {"ok": True}
    finally:
        con.close()


def delete_move(color, fen, uci):
    con = db.connect()
    try:
        con.execute("DELETE FROM repertoire WHERE color=? AND fen=? AND uci=?", (color, fen, uci))
        _prune(con, color)
        con.commit()
    finally:
        con.close()


def _prune(con, color):
    """Supprime les coups devenus inaccessibles depuis la position initiale."""
    g = graph(color, con)
    seen = {engine.START_KEY}
    q = deque([engine.START_KEY])
    while q:
        f = q.popleft()
        for e in g.get(f, []):
            if e["fen_after"] not in seen:
                seen.add(e["fen_after"])
                q.append(e["fen_after"])
    dead = [f for f in g if f not in seen]
    con.executemany("DELETE FROM repertoire WHERE color=? AND fen=?", [(color, f) for f in dead])


def paths(color, con=None):
    """Chemin le plus court (liste de SAN / UCI) vers chaque position du répertoire."""
    g = graph(color, con)
    out = {engine.START_KEY: ([], [])}
    q = deque([engine.START_KEY])
    while q:
        f = q.popleft()
        for e in g.get(f, []):
            if e["fen_after"] not in out:
                sans, ucis = out[f]
                out[e["fen_after"]] = (sans + [e["san"]], ucis + [e["uci"]])
                q.append(e["fen_after"])
    return g, out


def summary(color):
    g = graph(color)
    n_edges = sum(len(v) for v in g.values())
    my_pos = sum(1 for f in g if is_my_turn(f, color))
    leaves = {e["fen_after"] for v in g.values() for e in v} - set(g.keys())
    return {"moves": n_edges, "my_positions": my_pos, "lines": len(leaves)}


# Un écart de ma part avant ce demi-coup = autre ouverture (2 premiers coups de chaque camp).
OTHER_OPENING_PLIES = 4


def compare_game(moves, my_color, g):
    """Compare une partie (liste de coups ordonnés) au répertoire.
    Renvoie le premier événement : deviation (je sors), uncovered (l'adversaire joue un coup non prévu),
    end (fin de la préparation), other (je joue une autre ouverture dès mes 2 premiers coups)
    ou None (pas de répertoire)."""
    if not g:
        return None
    for m in moves:
        prepared = g.get(m["fen"])
        if not prepared:
            return {"type": "end", "ply": m["ply"], "fen": m["fen"]} if m["ply"] > 0 else None
        if any(e["uci"] == m["uci"] for e in prepared):
            continue
        mine = is_my_turn(m["fen"], my_color)
        if mine and m["ply"] < OTHER_OPENING_PLIES:
            # Je sors dès mes 2 premiers coups : c'est une autre ouverture, pas un écart.
            return {"type": "other", "ply": m["ply"], "fen": m["fen"], "uci": m["uci"], "san": m["san"]}
        return {"type": "deviation" if mine else "uncovered", "ply": m["ply"], "fen": m["fen"],
                "uci": m["uci"], "san": m["san"], "expected": [e["san"] for e in prepared],
                "expected_uci": [e["uci"] for e in prepared]}
    return {"type": "end", "ply": moves[-1]["ply"] + 1 if moves else 0, "fen": None}
