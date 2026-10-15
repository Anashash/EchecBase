"""Profils : un dossier par joueur (data/profiles/<id>/) avec sa base et ses réglages.

Un profil s'échange sous forme de .zip (profile.json + echecbase.db) : export d'un côté, import de l'autre.
"""
import datetime as dt
import io
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time
import unicodedata
import zipfile

import requests

from . import config, db, jobs, review

MAX_IMPORT_BYTES = 500 * 1024 * 1024
SQLITE_MAGIC = b"SQLite format 3\x00"


class ProfileError(Exception):
    def __init__(self, msg, status=400):
        super().__init__(msg)
        self.status = status


def _slug(text):
    s = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:40]
    return s or "profil"


def _ids():
    if not os.path.isdir(config.PROFILES_DIR):
        return []
    return sorted(d for d in os.listdir(config.PROFILES_DIR)
                  if os.path.isfile(os.path.join(config.PROFILES_DIR, d, "profile.json")))


def _free_id(base):
    pid, n = base, 2
    while os.path.exists(config.profile_dir(pid)):
        pid, n = f"{base}-{n}", n + 1
    return pid


def _check(pid):
    if pid not in _ids():
        raise ProfileError("Profil inconnu", 404)


def _games_count(pid):
    path = os.path.join(config.profile_dir(pid), config.DB_NAME)
    if not os.path.exists(path):
        return 0
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
        try:
            return con.execute("SELECT COUNT(*) FROM games").fetchone()[0]
        finally:
            con.close()
    except sqlite3.Error:
        return None


def listing():
    active = config.active_profile()
    out = []
    for pid in _ids():
        meta = config.profile_meta(pid)
        out.append({"id": pid, "name": meta.get("name") or pid,
                    "chesscom_username": meta.get("settings", {}).get("chesscom_username", ""),
                    "games": _games_count(pid), "active": pid == active})
    return {"active": active, "profiles": out}


# ---- Bascule --------------------------------------------------------------------

def _quiesce():
    """Arrête les tâches de fond de la base courante avant de changer de profil."""
    jobs.stop()
    jobs.wait(60)
    review._status.clear()


def activate(pid):
    _check(pid)
    if pid != config.active_profile():
        _quiesce()
        config.set_active_profile(pid)
    db.init()


# ---- Création, renommage, suppression ----------------------------------------------

def _check_chesscom(username):
    """Vérifie que le pseudo existe sur Chess.com (sans réseau : on laisse passer)."""
    try:
        r = requests.get(f"https://api.chess.com/pub/player/{username.lower()}",
                         headers={"User-Agent": "EchecBase/1.0"}, timeout=10)
    except requests.RequestException:
        return
    if r.status_code == 404:
        raise ProfileError(f"Pseudo « {username} » introuvable sur Chess.com")


def create(name, username):
    username = (username or "").strip()
    name = (name or "").strip() or username
    if not re.fullmatch(r"[A-Za-z0-9_-]{3,25}", username):
        raise ProfileError("Pseudo Chess.com invalide")
    _check_chesscom(username)
    pid = _free_id(_slug(username))
    os.makedirs(config.profile_dir(pid))
    config.save_profile_meta(pid, {"name": name[:40], "created_at": int(time.time()),
                                   "settings": {"chesscom_username": username}})
    activate(pid)
    return pid


def rename(pid, name):
    _check(pid)
    name = (name or "").strip()
    if not name:
        raise ProfileError("Nom vide")
    meta = config.profile_meta(pid)
    meta["name"] = name[:40]
    config.save_profile_meta(pid, meta)


def delete(pid):
    _check(pid)
    if pid == config.active_profile():
        raise ProfileError("Impossible de supprimer le profil actif : bascule d'abord sur un autre profil", 409)
    try:
        shutil.rmtree(config.profile_dir(pid))
    except OSError as e:
        raise ProfileError(f"Suppression impossible ({e.strerror}). Réessaie dans quelques secondes.", 409)


# ---- Export / import -------------------------------------------------------------

def _downloads_dir():
    d = os.path.join(os.path.expanduser("~"), "Downloads")
    if not os.path.isdir(d):
        d = os.path.join(config.DATA_DIR, "exports")
        os.makedirs(d, exist_ok=True)
    return d


def export(pid):
    """Crée EchecBase-<id>-<date>.zip dans Téléchargements et l'affiche dans l'Explorateur."""
    _check(pid)
    src = os.path.join(config.profile_dir(pid), config.DB_NAME)
    meta = config.profile_meta(pid)
    meta["id"] = pid
    meta["exported_at"] = int(time.time())
    out_dir = _downloads_dir()
    base = f"EchecBase-{pid}-{dt.date.today().isoformat()}"
    out, n = os.path.join(out_dir, base + ".zip"), 2
    while os.path.exists(out):
        out, n = os.path.join(out_dir, f"{base} ({n}).zip"), n + 1

    with tempfile.TemporaryDirectory() as tmp:
        snap = os.path.join(tmp, config.DB_NAME)
        # VACUUM INTO : copie cohérente même si une analyse écrit en même temps
        con = sqlite3.connect(src, timeout=30)
        try:
            con.execute("VACUUM INTO ?", (snap,))
        finally:
            con.close()
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("profile.json", json.dumps(meta, indent=2, ensure_ascii=False))
            z.write(snap, config.DB_NAME)

    if os.name == "nt":
        try:
            subprocess.Popen(["explorer", "/select,", os.path.normpath(out)])
        except OSError:
            pass
    return os.path.normpath(out)


def _read_zip(data):
    if len(data) > MAX_IMPORT_BYTES:
        raise ProfileError("Fichier trop volumineux")
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
        names = set(z.namelist())
        if not {"profile.json", config.DB_NAME} <= names:
            raise ProfileError("Ce fichier n'est pas un profil EchecBase")
        meta = json.loads(z.read("profile.json").decode("utf-8"))
        info = z.getinfo(config.DB_NAME)
        if info.file_size > MAX_IMPORT_BYTES:
            raise ProfileError("Base trop volumineuse")
        dbbytes = z.read(config.DB_NAME)
    except (zipfile.BadZipFile, UnicodeDecodeError, ValueError):
        raise ProfileError("Ce fichier n'est pas un profil EchecBase")
    if not isinstance(meta, dict) or not dbbytes.startswith(SQLITE_MAGIC):
        raise ProfileError("Ce fichier n'est pas un profil EchecBase")
    return meta, dbbytes


def import_zip(data, replace=False):
    meta, dbbytes = _read_zip(data)
    settings = meta.get("settings") if isinstance(meta.get("settings"), dict) else {}
    settings = {k: v for k, v in settings.items() if k in config.PROFILE_KEYS}
    name = str(meta.get("name") or settings.get("chesscom_username") or "Profil")[:40]
    pid = _slug(str(meta.get("id") or name))
    exists = os.path.exists(config.profile_dir(pid))
    if exists and not replace:
        raise ProfileError(f"exists:{name}", 409)

    os.makedirs(config.PROFILES_DIR, exist_ok=True)
    staging = tempfile.mkdtemp(prefix=".import-", dir=config.PROFILES_DIR)
    try:
        path = os.path.join(staging, config.DB_NAME)
        with open(path, "wb") as f:
            f.write(dbbytes)
        con = sqlite3.connect(path)
        try:
            if con.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ProfileError("Base du profil endommagée")
            tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {"games", "moves"} <= tables:
                raise ProfileError("Ce fichier n'est pas un profil EchecBase")
        except sqlite3.DatabaseError:
            raise ProfileError("Base du profil endommagée")
        finally:
            con.close()
        clean = {"name": name, "created_at": meta.get("created_at") or int(time.time()),
                 "imported_at": int(time.time()), "settings": settings}
        config.write_json(os.path.join(staging, "profile.json"), clean)

        target = config.profile_dir(pid)
        if exists:
            if pid == config.active_profile():
                _quiesce()
            trash = target + f".old-{int(time.time())}"
            try:
                os.replace(target, trash)
            except OSError as e:
                raise ProfileError(f"Remplacement impossible ({e.strerror}). Réessaie dans quelques secondes.", 409)
            shutil.rmtree(trash, ignore_errors=True)
        os.replace(staging, target)
        staging = None
    finally:
        if staging:
            shutil.rmtree(staging, ignore_errors=True)
    config.invalidate()
    activate(pid)
    return pid


# ---- Migration depuis la version mono-profil ------------------------------------------

def migrate():
    """data/echecbase.db (ancienne version) devient le premier profil. Sans profil actif valide, active le premier."""
    legacy = os.path.join(config.DATA_DIR, config.DB_NAME)
    ids = _ids()
    if ids and not config.active_profile():
        config.set_active_profile(ids[0])
    if not os.path.exists(legacy) or ids:
        return
    glob = config.read_json(config.CONFIG_PATH, {}) or {}
    username = glob.get("chesscom_username") or "joueur"
    pid = _slug(username)
    os.makedirs(config.profile_dir(pid), exist_ok=True)
    for ext in ("", "-wal", "-shm"):
        if os.path.exists(legacy + ext):
            os.replace(legacy + ext, os.path.join(config.profile_dir(pid), config.DB_NAME + ext))
    settings = {k: glob[k] for k in config.PROFILE_KEYS if k in glob}
    settings.setdefault("chesscom_username", username)
    config.save_profile_meta(pid, {"name": username, "created_at": int(time.time()), "settings": settings})
    if any(k in glob for k in config.PROFILE_KEYS):
        config.write_json(config.CONFIG_PATH, {k: v for k, v in glob.items() if k not in config.PROFILE_KEYS})
    config.set_active_profile(pid)
