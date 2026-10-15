"""Base SQLite."""
import math
import os
import sqlite3

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS games(
    id TEXT PRIMARY KEY,
    source TEXT, url TEXT, played_at INTEGER,
    time_class TEXT, time_control TEXT,
    white TEXT, black TEXT, white_elo INTEGER, black_elo INTEGER,
    my_color TEXT, result TEXT, my_score REAL, termination TEXT,
    eco TEXT, opening TEXT, pgn TEXT,
    analyzed INTEGER DEFAULT 0, imported_at INTEGER
);
CREATE INDEX IF NOT EXISTS games_played ON games(played_at);

-- Un demi-coup d'une partie. fen = position AVANT le coup (clé EPD normalisée).
-- wp_before / wp_after = % de gain du joueur qui joue le coup, avant et après.
CREATE TABLE IF NOT EXISTS moves(
    game_id TEXT, ply INTEGER, fen TEXT, fen_after TEXT,
    uci TEXT, san TEXT, mine INTEGER,
    wp_before REAL, wp_after REAL, loss REAL, best_uci TEXT, best_san TEXT,
    PRIMARY KEY(game_id, ply)
);
CREATE INDEX IF NOT EXISTS moves_fen ON moves(fen);

-- Évaluation d'une position, du point de vue du camp au trait.
CREATE TABLE IF NOT EXISTS evals(
    fen TEXT PRIMARY KEY, depth INTEGER, cp INTEGER, mate INTEGER, best TEXT, pv TEXT
);

CREATE TABLE IF NOT EXISTS live_cache(
    fen TEXT PRIMARY KEY, depth INTEGER, data TEXT
);

CREATE TABLE IF NOT EXISTS repertoire(
    color TEXT, fen TEXT, uci TEXT, san TEXT, fen_after TEXT, added_at INTEGER,
    PRIMARY KEY(color, fen, uci)
);

CREATE TABLE IF NOT EXISTS training(
    id TEXT PRIMARY KEY, kind TEXT, color TEXT, fen TEXT,
    answers TEXT, line TEXT, info TEXT,
    ease REAL DEFAULT 2.5, interval REAL DEFAULT 0, due INTEGER DEFAULT 0,
    reps INTEGER DEFAULT 0, lapses INTEGER DEFAULT 0, last INTEGER, active INTEGER DEFAULT 1
);

-- Meilleur coup à faible profondeur (pour juger si un coup était difficile à trouver)
CREATE TABLE IF NOT EXISTS shallow_cache(
    fen TEXT, depth INTEGER, best TEXT, PRIMARY KEY(fen, depth)
);

-- Formation : leçons terminées (meilleur et dernier score au quiz)
CREATE TABLE IF NOT EXISTS course_progress(
    course TEXT, lesson TEXT, done_at INTEGER, best INTEGER, last INTEGER, total INTEGER, runs INTEGER DEFAULT 0,
    PRIMARY KEY(course, lesson)
);

CREATE TABLE IF NOT EXISTS explorer_cache(
    key TEXT PRIMARY KEY, data TEXT, fetched_at INTEGER
);
"""


def winp(cp, mate):
    """% de gain (0-100) à partir d'une éval (formule Lichess)."""
    if mate is not None:
        return 100.0 if mate > 0 else 0.0
    if cp is None:
        return 50.0
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


def connect():
    path = config.db_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    con = sqlite3.connect(path, timeout=30, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    return con


# Colonnes ajoutées après la première version : (table, colonne, type)
MIGRATIONS = [
    ("moves", "gap", "REAL"),          # écart de % de gain entre le 1er et le 2e meilleur coup
    ("games", "reviewed", "INTEGER DEFAULT 0"),  # analyse complète (toute la partie) faite
    ("moves", "rc", "TEXT"),           # classe du coup façon Chess.com (après analyse complète)
    ("games", "acc_me", "REAL"),       # précision (après analyse complète)
    ("games", "acc_opp", "REAL"),
    ("games", "n_brilliant", "INTEGER"),
    ("games", "n_great", "INTEGER"),
    ("games", "n_blunder", "INTEGER"),
    ("games", "cc_acc_me", "REAL"),    # précision calculée par Chess.com (si la partie y a été analysée)
    ("games", "cc_acc_opp", "REAL"),
]


def init():
    con = connect()
    con.executescript(SCHEMA)
    for table, col, typ in MIGRATIONS:
        cols = {r["name"] for r in con.execute(f"PRAGMA table_info({table})")}
        if col not in cols:
            con.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typ}")
    con.commit()
    con.close()


def rows(sql, params=()):
    con = connect()
    try:
        return [dict(r) for r in con.execute(sql, params).fetchall()]
    finally:
        con.close()


def one(sql, params=()):
    r = rows(sql, params)
    return r[0] if r else None
