"""API FastAPI + service de l'interface."""
import asyncio
import os
from contextlib import asynccontextmanager

import chess
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, db, engine, explorer, jobs, profiles, repertoire, review, stats, training

try:  # module optionnel, absent du dépôt public
    from . import courses
except ImportError:
    courses = None


@asynccontextmanager
async def lifespan(app):
    profiles.migrate()
    if config.active_profile():
        db.init()
    yield
    jobs.stop()
    engine.shutdown()


app = FastAPI(title="EchecBase", lifespan=lifespan)


@app.exception_handler(config.NoProfile)
async def no_profile(request, exc):
    return JSONResponse({"detail": "Aucun profil actif"}, status_code=409)


@app.exception_handler(profiles.ProfileError)
async def profile_error(request, exc):
    return JSONResponse({"detail": str(exc)}, status_code=exc.status)


class NoCacheStatic:
    """L'interface est servie en local : on évite les fichiers JS/CSS périmés après une mise à jour.
    Middleware ASGI pur : @app.middleware("http") masquerait aux routes l'abandon d'une requête par le client."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/static/"):
            return await self.app(scope, receive, send)

        async def send_no_cache(message):
            if message["type"] == "http.response.start":
                headers = [(k, v) for k, v in message.get("headers", []) if k.lower() != b"cache-control"]
                message = {**message, "headers": headers + [(b"cache-control", b"no-cache")]}
            await send(message)

        await self.app(scope, receive, send_no_cache)


app.add_middleware(NoCacheStatic)


def _key(fen):
    """Accepte une FEN complète ou une clé, renvoie la clé normalisée."""
    try:
        return engine.key(chess.Board(fen if len(fen.split(" ")) >= 6 else fen + " 0 1"))
    except ValueError:
        raise HTTPException(400, "FEN invalide")


# ---- Synchronisation / analyse ----------------------------------------------

@app.post("/api/sync")
def sync(do_import: bool = True):
    return {"started": jobs.start(do_import), "status": jobs.status}


@app.post("/api/sync/stop")
def sync_stop():
    jobs.stop()
    return jobs.status


@app.get("/api/status")
def status():
    return jobs.status


# ---- Statistiques -------------------------------------------------------------

@app.get("/api/overview")
def overview():
    return stats.overview()


@app.get("/api/problems")
def problems(color: str = "", min_errors: int = 1, limit: int = 40, min_seen: int = 1):
    return stats.problems(color or None, min_errors, limit, min_seen)


@app.get("/api/openings")
def openings(color: str = ""):
    return stats.openings(color or None)


@app.get("/api/games")
def games(color: str = ""):
    return stats.games_list(color or None)


@app.get("/api/special")
def special(rc: str = "brilliant"):
    if rc not in ("brilliant", "great"):
        raise HTTPException(400)
    return stats.special_moves(rc)


@app.get("/api/review")
def review_status(gid: str):
    return review.status(gid)


@app.post("/api/review")
def review_start(gid: str):
    if not db.one("SELECT id FROM games WHERE id=?", (gid,)):
        raise HTTPException(404)
    return review.start(gid)


@app.get("/api/games/{gid:path}")
def game(gid: str):
    g = stats.game_detail(gid)
    if not g:
        raise HTTPException(404)
    return g


@app.get("/api/deviations")
def deviations(color: str = "", kind: str = ""):
    return stats.deviations(color or None, kind or None)


# ---- Position : moteur, explorateur, mes parties ---------------------------

# Analyses interactives traitées une par une. Une requête abandonnée par l'interface (position quittée,
# page fermée) est sautée au lieu d'occuper Stockfish pendant des secondes.
_live_gate = asyncio.Lock()


@app.get("/api/engine")
async def engine_lines(request: Request, fen: str, depth: int = 0):
    k = _key(fen)
    cached = await run_in_threadpool(engine.live_cached, k, depth or None)
    if cached:
        return cached
    # Lit le corps (vide) de la requête : ensuite, is_disconnected() ne voit plus que l'abandon du client.
    await request.body()
    async with _live_gate:
        if await request.is_disconnected():
            return Response(status_code=204)
        return await run_in_threadpool(engine.live_lines, k, depth or None)


@app.get("/api/explorer")
def explorer_q(fen: str):
    return explorer.query(_key(fen))


@app.get("/api/mytree")
def mytree(fen: str, color: str = ""):
    return stats.my_tree(_key(fen), color or None)


# ---- Répertoire ---------------------------------------------------------------

class Line(BaseModel):
    moves: list[str]
    replace: bool = False


class MoveRef(BaseModel):
    fen: str
    uci: str


def _color(color):
    if color not in ("white", "black"):
        raise HTTPException(400, "couleur invalide")
    return color


@app.get("/api/repertoire/{color}")
def rep_get(color: str):
    _color(color)
    return {"edges": repertoire.edges(color), "summary": repertoire.summary(color)}


@app.post("/api/repertoire/{color}/line")
def rep_add(color: str, line: Line):
    res = repertoire.add_line(_color(color), line.moves, line.replace)
    if res.get("ok"):
        training.sync()
    return res


@app.post("/api/repertoire/{color}/delete")
def rep_delete(color: str, ref: MoveRef):
    repertoire.delete_move(_color(color), _key(ref.fen), ref.uci)
    training.sync()
    return {"ok": True}


# ---- Entraînement ---------------------------------------------------------------

class Answer(BaseModel):
    id: str
    uci: str


@app.get("/api/training/counts")
def tr_counts():
    return training.counts()


@app.get("/api/training/next")
def tr_next(kind: str = "all", exclude: str = ""):
    return {"card": training.next_card(kind, exclude or None), "counts": training.counts()}


@app.post("/api/training/answer")
def tr_answer(a: Answer):
    return training.answer(a.id, a.uci)


@app.post("/api/training/sync")
def tr_sync():
    training.sync()
    return training.counts()


# ---- Formation ---------------------------------------------------------------------

if courses is not None:
    class QuizAnswer(BaseModel):
        value: str


    class LessonDone(BaseModel):
        score: int
        total: int


    class RepAdd(BaseModel):
        replace: bool = False


    @app.get("/api/courses")
    def courses_list():
        return courses.list_courses()


    @app.get("/api/courses/check")
    def courses_check(fen: str, uci: str):
        return courses.check_move(_key(fen), uci)


    @app.get("/api/courses/{cid}/{lid}")
    def courses_lesson(cid: str, lid: str):
        r = courses.get_lesson(cid, lid)
        if not r:
            raise HTTPException(404, "leçon inconnue")
        return r


    @app.post("/api/courses/{cid}/{lid}/quiz/{qid}")
    def courses_quiz(cid: str, lid: str, qid: str, a: QuizAnswer):
        return courses.answer_quiz(cid, lid, qid, a.value)


    @app.post("/api/courses/{cid}/{lid}/done")
    def courses_done(cid: str, lid: str, d: LessonDone):
        courses.complete(cid, lid, d.score, d.total)
        training.sync()
        return {"ok": True, "counts": training.counts()}


    @app.post("/api/courses/{cid}/{lid}/repertoire")
    def courses_rep(cid: str, lid: str, r: RepAdd):
        res = courses.add_to_repertoire(cid, lid, r.replace)
        if res.get("ok"):
            training.sync()
        return res


# ---- Profils ---------------------------------------------------------------------

class NewProfile(BaseModel):
    chesscom_username: str
    name: str = ""


class ProfileName(BaseModel):
    name: str


def _after_switch():
    jobs.start(do_import=True)
    return profiles.listing()


@app.get("/api/profiles")
def prof_list():
    return profiles.listing()


@app.post("/api/profiles")
def prof_create(p: NewProfile):
    profiles.create(p.name, p.chesscom_username)
    return _after_switch()


@app.post("/api/profiles/import")
async def prof_import(request: Request, replace: bool = False):
    data = await request.body()
    await run_in_threadpool(profiles.import_zip, data, replace)
    return await run_in_threadpool(_after_switch)


@app.post("/api/profiles/{pid}/activate")
def prof_activate(pid: str):
    profiles.activate(pid)
    return _after_switch()


@app.post("/api/profiles/{pid}/rename")
def prof_rename(pid: str, p: ProfileName):
    profiles.rename(pid, p.name)
    return profiles.listing()


@app.post("/api/profiles/{pid}/export")
def prof_export(pid: str):
    return {"path": profiles.export(pid)}


@app.delete("/api/profiles/{pid}")
def prof_delete(pid: str):
    profiles.delete(pid)
    return profiles.listing()


# ---- Réglages ---------------------------------------------------------------------

@app.get("/api/config")
def cfg_get():
    return config.public()


@app.post("/api/config")
def cfg_set(updates: dict):
    if updates.get("lichess_token") == "********":
        updates.pop("lichess_token")
    old = config.load()
    reset_engines = any(k in updates and updates[k] != old.get(k)
                        for k in ("engine_threads", "live_threads", "engine_hash_mb", "stockfish_path"))
    config.save(updates)
    if reset_engines:
        engine.shutdown()
        engine._batch = engine._live = None
    return config.public()


@app.post("/api/reanalyse")
def reanalyse():
    if jobs.status["running"]:
        raise HTTPException(409, "Une tâche est déjà en cours")
    jobs.reset_analysis()
    jobs.start(do_import=False)
    return jobs.status


# ---- Interface ---------------------------------------------------------------------

app.mount("/static", StaticFiles(directory=config.STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(os.path.join(config.STATIC_DIR, "index.html"),
                        headers={"Cache-Control": "no-store"})
