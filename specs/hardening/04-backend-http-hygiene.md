# 04 — Backend HTTP-layer consistency + naming

> After the blueprint split the routes work, but the HTTP layer is uneven: `/segment`
> hand-rolls `request.get_json(silent=True) or {}` instead of the `@json_body` guard the
> other POST routes use; error responses come in three shapes (`{error}`, Werkzeug's
> `abort()` 404, and `{error: "Type: msg"}`); client-supplied `job_id` is never validated
> for shape; and `backend/media.py` (helpers) collides by name with
> `backend/routes/media.py` (blueprint). This standardizes the validation + error surface
> and removes the name clash. **No URL, method, status, or JSON-contract change** — guarded
> by the route smoke tests. Backend-only; independent of the frontend specs.

## Locked decisions

1. **`web.py` is the shared HTTP layer** — add `validate_job_id` and `error_response`
   there next to `json_body` / `validate_audio_params`.
2. **`@json_body` on every POST that reads a JSON body**, including `/segment`. The
   decorator already returns a uniform `400 {"error": "body must be a JSON object"}`.
3. **`job_id` validation is fail-fast consistency, not a security fix.** Flask's default
   `<string>` converter already excludes `/`, so the media routes can't be path-walked
   (see PLAN.md non-goals). Validating the `^[a-f0-9]{8}$` shape just rejects nonsense
   early with a clear 400/404 instead of a downstream `None`/`abort`.
4. **One error shape:** `{"error": <message>}` with the right status, via
   `error_response(msg, code)`. The global `@app.errorhandler` (which already emits
   `{"error", "code"}` for `HTTPException`s) stays as the catch-all — this just makes the
   *route-level* returns uniform.
5. **Rename the blueprint module, not the helpers.** `backend/routes/media.py` →
   `backend/routes/serving.py` (it serves the index + media files); `backend/media.py`
   (the audio/spectrogram helpers) keeps its name. Only `routes/__init__.py` imports it.
6. **No behaviour change.** Same routes, statuses, and payloads; the smoke tests
   (`tests/test_app_routes.py`) stay green at every step.

## Architecture this builds on

- `backend/web.py` — `json_body` (the dict-body 400 decorator) + `validate_audio_params`.
  The home for the two new helpers.
- `backend/routes/uploads.py` — `/segment` uses `request.get_json(silent=True) or {}`
  then checks `job_id` manually; `/upload` validates the multipart form inline.
- `backend/routes/animation.py` — `/extract`, `/fluid`, `/animate` already use
  `@json_body`; they return `{"error": str(e)}` (400) and `{"error": f"{type(e).__name__}:
  {e}"}` (500) — the type-prefixed 500 is the catch-all and can stay.
- `backend/routes/media.py` — the blueprint to rename (`index`, `fluid_file`, `audio`,
  `spectrogram`); imports helpers from `..media` + paths from `..paths`.
- `backend/routes/__init__.py` — `all_blueprints` imports the four blueprints.
- `backend/db.py` — wraps the scalar `SCHEMA_VERSION` in `Jsonb()` (inconsistent with the
  dict/list columns that genuinely need it); hardcodes the `"review"` default step.
- `tests/test_app_routes.py` — Flask `test_client` smoke (`importorskip("torch")`) over
  every route; the safety net for these moves.

---

## Step 1 — Add the shared helpers to `web.py`

**Goal.** One place for job-id validation + error responses.

**Files.** `backend/web.py`.

**Design.**
```python
import re
_JOB_ID_RE = re.compile(r"^[a-f0-9]{8}$")   # uuid4().hex[:8]

def validate_job_id(job_id: str | None) -> bool:
    return bool(job_id and _JOB_ID_RE.match(job_id))

def error_response(message: str, code: int = 400):
    return jsonify({"error": message}), code
```
Keep signatures tiny and import-light (no app/blueprint imports → no cycle).

**Reuse.** Mirrors `validate_audio_params`'s "pure helper in `web.py`" pattern; the job-id
format is exactly what `uploads.py` mints (`uuid4().hex[:8]`).

**Acceptance.** `from backend.web import validate_job_id, error_response` works; unit-level
checks pass.

**Verification (two-audience).** *Agent:* `pytest -q` + `ruff` + `black --check` green;
`python -c "import backend.app"` clean. *User:* none.

**Risks.** None — additive.

---

## Step 2 — Apply `@json_body` + validation + the error shape across routes

**Goal.** Uniform input handling and error responses.

**Files.** `backend/routes/{uploads,animation,projects,media}.py`.

**Design.**
- `/segment`: add `@json_body` (its body becomes the decorator arg), drop the manual
  `get_json`; validate `job_id` with `validate_job_id` → `error_response("invalid job_id",
  400)` on failure; keep the existing 404 when the job's audio is absent.
- Any route taking a client `job_id` in the **body** (e.g. `/extract`, `/animate`) gets the
  same `validate_job_id` fail-fast before the `stem_audio_path`/DB lookup. (Routes taking
  `job_id` in the **URL** are already `/`-safe; add validation only if cheap and clarifying.)
- Replace ad-hoc `return jsonify({"error": ...}), code` with `error_response(...)` so the
  shape is identical everywhere. Leave the global error handler and the sync routes'
  500-path (`{type}: {msg}`) as-is.

**Reuse.** `json_body`, `validate_job_id`, `error_response`, `validate_audio_params`.

**Acceptance.** No route hand-rolls `get_json(...) or {}`; every route-level error goes
through `error_response`; statuses/paths unchanged.

**Verification (two-audience).** *Agent:* `pytest -q` (smoke tests still pass — same
statuses) + `ruff` + `black --check`; spot-check `/segment` with `json=[1,2]` → 400 and a
bad `job_id` → 400. *User:* `make dev` → upload → segment → extract → animate all still
work (identical responses).

**Risks.** `@json_body` changes `/segment`'s signature (now takes the parsed body) — update
the function and any internal reference. A too-strict `validate_job_id` placement could
reject a path the frontend actually sends — only validate where the value is a real 8-hex
job id.

---

## Step 3 — Rename the blueprint module to kill the `media` clash

**Goal.** No two `media` modules.

**Files.** `git mv backend/routes/media.py backend/routes/serving.py`;
`backend/routes/__init__.py` (update the import + `all_blueprints`).

**Design.** Pure rename + import update. The `Blueprint("media", __name__)` name can stay
(`media` is the domain) or become `"serving"` — keep `"media"` to avoid touching endpoint
names (`url_for` isn't used, but no reason to churn). Only `routes/__init__.py` references
the module path.

**Reuse.** The blueprint registration loop in `routes/__init__.py`.

**Acceptance.** `backend/routes/serving.py` exists; no `backend/routes/media.py`;
`import backend.app` clean and the route map is identical.

**Verification (two-audience).** *Agent:* `python -c "import backend.app; print(sorted(r.rule for r in backend.app.app.url_map.iter_rules()))"` → byte-identical to before; `pytest` green. *User:* none.

**Risks.** A missed import path → ImportError at boot; the `import backend.app` check
catches it immediately.

---

## Step 4 — `db.py` tidy + expand the route tests

**Goal.** Remove the two small `db.py` inconsistencies and lock the new behaviour.

**Files.** `backend/db.py`; `tests/test_app_routes.py`.

**Design.**
- Drop `Jsonb()` around the scalar `SCHEMA_VERSION` (store it plain; only dicts/lists need
  `Jsonb`). Confirm `migrate_project_data`'s `== SCHEMA_VERSION` comparison still holds.
- Add `DEFAULT_STEP = "review"` and use it in both the schema default and the INSERT.
- Tests: assert `/segment` with a non-object body → 400 (now via `@json_body`); a malformed
  `job_id` → 400; the index + media routes unchanged. Keep `importorskip("torch")`.

**Reuse.** The existing `test_app_routes.py` fixtures (`client`, the no-DB-needed asserts).

**Acceptance.** `db.py` has no scalar-in-`Jsonb` and a single `DEFAULT_STEP`; new smoke
tests pass.

**Verification (two-audience).** *Agent:* `pytest -q` + `ruff` + `black --check` green;
coverage spans the changed routes. *User:* save a project, reload it — segments/output
persist exactly as before (schema unchanged).

**Risks.** The `Jsonb` change touches persistence — verify a round-trip (`save_segments`
→ `get_project`) still reads `schema_version` back as the int it compares against.

---

## v1 boundary & extension points

**This spec:** every JSON route validates via `@json_body` + `validate_job_id` and errors
through one `error_response` shape; the `media` module-name clash is gone; `db.py` is
consistent. **Designed-for:** a new endpoint reuses the same three helpers and inherits the
uniform contract. **Out of scope (PLAN.md non-goals):** rate-limiting, job persistence, and
treating `validate_job_id` as a security boundary — Flask routing already blocks traversal;
this is consistency, not a hole being closed.
