"""Import des parties depuis l'API publique Chess.com."""
import datetime as dt
import io
import re
import time

import chess
import chess.pgn
import requests

from . import config, db, engine

UA = {"User-Agent": "EchecBase/1.0 (outil personnel d'analyse d'ouvertures)"}
DRAWS = {"agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"}


def opening_name(eco_url):
    if not eco_url:
        return ""
    seg = eco_url.rstrip("/").rsplit("/", 1)[-1]
    seg = re.split(r"\.\.\.|-\d+\.", seg)[0]
    return seg.replace("-", " ").strip()


def _months(n):
    today = dt.date.today()
    y, m = today.year, today.month
    out = set()
    for _ in range(n + 1):
        out.add(f"{y:04d}/{m:02d}")
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return out


def _score(side):
    r = side.get("result")
    if r == "win":
        return 1.0
    if r in DRAWS:
        return 0.5
    return 0.0


def import_chesscom(progress=None, stop=None):
    cfg = config.load()
    user = cfg["chesscom_username"].strip()
    if not user:
        return 0
    months = _months(int(cfg["import_months"]))
    tclasses = set(cfg["time_classes"])
    cutoff = time.time() - int(cfg["import_months"]) * 31 * 86400

    r = requests.get(f"https://api.chess.com/pub/player/{user.lower()}/games/archives", headers=UA, timeout=30)
    r.raise_for_status()
    archives = [a for a in r.json().get("archives", []) if a[-7:] in months]

    con = db.connect()
    known = {row[0] for row in con.execute("SELECT id FROM games")}
    added = 0
    try:
        for i, url in enumerate(archives):
            if stop is not None and stop.is_set():
                break
            if progress:
                progress(f"Import Chess.com {url[-7:]}", i, len(archives))
            resp = requests.get(url, headers=UA, timeout=60)
            resp.raise_for_status()
            for g in resp.json().get("games", []):
                gid = g.get("url") or g.get("uuid")
                if gid in known:
                    _store_cc_accuracy(con, gid, g, user)
                    continue
                if g.get("rules") != "chess" or g.get("time_class") not in tclasses:
                    continue
                if g.get("end_time", 0) < cutoff or not g.get("pgn"):
                    continue
                if g.get("initial_setup") and g["initial_setup"] != chess.STARTING_FEN:
                    continue
                if _store_game(con, gid, g, user):
                    _store_cc_accuracy(con, gid, g, user)
                    known.add(gid)
                    added += 1
            con.commit()
    finally:
        con.close()
    return added


def _store_cc_accuracy(con, gid, g, user):
    """Précision Chess.com (présente seulement si la partie a été analysée sur Chess.com)."""
    acc = g.get("accuracies")
    if not acc:
        return
    me = "white" if g["white"]["username"].lower() == user.lower() else "black"
    them = "black" if me == "white" else "white"
    con.execute("UPDATE games SET cc_acc_me=?, cc_acc_opp=? WHERE id=?", (acc.get(me), acc.get(them), gid))


def _store_game(con, gid, g, user):
    game = chess.pgn.read_game(io.StringIO(g["pgn"]))
    if game is None:
        return False
    w, b = g["white"], g["black"]
    my_color = "white" if w["username"].lower() == user.lower() else "black"
    me = w if my_color == "white" else b
    h = game.headers
    con.execute(
        "INSERT OR IGNORE INTO games(id,source,url,played_at,time_class,time_control,white,black,"
        "white_elo,black_elo,my_color,result,my_score,termination,eco,opening,pgn,analyzed,imported_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)",
        (gid, "chesscom", g.get("url"), g.get("end_time"), g.get("time_class"), g.get("time_control"),
         w["username"], b["username"], w.get("rating"), b.get("rating"), my_color,
         h.get("Result", "*"), _score(me), h.get("Termination", ""), h.get("ECO", ""),
         opening_name(g.get("eco") or h.get("ECOUrl")), g["pgn"], int(time.time())))
    board = game.board()
    rows = []
    for ply, move in enumerate(game.mainline_moves()):
        fen = engine.key(board)
        san = board.san(move)
        mover = "white" if board.turn == chess.WHITE else "black"
        board.push(move)
        rows.append((gid, ply, fen, engine.key(board), move.uci(), san, int(mover == my_color)))
    con.executemany(
        "INSERT OR IGNORE INTO moves(game_id,ply,fen,fen_after,uci,san,mine) VALUES(?,?,?,?,?,?,?)", rows)
    return True
