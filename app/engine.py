"""Pilotage de Stockfish (un moteur pour l'analyse de fond, un pour l'interactif)."""
import json
import subprocess
import threading

import chess
import chess.engine

from . import config, db

START_KEY = chess.Board().epd()


def key(board):
    """Clé normalisée d'une position (EPD : placement, trait, roques, prise en passant)."""
    return board.epd()


def board_from_key(fen_key):
    return chess.Board(fen_key + " 0 1")


class Engine:
    def __init__(self, threads):
        self.threads = threads
        self._engine = None
        self.lock = threading.Lock()

    def _get(self):
        if self._engine is None:
            cfg = config.load()
            # CREATE_NO_WINDOW : pas de fenêtre console pour Stockfish sous Windows
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            self._engine = chess.engine.SimpleEngine.popen_uci(config.stockfish_path(), creationflags=flags)
            self._engine.configure({"Threads": self.threads, "Hash": cfg["engine_hash_mb"]})
        return self._engine

    def analyse(self, board, depth, multipv=None, max_time=None):
        """multipv=None -> un dict ; multipv=N -> une liste de N dicts. max_time (s) : arrêt anticipé."""
        limit = chess.engine.Limit(depth=depth, time=max_time)
        with self.lock:
            try:
                return self._get().analyse(board, limit, multipv=multipv)
            except (chess.engine.EngineTerminatedError, chess.engine.EngineError):
                self._engine = None
                return self._get().analyse(board, limit, multipv=multipv)

    def close(self):
        with self.lock:
            if self._engine is not None:
                try:
                    self._engine.quit()
                except Exception:
                    pass
                self._engine = None


_batch = None
_live = None


def batch():
    global _batch
    if _batch is None:
        _batch = Engine(config.load()["engine_threads"])
    return _batch


def live():
    global _live
    if _live is None:
        _live = Engine(config.load()["live_threads"])
    return _live


def shutdown():
    for e in (_batch, _live):
        if e is not None:
            e.close()


def _score(info, board):
    s = info["score"].pov(board.turn)
    return s.score(), s.mate()


def eval_position(fen_key, depth, con=None):
    """Évaluation simple (multipv 1), mise en cache dans la table evals."""
    own = con is None
    con = con or db.connect()
    try:
        r = con.execute("SELECT * FROM evals WHERE fen=?", (fen_key,)).fetchone()
        if r and r["depth"] >= depth:
            return dict(r)
        board = board_from_key(fen_key)
        if board.is_game_over():
            res = {"fen": fen_key, "depth": 99, "cp": 0, "mate": None, "best": None, "pv": ""}
            if board.is_checkmate():
                res["cp"], res["mate"] = None, 0
        else:
            info = batch().analyse(board, depth, max_time=config.load().get("analysis_max_time"))
            cp, mate = _score(info, board)
            pv = info.get("pv", [])
            res = {"fen": fen_key, "depth": depth, "cp": cp, "mate": mate,
                   "best": pv[0].uci() if pv else None, "pv": " ".join(m.uci() for m in pv[:8])}
        con.execute("INSERT OR REPLACE INTO evals VALUES(:fen,:depth,:cp,:mate,:best,:pv)", res)
        con.commit()
        return res
    finally:
        if own:
            con.close()


def _cached_lines(con, fen_key, depth, multipv):
    r = con.execute("SELECT * FROM live_cache WHERE fen=?", (fen_key,)).fetchone()
    if r and r["depth"] >= depth:
        data = json.loads(r["data"])
        if len(data["lines"]) >= min(multipv, data.get("legal", multipv)):
            return data
    return None


def live_cached(fen_key, depth=None):
    """Lignes déjà calculées par live_lines (avec les réglages par défaut), sinon None."""
    cfg = config.load()
    con = db.connect()
    try:
        return _cached_lines(con, fen_key, depth or cfg["live_depth"], cfg["live_multipv"])
    finally:
        con.close()


def live_lines(fen_key, depth=None, multipv=None):
    """Top N coups (pour le répertoire). Renvoie [{uci, san, cp, mate, wp, pv_san}] du point de vue du trait."""
    cfg = config.load()
    depth = depth or cfg["live_depth"]
    multipv = multipv or cfg["live_multipv"]
    con = db.connect()
    try:
        data = _cached_lines(con, fen_key, depth, multipv)
        if data:
            return data
        board = board_from_key(fen_key)
        legal = board.legal_moves.count()
        if legal == 0:
            return {"depth": 0, "lines": [], "legal": 0}
        infos = live().analyse(board, depth, multipv=min(multipv, legal), max_time=cfg.get("live_max_time"))
        lines = []
        for info in infos:
            pv = info.get("pv", [])
            if not pv:
                continue
            cp, mate = _score(info, board)
            b = board.copy()
            sans = []
            for m in pv[:10]:
                sans.append(b.san(m))
                b.push(m)
            lines.append({"uci": pv[0].uci(), "san": sans[0], "cp": cp, "mate": mate,
                          "wp": round(db.winp(cp, mate), 1), "pv": sans})
        # Profondeur réellement atteinte (moindre si la limite de temps a coupé l'analyse). Le cache garde
        # la profondeur demandée : on ne relance pas une analyse qui serait de nouveau coupée.
        data = {"depth": infos[0].get("depth", depth) if infos else depth, "lines": lines, "legal": legal}
        con.execute("INSERT OR REPLACE INTO live_cache VALUES(?,?,?)", (fen_key, depth, json.dumps(data)))
        con.commit()
        return data
    finally:
        con.close()


def move_loss(fen_key, uci, depth=None):
    """Perte de % de gain d'un coup donné (analyse interactive)."""
    depth = depth or min(16, config.load()["live_depth"])
    board = board_from_key(fen_key)
    move = chess.Move.from_uci(uci)
    max_time = config.load().get("live_max_time")
    info = live().analyse(board, depth, max_time=max_time)
    cp, mate = _score(info, board)
    before = db.winp(cp, mate)
    board.push(move)
    if board.is_checkmate():
        return before, 100.0, 0.0
    if board.is_game_over():
        after = 50.0
    else:
        info = live().analyse(board, depth, max_time=max_time)
        cp, mate = _score(info, board)
        after = 100 - db.winp(cp, mate)
    return before, after, max(0.0, before - after)
