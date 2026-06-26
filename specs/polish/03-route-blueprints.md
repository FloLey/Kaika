# 03 — Split `app.py` into Flask blueprints

> `backend/app.py` is ~600 lines: app setup + every route (upload, segment, jobs,
> logs, projects, extract, fluid, animate, media) + shared helpers + background
> workers, all in one module. Adding a route means scrolling one big file. This
> reorganises routes into **blueprints** behind a shared helpers module, with **zero
> behaviour change** — guarded the whole way by the route smoke tests. Backend-only;
> independent of the TS specs.

## Locked decisions

1. **Blueprints by domain.** `backend/routes/{uploads,projects,animation,media}.py`,
   each a `Blueprint`. `app.py` becomes: app + config + the global error handler +
   `register_blueprint(...)` calls + `__main__`.
2. **Shared helpers move OUT of `app.py`** into a module so blueprints import them
   without a cycle back through the `app` object (a blueprint importing `app` which
   imports the blueprint = circular). `web.py` already proved this for the HTTP
   helpers.
3. **No URL / response changes.** Same paths, methods, status codes, JSON shapes.
   The frontend and `vite.config.js` proxy are untouched. The route smoke tests
   (`test_app_routes.py`) must stay green at every step.

## Architecture this builds on

- `backend/web.py`: `json_body` (the dict-body 400 decorator) + `validate_audio_params`
  — already the shared HTTP layer the routes use.
- `tests/test_app_routes.py`: Flask `test_client` smoke (index, `json_body` 400s,
  404s) — `importorskip("torch")`, so it runs locally and skips in minimal CI. This is
  the safety net for the move.
- The global `@app.errorhandler(Exception)` (returns JSON, logs 500s) — stays in
  `app.py`, applies to all blueprints.
- `backend/jobs.py` (`submit`/`get`/`set_step`) — already a separate module; the
  background workers (`_process_upload`, `_process_segment`, `_finalize_proposal`)
  move next to the routes that submit them.

## Current routes → target blueprint

| Blueprint | Routes |
|---|---|
| `uploads` | `POST /upload`, `GET /jobs/<id>`, `POST /segment` (+ `_process_upload`/`_process_segment`/`_finalize_proposal` workers) |
| `projects` | `GET /projects`, `GET/PUT/DELETE /projects/<id>` |
| `animation` | `POST /extract`, `POST /fluid`, `POST /animate` |
| `media` | `GET /fluid/<name>`, `GET /audio/<id>/<stem>`, `GET /spectrogram/<id>/<stem>`, `GET /` (index) |

Shared helpers to extract: `stem_audio_path`, `find_stem_dir`, `lyrics_path`,
`download_youtube_audio`, `make_spectrogram`, `serve_range`, the path constants
(`DATA_DIR`/`UPLOAD_DIR`/`SEPARATED_DIR`/`SPECTRO_DIR`/`ANALYSIS_DIR`/`FLUID_DIR`),
and `STEMS`/`COLORMAPS`/`DEVICE`/timeouts.

---

## Step 1 — Extract shared helpers + paths to a module

**Goal.** A cycle-free home for everything routes share.

**Files.** New `backend/media.py` (audio/spectrogram/serve helpers + `STEMS`/
`COLORMAPS`/`DEVICE`) and/or `backend/paths.py` (the `DATA_DIR` tree + `mkdir`). Move
the helper bodies out of `app.py`; `app.py` (and later the blueprints) import them.

**Design.** Pure cut/paste of `make_spectrogram`, `find_stem_dir`, `stem_audio_path`,
`download_youtube_audio`, `lyrics_path`, `serve_range` + constants. Keep signatures
identical. `app.py` imports them back so it still works at this intermediate step.

**Reuse.** `config.py` (N_FFT/HOP/…); `fluid`/`signals`/`graph`/`db` unchanged.

**Acceptance.** `app.py` imports the helpers from the new module; everything still
runs; `pytest` green.

**Verification (two-audience).** *Agent:* `pytest -q` + `ruff` green; `python -c
"import backend.app"` clean. *User:* `make dev` boots; `/projects` returns JSON.

**Risks.** Import order (matplotlib `Agg` before pyplot) — keep that in whichever
module imports pyplot. Watch for a helper that closes over an app-level constant;
move the constant too.

---

## Step 2 — Create the blueprints, move route bodies

**Goal.** Each domain's routes live in `backend/routes/<domain>.py` as a `Blueprint`.

**Files.** New `backend/routes/__init__.py`, `uploads.py`, `projects.py`,
`animation.py`, `media.py`. Move each route function (+ its workers) verbatim, swapping
`@app.route` → `@bp.route` and importing helpers from step 1's module + `web.py`.

**Design.** `bp = Blueprint("animation", __name__)`. The `@json_body`-decorated routes
move as-is. No `url_prefix` (paths are absolute today: `/animate`, `/extract`); keep
them at the root so URLs don't change. Cross-route helpers (e.g. `animation` needs
`stem_audio_path`) come from `media`/`paths`.

**Reuse.** `web.json_body`/`validate_audio_params`; `jobs.submit`; `graph.render`.

**Acceptance.** All routes defined on blueprints; none left on `app` directly.

**Verification (two-audience).** *Agent:* `pytest` green (test_app_routes still hits
every smoke path). *User:* deferred to step 3 (registration).

**Risks.** `@json_body` preserves the endpoint name via `@wraps`; ensure no two
blueprints register the same endpoint name. The background workers must import the
helpers, not `app`.

---

## Step 3 — `app.py` = factory + error handler + register

**Goal.** Thin `app.py` that assembles the app.

**Files.** `backend/app.py`.

**Design.** Keep: `app = Flask(__name__)`, config (`MAX_CONTENT_LENGTH`), the
`db.init_schema()` boot (catching `db.DBUnavailable`), the global error handler, and
`__main__`. Add `for bp in (...): app.register_blueprint(bp)`. Optionally wrap in a
`create_app()` factory (nice for tests) but keep the module-level `app` so
`python -m backend.app` and `test_app_routes` still work.

**Reuse.** The existing error handler + `logbus.configure()`.

**Acceptance.** `app.py` is short; the app behaves identically.

**Verification (two-audience).** *Agent:* `pytest`; `ruff`; `python -m backend.app`
boots. *User:* `make dev` → full end-to-end: upload → segment → signals (`/extract`)
→ animate (`/animate`) → clip plays. Identical to before.

**Risks.** If you add `create_app()`, `test_app_routes` imports `app` — expose a
module-level `app = create_app()` so the import path is unchanged.

---

## Step 4 — Expand the route smoke tests

**Goal.** Lock the surface now that it's split.

**Files.** `tests/test_app_routes.py`.

**Design.** Add one smoke per blueprint that doesn't need a DB/audio: e.g. each
blueprint's simplest route returns its expected status; `/projects` shape (skips on no
DB); a 404 on an unknown media path. Keep `importorskip("torch")`.

**Acceptance / Verification.** *Agent:* `pytest -q`, `ruff` green; coverage spans all
four blueprints. *User:* none beyond step 3's e2e.

**Risks.** Routes touching the DB still skip without one — assert status on the
no-DB-needed paths only.

---

## v1 boundary & extension points

**This spec:** routes are domain blueprints behind a shared helpers module; `app.py`
is a thin factory. **Designed-for:** a new endpoint = add to the right blueprint (or a
new one + one `register_blueprint`); `web.py` decorators apply uniformly. No URL/JSON
contract changes, so the frontend is untouched.
