"""Configuration de l'application.

Réglages de la machine (Stockfish, profondeurs, seuils, jeton Lichess) : config.json à la racine.
Réglages du joueur (pseudo, import) : data/profiles/<id>/profile.json, un dossier par profil.
"""
import json
import os
import sys
import threading
import time

# Exécutable autonome (PyInstaller) : données et Stockfish à côté de l'exe, interface dans le paquet
FROZEN = getattr(sys, "frozen", False)
ROOT = os.path.dirname(sys.executable) if FROZEN else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "config.json")
DATA_DIR = os.path.join(ROOT, "data")
PROFILES_DIR = os.path.join(DATA_DIR, "profiles")
STATE_PATH = os.path.join(DATA_DIR, "profiles.json")  # {"active": "<id>"}
DB_NAME = "echecbase.db"
STATIC_DIR = os.path.join(sys._MEIPASS if FROZEN else ROOT, "static")

_cpu = os.cpu_count() or 4

DEFAULTS = {
    "chesscom_username": "",
    "lichess_username": "",
    "lichess_token": "",
    "import_months": 6,
    "time_classes": ["blitz", "rapid"],
    # Analyse des parties : nombre de demi-coups analysés depuis le début
    "analysis_plies": 30,
    "analysis_depth": 16,
    # Temps maximal (s) par position en analyse de fond : certaines finales font tourner Stockfish sans fin
    "analysis_max_time": 10,
    # Analyse complète de toutes les parties en tâche de fond (bilan, coups brillants…)
    "auto_review": True,
    # Analyse complète limitée aux parties des N derniers mois (0 = toutes)
    "review_months": 0,
    # Analyse interactive (répertoire, entraînement)
    "live_depth": 20,
    "live_multipv": 5,
    # Temps maximal (s) d'une analyse interactive : certaines positions (mats, tactiques) explosent en multipv
    "live_max_time": 4,
    "stockfish_path": "stockfish-windows-x86-64-universal/stockfish/stockfish-windows-x86-64-universal.exe",
    "engine_threads": max(1, _cpu // 2),
    "live_threads": max(1, min(4, _cpu // 3)),
    "engine_hash_mb": 256,
    # Seuils de perte de % de gain (0-100) pour classer un coup
    "thresholds": {"inaccuracy": 10, "mistake": 15, "blunder": 25},
    "explorer_ratings": [1000, 1200, 1400, 1600],
    "explorer_speeds": ["blitz", "rapid"],
}

# Réglages propres à chaque profil (les autres sont communs à tous les profils de la machine)
PROFILE_KEYS = ("chesscom_username", "lichess_username", "import_months", "time_classes", "review_months")

_lock = threading.Lock()
_cache = None


class NoProfile(Exception):
    """Aucun profil actif (premier lancement)."""


def read_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def active_profile():
    """Identifiant du profil actif, ou None."""
    pid = (read_json(STATE_PATH, {}) or {}).get("active")
    return pid if pid and os.path.isdir(profile_dir(pid)) else None


def set_active_profile(pid):
    os.makedirs(DATA_DIR, exist_ok=True)
    write_json(STATE_PATH, {"active": pid})
    invalidate()


def profile_dir(pid):
    return os.path.join(PROFILES_DIR, pid)


def profile_meta(pid):
    return read_json(os.path.join(profile_dir(pid), "profile.json"), {}) or {}


def save_profile_meta(pid, meta):
    write_json(os.path.join(profile_dir(pid), "profile.json"), meta)


def db_path():
    pid = active_profile()
    if not pid:
        raise NoProfile()
    return os.path.join(profile_dir(pid), DB_NAME)


def invalidate():
    global _cache
    with _lock:
        _cache = None


def _merge(cfg, updates):
    for k, v in updates.items():
        if isinstance(v, dict) and isinstance(cfg.get(k), dict):
            cfg[k].update(v)
        else:
            cfg[k] = v


def load():
    global _cache
    with _lock:
        if _cache is None:
            cfg = json.loads(json.dumps(DEFAULTS))
            _merge(cfg, read_json(CONFIG_PATH, {}) or {})
            pid = active_profile()
            if pid:
                _merge(cfg, {k: v for k, v in profile_meta(pid).get("settings", {}).items() if k in PROFILE_KEYS})
            _cache = cfg
        return _cache


def save(updates):
    global _cache
    updates = {k: v for k, v in updates.items() if k in DEFAULTS}
    pid = active_profile()
    mine = {k: updates.pop(k) for k in list(updates) if k in PROFILE_KEYS and pid}
    with _lock:
        if updates:
            glob = read_json(CONFIG_PATH, {}) or {}
            _merge(glob, updates)
            for k in PROFILE_KEYS:
                glob.pop(k, None)
            write_json(CONFIG_PATH, glob)
        if mine:
            meta = profile_meta(pid)
            meta.setdefault("settings", {}).update(mine)
            save_profile_meta(pid, meta)
        _cache = None
    return load()


def review_cutoff():
    """Date (timestamp) avant laquelle les parties ne sont pas analysées en entier automatiquement (0 = aucune)."""
    months = int(load().get("review_months") or 0)
    return time.time() - months * 31 * 86400 if months > 0 else 0


def stockfish_path():
    p = load()["stockfish_path"]
    return p if os.path.isabs(p) else os.path.join(ROOT, p)


def public():
    """Config renvoyée à l'interface (le jeton n'est jamais renvoyé en clair)."""
    cfg = dict(load())
    cfg["lichess_token"] = "********" if cfg.get("lichess_token") else ""
    return cfg
