"""FastAPI app: API + WebSocket progress + static frontend.

The UI and the CLI call the very same core library. Nothing the UI shows is
hidden state — runs live on disk under ``runs/`` and are served straight from
there.
"""
from __future__ import annotations

import asyncio
import json
import shutil
import uuid
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import FastAPI, UploadFile, File, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (FileResponse, JSONResponse, HTMLResponse,
                               Response, StreamingResponse)
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from ..core import recipe as R
from ..core import chat as C
from ..core.analyze import analyze_cached, audio_cache_key, load_audio
from ..core.project import (Project, Segment, append_revision, list_revisions,
                            load_revision)
from ..core.schema import recipe_schema
from ..core.score import Score
from ..core.pipeline import (load_run, list_runs, run_pipeline, run_fluid,
                             run_diffuse, run_segment_preview,
                             run_window_preview, init_project_run,
                             frozen_audio, DEFAULT_WINDOW_S)
from .db import JobDB
from .jobs import JobManager

WEBAPP_DIST = Path(__file__).resolve().parents[1] / "webapp_dist"

SETTINGS_KEYS = ("llm_provider", "llm_model", "anthropic_api_key",
                 "gemini_api_key")
SECRET_KEYS = ("anthropic_api_key", "gemini_api_key")


class RunRequest(BaseModel):
    audio_id: str
    recipe_name: Optional[str] = None
    recipe: Optional[dict] = None
    seconds: Optional[float] = None


class ProjectRequest(BaseModel):
    audio_id: str
    recipe_name: Optional[str] = None
    recipe: Optional[dict] = None
    seconds: Optional[float] = None


class ProjectUpdate(BaseModel):
    segments: Optional[list] = None
    recipe: Optional[dict] = None
    seconds: Optional[float] = None
    timeline: Optional[list] = None
    ui_pins: Optional[list] = None


class RecipePatch(BaseModel):
    ops: Optional[list] = None          # JSON Patch (RFC 6902)
    recipe: Optional[dict] = None       # or a full replacement document


class TimelinePatch(BaseModel):
    timeline: list


class PreviewRequest(BaseModel):
    draft: bool = False


class WindowPreviewRequest(BaseModel):
    t0: float = 0.0
    t1: Optional[float] = None
    draft: bool = True


class SegmentPreviewRequest(BaseModel):
    index: int
    draft: bool = True


class ChatRequest(BaseModel):
    message: str
    reset: bool = False


class SettingsUpdate(BaseModel):
    llm_provider: Optional[str] = None
    llm_model: Optional[str] = None
    anthropic_api_key: Optional[str] = None
    gemini_api_key: Optional[str] = None


def _waveform_peaks(y: np.ndarray, buckets: int = 800) -> list:
    if len(y) == 0:
        return []
    n = min(buckets, len(y))
    edges = np.linspace(0, len(y), n + 1).astype(int)
    return [round(float(np.abs(y[a:b]).max()) if b > a else 0.0, 4)
            for a, b in zip(edges[:-1], edges[1:])]


def create_app(runs_root: str | Path = "runs",
               data_dir: str | Path | None = None) -> FastAPI:
    runs_root = Path(runs_root)
    data_dir = Path(data_dir) if data_dir else runs_root.parent / ".kaika"
    uploads = data_dir / "uploads"
    uploads.mkdir(parents=True, exist_ok=True)
    runs_root.mkdir(parents=True, exist_ok=True)

    db = JobDB(data_dir / "kaika.db")
    jm = JobManager(runs_root, db)

    app = FastAPI(title="Kaika")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                       allow_headers=["*"])
    app.state.jm = jm
    app.state.runs_root = runs_root
    app.state.uploads = uploads

    # ---- recipes ----------------------------------------------------------
    @app.get("/api/recipes")
    def recipes():
        out = []
        for p in sorted(R.RECIPES_DIR.glob("*.yaml")):
            try:
                out.append({"name": p.stem, "yaml": p.read_text(),
                            "recipe": R.load_recipe(p).to_dict()})
            except Exception:  # noqa
                pass
        return out

    # ---- upload + analyze (Studio) ----------------------------------------
    @app.post("/api/upload")
    async def upload(file: UploadFile = File(...)):
        suffix = Path(file.filename or "audio.wav").suffix or ".wav"
        audio_id = uuid.uuid4().hex[:12]
        dest = uploads / f"{audio_id}{suffix}"
        with dest.open("wb") as f:
            shutil.copyfileobj(file.file, f)
        return {"audio_id": audio_id, "name": file.filename}

    def _resolve_audio(audio_id: str) -> Path:
        hits = list(uploads.glob(f"{audio_id}.*"))
        if not hits:
            raise HTTPException(404, f"audio {audio_id} not found")
        return hits[0]

    @app.post("/api/analyze")
    def analyze_audio(audio_id: str, fps: int = 24):
        path = _resolve_audio(audio_id)
        cache = runs_root / ".analysis_cache"
        score = analyze_cached(path, cache, fps=fps)
        # The waveform needs a full decode of the track — cache it on the
        # same content key so resubmissions skip it entirely.
        wf_path = cache / f"{audio_cache_key(path)}.waveform.json"
        if wf_path.exists():
            waveform = json.loads(wf_path.read_text())
        else:
            y, _sr = load_audio(path)
            waveform = _waveform_peaks(y)
            wf_path.parent.mkdir(parents=True, exist_ok=True)
            wf_path.write_text(json.dumps(waveform))
        return {
            "audio_id": audio_id, "tempo_bpm": score.tempo_bpm,
            "duration_s": score.audio.duration_s, "fps": fps,
            "n_frames": score.n_frames,
            "sections": [s.__dict__ for s in score.sections],
            "beats": [b.__dict__ for b in score.beats],
            "onset_counts": {k: len(v) for k, v in score.onsets.items()},
            "waveform": waveform,
        }

    # ---- runs (jobs) ------------------------------------------------------
    def _recipe_from(req) -> R.Recipe:
        if req.recipe is not None:
            return R.from_dict(req.recipe)
        return R.load_recipe(req.recipe_name or "eclosion")

    @app.post("/api/runs")
    def start_run(req: RunRequest):
        path = _resolve_audio(req.audio_id)
        rec = _recipe_from(req)
        job_id = jm.submit(
            lambda progress: run_pipeline(path, rec, runs_root=runs_root,
                                          seconds=req.seconds, progress=progress),
            kind="render")
        return {"job_id": job_id}

    # ---- projects (segment editor) ----------------------------------------
    def _analysis_payload(rd: Path) -> Optional[dict]:
        """Persistent analysis view for the editor: score data + cached waveform."""
        score_path = rd / "score.json"
        if not score_path.exists():
            return None
        score = Score.from_json(score_path)
        wf_path = rd / "waveform.json"
        if wf_path.exists():
            waveform = json.loads(wf_path.read_text())
        else:
            audio = frozen_audio(rd)
            if audio is None:
                waveform = []
            else:
                y, _sr = load_audio(audio)
                waveform = _waveform_peaks(y)
            wf_path.write_text(json.dumps(waveform))
        return {
            "tempo_bpm": score.tempo_bpm, "duration_s": score.audio.duration_s,
            "fps": score.audio.fps, "n_frames": score.n_frames,
            "beats": [b.__dict__ for b in score.beats],
            "onsets": {k: [round(e.t, 3) for e in v] for k, v in score.onsets.items()},
            "onset_counts": {k: len(v) for k, v in score.onsets.items()},
            "waveform": waveform,
        }

    def _project_payload(run_id: str, with_analysis: bool = False) -> dict:
        rd = runs_root / run_id
        if not (rd / "project.json").exists():
            raise HTTPException(404, "project not found")
        audio = frozen_audio(rd)
        payload = {
            "run_id": run_id,
            "project": Project.from_json(rd / "project.json").to_dict(),
            "manifest": load_run(rd),
            "audio_url": f"/api/runs/{run_id}/files/{audio.name}" if audio else None,
        }
        if with_analysis:
            payload["analysis"] = _analysis_payload(rd)
        return payload

    @app.post("/api/projects")
    def create_project(req: ProjectRequest):
        path = _resolve_audio(req.audio_id)
        rec = _recipe_from(req)
        run_dir, project, score = init_project_run(path, rec, runs_root=runs_root,
                                                   seconds=req.seconds)
        return _project_payload(run_dir.name, with_analysis=True)

    @app.get("/api/projects/{run_id}")
    def get_project(run_id: str):
        return _project_payload(run_id, with_analysis=True)

    def _project_dir(run_id: str) -> Path:
        rd = runs_root / run_id
        if not (rd / "project.json").exists():
            raise HTTPException(404, "project not found")
        return rd

    @app.put("/api/projects/{run_id}")
    def update_project(run_id: str, upd: ProjectUpdate):
        rd = _project_dir(run_id)
        proj = Project.from_json(rd / "project.json")
        append_revision(rd, proj, note="edit")
        if upd.recipe is not None:
            try:
                proj.recipe = R.from_dict(upd.recipe)
            except ValueError as e:
                raise HTTPException(400, str(e))
        if upd.seconds is not None:
            proj.seconds = upd.seconds
        if upd.segments is not None:
            proj.segments = [Segment(**s) for s in upd.segments]
        if upd.timeline is not None:
            errs = R.validate_timeline(upd.timeline)
            if errs:
                raise HTTPException(400, "; ".join(errs))
            proj.timeline = upd.timeline
        if upd.ui_pins is not None:
            proj.ui_pins = list(upd.ui_pins)
        proj.to_json(rd / "project.json")
        return _project_payload(run_id)

    @app.patch("/api/projects/{run_id}/recipe")
    def patch_recipe(run_id: str, patch: RecipePatch):
        """JSON Patch (RFC 6902) or full replacement, schema-validated.
        Shared by the UI and the chat tools."""
        rd = _project_dir(run_id)
        proj = Project.from_json(rd / "project.json")
        doc = proj.recipe.to_dict()
        if patch.ops:
            try:
                doc = C.apply_json_patch(doc, patch.ops)
            except (ValueError, IndexError, KeyError) as e:
                raise HTTPException(400, f"patch error: {e}")
        elif patch.recipe is not None:
            doc = patch.recipe
        try:
            new_recipe = R.from_dict(doc)
        except ValueError as e:
            raise HTTPException(400, str(e))
        append_revision(rd, proj, note="recipe patch")
        proj.recipe = new_recipe
        proj.to_json(rd / "project.json")
        return _project_payload(run_id)

    @app.patch("/api/projects/{run_id}/timeline")
    def patch_timeline(run_id: str, patch: TimelinePatch):
        rd = _project_dir(run_id)
        errs = R.validate_timeline(patch.timeline)
        if errs:
            raise HTTPException(400, "; ".join(errs))
        proj = Project.from_json(rd / "project.json")
        append_revision(rd, proj, note="timeline edit")
        proj.timeline = patch.timeline
        proj.to_json(rd / "project.json")
        return _project_payload(run_id)

    @app.get("/api/projects/{run_id}/signals")
    def project_signals(run_id: str, px: int = 1200):
        """Downsampled per-frame lanes for the waveform: rms, flux, bands,
        plus events (onsets, beats) and sections."""
        rd = _project_dir(run_id)
        score = Score.from_json(rd / "score.json")
        n = score.n_frames
        px = max(10, min(px, 4000))

        def lane(get):
            vals = np.array([get(f) for f in score.frames], np.float64)
            if n <= px:
                return [round(float(v), 4) for v in vals]
            edges = np.linspace(0, n, px + 1).astype(int)
            return [round(float(vals[a:b].max()) if b > a else 0.0, 4)
                    for a, b in zip(edges[:-1], edges[1:])]

        return {
            "n_frames": n, "fps": score.audio.fps,
            "duration_s": score.audio.duration_s,
            "rms": lane(lambda f: f.rms),
            "flux": lane(lambda f: f.flux),
            "bands": {
                "low": lane(lambda f: f.bands[0] if f.bands else 0.0),
                "mid": lane(lambda f: f.bands[1] if len(f.bands) > 1 else 0.0),
                "high": lane(lambda f: f.bands[2] if len(f.bands) > 2 else 0.0),
            },
            "onsets": {k: [round(e.t, 3) for e in v]
                       for k, v in score.onsets.items()},
            "beats": [round(b.t, 3) for b in score.beats],
            "sections": [s.__dict__ for s in score.sections],
        }

    @app.get("/api/projects/{run_id}/revisions")
    def revisions(run_id: str):
        rd = _project_dir(run_id)
        return list_revisions(rd)

    @app.post("/api/projects/{run_id}/revisions/{index}/restore")
    def restore_revision(run_id: str, index: int):
        rd = _project_dir(run_id)
        proj = load_revision(rd, index)
        if proj is None:
            raise HTTPException(404, f"revision {index} not found")
        current = Project.from_json(rd / "project.json")
        append_revision(rd, current, note=f"before restore {index}")
        proj.to_json(rd / "project.json")
        return _project_payload(run_id)

    @app.post("/api/projects/{run_id}/preview_window")
    def preview_window(run_id: str, req: WindowPreviewRequest):
        """The live-loop gesture: re-simulate a window at draft quality.
        One preview job per project — a newer request cancels the running one."""
        rd = _project_dir(run_id)
        t1 = req.t1 if req.t1 is not None else req.t0 + DEFAULT_WINDOW_S
        for j in db.all():
            if (j.get("run_id") == run_id and j.get("recipe") == "fluid_window"
                    and j.get("status") in ("queued", "running")):
                jm.cancel(j["id"])
        return {"job_id": jm.submit(
            lambda progress: run_window_preview(rd, req.t0, t1,
                                                draft=req.draft,
                                                progress=progress),
            run_id=run_id, kind="fluid_window")}

    # ---- settings + schema + chat -----------------------------------------
    settings_path = data_dir / "settings.json"

    def _load_settings() -> dict:
        if settings_path.exists():
            try:
                return json.loads(settings_path.read_text())
            except json.JSONDecodeError:
                return {}
        return {}

    @app.get("/api/schema/recipe")
    def schema_recipe():
        return recipe_schema()

    @app.get("/api/settings")
    def get_settings():
        s = _load_settings()
        out = {k: s.get(k, "") for k in SETTINGS_KEYS}
        for k in SECRET_KEYS:                      # never ship keys to the UI
            out[k] = bool(out.get(k))
        return out

    @app.put("/api/settings")
    def put_settings(upd: SettingsUpdate):
        s = _load_settings()
        for k in SETTINGS_KEYS:
            v = getattr(upd, k)
            if v is not None:
                s[k] = v
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        settings_path.write_text(json.dumps(s))
        return get_settings()

    @app.post("/api/projects/{run_id}/chat")
    def chat(run_id: str, req: ChatRequest):
        """One copilot turn, streamed as Server-Sent Events. The conversation
        is persisted per run dir (chat.json)."""
        rd = _project_dir(run_id)
        score = Score.from_json(rd / "score.json")
        try:
            backend = C.get_backend(_load_settings())
        except ValueError as e:
            raise HTTPException(400, str(e))

        chat_path = rd / "chat.json"
        history = []
        if chat_path.exists() and not req.reset:
            try:
                history = json.loads(chat_path.read_text())
            except json.JSONDecodeError:
                history = []

        def submit_preview(t0: float, t1: float) -> str:
            return jm.submit(
                lambda progress: run_window_preview(rd, t0, t1, draft=True,
                                                    progress=progress),
                run_id=run_id, kind="fluid_window")

        def submit_render() -> str:
            # Same job as POST /generate: run_diffuse rebuilds missing/draft
            # fluid itself.
            return jm.submit(lambda progress: run_diffuse(rd, progress=progress),
                             run_id=run_id, kind="diffuse")

        ctx = C.ToolContext(run_dir=rd, score=score,
                            submit_preview=submit_preview,
                            submit_render=submit_render)

        def stream():
            import queue as q
            import threading
            events: "q.Queue[Optional[dict]]" = q.Queue()

            def work():
                try:
                    out = C.run_chat_turn(ctx, backend, history, req.message,
                                          on_event=events.put)
                    chat_path.write_text(json.dumps(out["history"]))
                    events.put({"type": "done", "changes": out["changes"],
                                "preview_job": out["preview_job"],
                                "render_job": out.get("render_job")})
                except Exception as e:                       # noqa: BLE001
                    events.put({"type": "error",
                                "error": f"{type(e).__name__}: {e}"})
                events.put(None)

            threading.Thread(target=work, daemon=True).start()
            while True:
                ev = events.get()
                if ev is None:
                    break
                yield f"data: {json.dumps(ev)}\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.get("/api/projects/{run_id}/chat")
    def chat_history(run_id: str):
        rd = _project_dir(run_id)
        p = rd / "chat.json"
        if not p.exists():
            return []
        try:
            return json.loads(p.read_text())
        except json.JSONDecodeError:
            return []

    @app.post("/api/projects/{run_id}/preview")
    def preview_project(run_id: str, req: PreviewRequest = PreviewRequest()):
        rd = runs_root / run_id
        if not (rd / "project.json").exists():
            raise HTTPException(404, "project not found")

        def task(progress):
            proj = Project.from_json(rd / "project.json")
            score = Score.from_json(rd / "score.json")
            audio = frozen_audio(rd)
            if audio is None:
                raise FileNotFoundError("frozen audio missing for project")
            return run_fluid(proj, audio, runs_root=runs_root, run_id=run_id,
                             score=score, draft=req.draft, progress=progress)

        return {"job_id": jm.submit(task, run_id=run_id, kind="fluid")}

    @app.post("/api/projects/{run_id}/preview_segment")
    def preview_segment(run_id: str, req: SegmentPreviewRequest):
        rd = runs_root / run_id
        if not (rd / "project.json").exists():
            raise HTTPException(404, "project not found")
        n_segs = len(Project.from_json(rd / "project.json").segments)
        if not (0 <= req.index < n_segs):
            raise HTTPException(400, f"segment index {req.index} out of range")
        return {"job_id": jm.submit(
            lambda progress: run_segment_preview(rd, req.index, draft=req.draft,
                                                 progress=progress),
            run_id=run_id, kind="fluid_segment")}

    @app.post("/api/projects/{run_id}/generate")
    def generate_project(run_id: str):
        rd = runs_root / run_id
        if not (rd / "project.json").exists():
            raise HTTPException(404, "project not found")
        # run_diffuse rebuilds missing/draft fluid itself, so this always works.
        return {"job_id": jm.submit(lambda progress: run_diffuse(rd, progress=progress),
                                    run_id=run_id, kind="diffuse")}

    @app.get("/api/jobs/{job_id}")
    def job_status(job_id: str):
        j = jm.get(job_id)
        if not j:
            raise HTTPException(404, "job not found")
        return j

    @app.get("/api/jobs")
    def jobs():
        return db.all()

    @app.post("/api/jobs/{job_id}/cancel")
    def cancel_job(job_id: str):
        if not jm.cancel(job_id):
            raise HTTPException(409, "job not cancellable (unknown or finished)")
        return {"ok": True}

    @app.get("/api/runs/{run_id}/latest_frame")
    def latest_frame(run_id: str):
        """Most recent frame on disk for this run — live peek while rendering.

        The newest file may still be mid-write by the simulation worker, so we
        serve the *second*-newest when there is one, and always return a byte
        snapshot (FileResponse stats the size first, then streams a file that
        may have grown — 'Response content longer than Content-Length')."""
        rd = runs_root / run_id
        # Frame names are zero-padded and sequential, so the lexicographic
        # tail of each dir IS its chronological tail — stat() only those few
        # candidates, not every PNG (this endpoint is polled every 700ms).
        candidates: list = []
        for sub in ("styled", "fluid", "window_preview/fluid",
                    "seg_preview/fluid"):
            d = rd / sub
            if d.is_dir():
                tail = sorted(d.glob("*.png"))[-2:]
                candidates.extend(tail)
        if not candidates:
            raise HTTPException(404, "no frames yet")
        candidates.sort(key=lambda p: p.stat().st_mtime)
        pick = candidates[-2] if len(candidates) > 1 else candidates[-1]
        try:
            data = pick.read_bytes()
        except OSError:
            raise HTTPException(404, "no frames yet")
        return Response(content=data, media_type="image/png",
                        headers={"Cache-Control": "no-store"})

    @app.websocket("/ws/jobs/{job_id}")
    async def ws_job(ws: WebSocket, job_id: str):
        await ws.accept()
        last = None
        try:
            while True:
                j = jm.get(job_id)
                if j is None:
                    await ws.send_json({"error": "job not found"})
                    break
                snapshot = (j["status"], j["stage"], j["done"], j["total"])
                if snapshot != last:
                    await ws.send_json(j)
                    last = snapshot
                if j["status"] in ("done", "error"):
                    break
                await asyncio.sleep(0.15)
        except WebSocketDisconnect:
            return

    @app.get("/api/runs")
    def runs():
        return list_runs(runs_root)

    @app.get("/api/runs/{run_id}")
    def run_detail(run_id: str):
        rd = runs_root / run_id
        if not (rd / "run.json").exists():
            raise HTTPException(404, "run not found")
        return load_run(rd)

    @app.get("/api/runs/{run_id}/final")
    def run_final(run_id: str):
        m = run_detail(run_id)
        final = runs_root / run_id / (m.get("final") or "kaika_final.mp4")
        if not final.exists():
            raise HTTPException(404, "final not rendered")
        return FileResponse(final, media_type="video/mp4")

    @app.get("/api/runs/{run_id}/files/{subpath:path}")
    def run_file(run_id: str, subpath: str):
        rd = (runs_root / run_id).resolve()
        target = (rd / subpath).resolve()
        try:
            target.relative_to(rd)          # strict subpath, prefix-safe
        except ValueError:
            raise HTTPException(404, "file not found")
        if not target.is_file():
            raise HTTPException(404, "file not found")
        return FileResponse(target)

    # ---- static frontend --------------------------------------------------
    if (WEBAPP_DIST / "index.html").exists():
        app.mount("/", StaticFiles(directory=str(WEBAPP_DIST), html=True), name="web")
    else:
        @app.get("/")
        def placeholder():
            return HTMLResponse(
                "<h1>Kaika</h1><p>Frontend not built. Run "
                "<code>npm --prefix webapp install &amp;&amp; npm --prefix webapp run build</code>"
                ", then restart. API is live under <code>/api</code>.</p>")

    return app


def serve(host: str = "127.0.0.1", port: int = 8400, runs_root="runs",
          open_browser: bool = True) -> None:
    import uvicorn
    app = create_app(runs_root)
    if open_browser:
        import threading, webbrowser, time
        threading.Thread(
            target=lambda: (time.sleep(1.0), webbrowser.open(f"http://{host}:{port}")),
            daemon=True).start()
    uvicorn.run(app, host=host, port=port, log_level="info")
