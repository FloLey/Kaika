"""Kaika — Flask backend.

Upload a song -> separate into stems with Demucs (on the Apple Silicon GPU via
MPS) -> render a mel spectrogram per stem with librosa -> serve everything to a
single-page UI.

This module is the thin assembly point: it builds the Flask app, installs the
global JSON error handler, and registers the domain blueprints (see
``backend/routes/``). The routes themselves, the shared media helpers
(``backend/media.py``), and the path/constant tree (``backend/paths.py``) live
in their own modules so adding an endpoint never means scrolling this file.
"""

import logging
import os
import shutil
import threading
import time

from flask import Flask, jsonify, request
from werkzeug.exceptions import HTTPException

from . import db
from . import logbus
from .media import DEVICE
from .routes import all_blueprints

logbus.configure()
log = logging.getLogger("kaika")

# Flask is a pure API. The UI is always the Vite dev server (:5173).
app = Flask(__name__)
# Upload cap. 2 GB (was 200 MB): modern phone clips routinely exceed 200 MB and a
# folder upload (asset library 📁) sends them one file per request — Flask 413s
# above this BEFORE the route's own friendlier check runs. Local single-user app:
# the RAM spike of reading one such file is acceptable.
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024 * 1024

# Ensure the projects table exists. Don't hard-fail import if Postgres is down —
# the error surfaces clearly on the first request that needs the DB.
try:
    db.init_schema()
except db.DBUnavailable as e:
    log.warning("could not init the database (%s). Is Postgres up? " "`docker compose up -d db`", e)


# Request timing. Werkzeug's access line says WHAT was requested, never how long it
# took — so "the editor feels slow" was unanswerable from the log stream alone (it took
# counting request patterns by hand to find that a compact canvas was queueing one
# segment render per card). Anything slower than SLOW_REQUEST_MS is logged with its
# duration, and `?debug_timing=1` (or KAIKA_LOG_TIMING=1) logs EVERY request.
SLOW_REQUEST_MS = float(os.environ.get("SLOW_REQUEST_MS", "400"))
_LOG_ALL_TIMING = os.environ.get("KAIKA_LOG_TIMING", "0") != "0"


@app.before_request
def _start_timer():
    request.environ["kaika.t0"] = time.perf_counter()


@app.after_request
def _log_slow(resp):
    t0 = request.environ.get("kaika.t0")
    if t0 is None or request.path == "/logs":  # /logs must never log — it feeds itself
        return resp
    ms = (time.perf_counter() - t0) * 1000.0
    if _LOG_ALL_TIMING or ms >= SLOW_REQUEST_MS:
        log.info(
            "%s %s -> %s in %.0f ms",
            request.method,
            request.full_path.rstrip("?"),
            resp.status_code,
            ms,
        )
    return resp


# Every error path returns JSON (never Werkzeug's HTML page) so the frontend's
# jsonOrThrow always parses a `.error`, and unhandled failures land in the log
# stream with a traceback. The sync routes (/extract, /fluid, /animate) catch
# their own exceptions and return before reaching here.
@app.errorhandler(Exception)
def handle_unexpected(e):  # noqa: ANN001
    if isinstance(e, HTTPException):
        if e.code and e.code >= 500:
            log.error("HTTP %s on %s", e.code, request.path, exc_info=e)
        return jsonify({"error": e.name, "code": e.code}), e.code
    log.error("Unhandled exception on %s", request.path, exc_info=e)
    return jsonify({"error": f"{type(e).__name__}: {e}"}), 500


for bp in all_blueprints:
    app.register_blueprint(bp)


# Reclaim render-cache clips left over from past editing sessions, off the boot path
# (a daemon thread, fully guarded) so it never delays or crashes startup.
def _startup_cache_gc():
    try:
        from . import cache_gc

        cache_gc.sweep()
    except Exception as e:  # noqa: BLE001
        log.warning("startup cache gc failed: %s", e)


if __name__ == "__main__":
    if not shutil.which("ffmpeg"):
        log.warning("ffmpeg not found on PATH; non-WAV inputs may fail.")
    host = os.environ.get("HOST", "127.0.0.1")  # 0.0.0.0 in a container
    port = int(os.environ.get("PORT", "5000"))
    debug = os.environ.get("FLASK_DEBUG", "1") == "1"
    log.info("Kaika starting — device: %s, http://%s:%s", DEVICE, host, port)
    # Started HERE, not at import: as an import-time daemon thread it also ran inside the
    # test suite, where it could outlive a fixture's path monkeypatch and sweep the real
    # data dir using a keep-set computed against a temporary one.
    threading.Thread(target=_startup_cache_gc, name="cache-gc", daemon=True).start()
    # threaded so /jobs/<id> polling is served while a background job runs.
    # (In-memory jobs reset when the debug reloader restarts — fine for dev.)
    app.run(host=host, port=port, debug=debug, threaded=True)
