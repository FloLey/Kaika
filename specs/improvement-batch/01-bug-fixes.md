# 01 — Bug fixes

> Two confirmed user-visible backend bugs (both `isalnum()` serving gates rejecting
> names the HD-export path generates) and two latent frontend bugs (an unaborted
> poll loop and a stale-closure asymmetry between twin hooks). Two commits:
> backend (§A+§B), frontend (§C+§D).

## A — HD-export assets are unserveable and undeletable

### Current behaviour

The whole-song HD export regenerates image-gen assets at export resolution and
registers them in the project's asset library:

- `backend/routes/export.py:137` — `name = f"hd-{key}.png"`, id `hd-{key}`
  (`key` = 16 hex chars), saved to `ASSETS_DIR/<job>/` and `db.add_asset`-ed
  (`export.py:149-153`).
- `backend/routes/serving.py:88` — `asset_file` rejects any name whose stem isn't
  pure-alnum: `not name.split(".")[0].isalnum()` → 404. `hd-…` contains a hyphen.
- `backend/routes/uploads.py` (asset DELETE, ~:115) — same gate on the id:
  `asset_id.isalnum()` → 400 for `hd-…`.

Every *other* asset uses a bare sha16 stem (alnum), so only the HD-export path
breaks the invariant. Net effect: HD assets render fine inside the export (the
renderer reads the disk path directly), but their **library thumbnails 404** and
they **cannot be deleted** from the 📚 asset library.

### Fix: relax the validators — do NOT rename the files

Renaming new assets to `hd<key>` would strand every *existing* `hd-<key>` DB row
and on-disk file (still unserveable, still undeletable). Relaxing the gate fixes
old and new data at once. Safety is unaffected: the gate exists to block path
traversal, and a hyphen can't express one. `cache_gc.py` tracks assets by
URL→path mapping (`paths.asset_file_for_url`), so GC reachability never cared
about the hyphen.

1. **`backend/web.py`** — next to `validate_job_id`:

   ```python
   _ASSET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]*$")

   def validate_asset_id(s: str) -> bool:
       """Asset ids / file stems: alnum plus interior hyphens (the HD-export
       assets are `hd-<sha16>`). No dots or slashes — path traversal stays
       impossible."""
       return bool(_ASSET_ID_RE.match(s))
   ```

2. **`backend/routes/serving.py:88`** — replace `name.split(".")[0].isalnum()`
   with `validate_asset_id(name.split(".")[0])` (import from `..web`, which the
   blueprint already imports for `validate_job_id`).
3. **`backend/routes/uploads.py`** (asset DELETE) — replace `asset_id.isalnum()`
   with `validate_asset_id(asset_id)`.

### Tests

- `tests/test_web.py` — unit: accepts `abc123`, `hd-abc123`; rejects `""`,
  `-abc`, `a.b`, `a/b`, `../x`.
- `tests/test_assets.py` — create `hd-abc123.png` under a patched `ASSETS_DIR`
  (tests patch `backend.paths` — the standard fixture); `GET
  /assets/<job>/hd-abc123.png` → 200; `DELETE /assets/<job>/hd-abc123` → ok;
  traversal-shaped names still 404/400.

## B — Whole-song export live preview always 404s

### Current behaviour

- `backend/song_render.py:179` — `render_id = out_path.stem + uuid.uuid4().hex[:8]`
  where `out_path.stem` is `song_<hash>` (`song_render.py:170`).
- `song_render.py:194` — progress reports
  `f"/fluid/stream/{render_id}/video.mp4?n={b}"`.
- `backend/routes/serving.py:53` — `fluid_stream_file` rejects
  `not render_id.isalnum()`. The underscore in `song_` fails it, so **every
  progress-preview URL during an HD export 404s**; the user sees nothing until
  the final `/fluid/song_<hash>.mp4` exists.

The segment-preview path is unaffected: `graph_render.render_stream`'s id is
`output_hash` hex + uuid hex, already alnum.

### Fix

One line in `backend/song_render.py:179`:

```python
render_id = out_path.stem.replace("_", "") + uuid.uuid4().hex[:8]
```

`song<hash><uuid8>` passes the serving gate; the id only names the scratch dir
under `STREAM_DIR` (created at :180-182, rmtree'd in `finally`), so nothing else
references the old shape. Keep `serving.py:53` strict — it's correct; the
producer was wrong.

### Tests

- `tests/test_song_render.py` — during a small render, capture the `on_progress`
  preview URLs and assert the `/fluid/stream/<id>/` path segment `.isalnum()`
  (regression lock on the producer side).

## C — Job polling never aborted (`App.tsx`)

### Current behaviour

`lib/api.ts:218-233` — `pollJob(jobId, onStep, intervalMs, signal?)` explicitly
supports an `AbortSignal`, with a comment warning that a forgotten poll "keeps
hitting /jobs and calling setState forever". `frontend/src/App.tsx:131,140`
(upload poll, then segment poll inside `handleUpload`) pass none.
`ImagegenNode.tsx:93-97` shows the correct pattern.

Impact is bounded (during `processing` the header hides "↩ projects", so
mid-poll navigation is mostly impossible) but the loop survives HMR/unmount and
any future navigation path — and the fix is what the API already asks for.

### Fix

In `App.tsx`:

1. `const pollAbort = useRef<AbortController | null>(null);`
2. Top of `handleUpload`: `pollAbort.current?.abort(); const ac = (pollAbort.current = new AbortController());`
   pass `ac.signal` to **both** `pollJob` calls (4th arg; pass the interval
   explicitly).
3. In the surrounding `catch`: if `(e as DOMException).name === "AbortError"`,
   return silently (no `setStep("error")`).
4. Abort on unmount (`useEffect(() => () => pollAbort.current?.abort(), [])`)
   and in `toProjects()`.

### Tests

- `frontend/src/__tests__/api.test.ts` — `pollJob` with an aborted signal stops
  fetching and rejects with `AbortError`.

## D — `useResolvedPoints` stale closure

### Current behaviour

Twin hooks resolve a node's live curve/points via debounced POSTs:

- `useResolvedCurve.ts:27-30,59` — deliberately mirrors mutable inputs through
  refs (`graphRef`, `signalsRef`) and lists `segStart, segEnd` in the effect
  deps, with a "Deliberate:" comment explaining why.
- `useResolvedPoints.ts:22-47` — closes directly over `seg?.start / seg?.end /
  seg?.signals` inside the debounced `setTimeout`, but its deps are only
  `[depKey, jobId, nodeId]`. If the segment window changes without `depKey`
  changing, points resolve against a **stale segment**. Low frequency (the
  editor remounts per `segment.id`) but a real asymmetry with its twin.

### Fix

Make `useResolvedPoints` byte-for-byte follow `useResolvedCurve`'s pattern:
`graphRef`/`signalsRef` assigned every render, destructured `segStart`/`segEnd`,
POST body reads the refs' `.current`, deps `[depKey, jobId, nodeId, segStart,
segEnd]`, and carry over the "Deliberate:" comment (both hooks keep their
`eslint-disable react-hooks/exhaustive-deps` line).

### Tests

Covered by the existing resolve-points DOM tests; no new test unless the diff
uncovers a gap — the change makes the twins structurally identical, which is the
regression guard itself (a future edit to one is obviously missing from the
other).

## Verification

- Commit 1 (backend): `make test-backend`, `make lint`; then live (`make dev`) —
  HD-export an image-gen project, thumbnail loads, delete works, progress
  preview plays mid-render.
- Commit 2 (frontend): `make test-frontend`, `npx tsc --noEmit`, `make lint`.

## Out of scope

- Relaxing `serving.py:53` (the stream gate) — the producer is fixed instead.
- Migrating existing `hd-` assets — none need it once the gates accept them.
