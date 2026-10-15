"""Explorateur d'ouvertures Lichess (statistiques des coups joués à un niveau donné)."""
import json
import time

import requests

from . import config, db

TTL = 14 * 86400


def query(fen_key):
    cfg = config.load()
    token = cfg.get("lichess_token", "").strip()
    if not token:
        return {"error": "no_token"}
    speeds = ",".join(cfg["explorer_speeds"])
    ratings = ",".join(str(r) for r in cfg["explorer_ratings"])
    ckey = f"{fen_key}|{speeds}|{ratings}"
    con = db.connect()
    try:
        r = con.execute("SELECT data, fetched_at FROM explorer_cache WHERE key=?", (ckey,)).fetchone()
        if r and time.time() - r["fetched_at"] < TTL:
            return json.loads(r["data"])
        try:
            resp = requests.get(
                "https://explorer.lichess.ovh/lichess",
                params={"variant": "standard", "fen": fen_key + " 0 1", "speeds": speeds,
                        "ratings": ratings, "moves": 15, "topGames": 0, "recentGames": 0},
                headers={"Authorization": f"Bearer {token}"}, timeout=20)
        except requests.RequestException as e:
            return {"error": "network", "detail": str(e)}
        if resp.status_code == 401:
            return {"error": "bad_token"}
        if resp.status_code == 429:
            return {"error": "rate_limit"}
        if not resp.ok:
            return {"error": "http", "detail": resp.status_code}
        raw = resp.json()
        total = raw.get("white", 0) + raw.get("draws", 0) + raw.get("black", 0)
        moves = []
        for m in raw.get("moves", []):
            n = m["white"] + m["draws"] + m["black"]
            moves.append({"uci": m["uci"], "san": m["san"], "games": n,
                          "freq": round(100 * n / total, 1) if total else 0,
                          "white": round(100 * m["white"] / n, 1) if n else 0,
                          "draws": round(100 * m["draws"] / n, 1) if n else 0,
                          "black": round(100 * m["black"] / n, 1) if n else 0})
        data = {"total": total, "moves": moves,
                "opening": (raw.get("opening") or {}).get("name")}
        con.execute("INSERT OR REPLACE INTO explorer_cache VALUES(?,?,?)",
                    (ckey, json.dumps(data), int(time.time())))
        con.commit()
        return data
    finally:
        con.close()
