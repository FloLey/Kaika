# 02 — Dedup refactors

> The review found the same logic maintained in multiple places, already drifting:
> the render start/poll/backoff loop exists **three times** in the frontend
> (`useStreamRender`, an inline copy in `OutputNode`, a variant in `ExportStep`),
> the block-streaming encoder loop **twice** in the backend (`render_stream`,
> `render_song`), and the port-binding resolution idiom **four times**. Three
> commits: backend (§B), frontend streaming/playback (§F1–F3), `jobIdOf` (§F4).
> Land before the Transform card (spec 04) so it builds on the shared helpers.

## Locked decisions

1. **`ExportStep` keeps its own poll loop** (§F3). Its `pollRender` differs on
   purpose: flat 500 ms cadence, sessionStorage resume across remounts,
   never-cancel-on-unmount, and a different status API (`getExportStatus`).
   Forcing it into `useStreamRender` would be a worse abstraction; it adopts only
   `usePreservePlayback`. Say so in the commit message.
2. **The preview-slot semaphore stays module-global and outputs stay outside it.**
   `useStreamRender.ts:9-44` caps concurrent card previews; `OutputNode`
   deliberately streams outside that cap. Unifying OutputNode onto the hook must
   preserve this via an explicit `{ slot: false }` option — outputs must never
   starve behind preview slots.
3. **Behaviour-preserving only.** No hash, no render semantics, no API shape
   changes anywhere in this spec — `RENDER_VERSION`/`GRAPH_VERSION` untouched.

## B — Backend (one commit)

### B1 — `resolve_port` in `graph_common.py`

The idiom "`const` → value, else `lo + (hi-lo) * resolve(nodeId)`" is written out
four times:

- `graph_render.py:106-119` — `build_params` (fluid ports)
- `graph_render.py:281-295` — `Dag._fx_params` (per-card FX/source ports)
- `graph_modulators.py:54-60` — `_resolve_node_color.port_val`
- the lyrics colour path (same module — confirm while editing)

Add to `backend/graph_common.py` (the leaf module both importers already use):

```python
def resolve_port(binding, pmin, pmax, pdef, resolve):
    """One modulatable port -> native units. const/unbound -> float; a node
    binding -> lo + (hi-lo) * resolve(nodeId) (a 0..1 np.float32 curve)."""
    if not binding or binding.get("kind") == "const":
        return float(binding["value"]) if binding else float(pdef)
    lo = float(binding.get("lo", pmin))
    hi = float(binding.get("hi", pmax))
    return lo + (hi - lo) * resolve(binding["nodeId"])
```

Each call site keeps its own post-processing (that's where they genuinely
differ): `build_params` does `v.tolist() if hasattr(v, "tolist") else v`;
`_fx_params` does `np.full(nframes, v, np.float32) if np.isscalar(v) else
v.astype(np.float32)`; the colour resolvers use the scalar/curve as-is.

### B2 — `StreamEncoder` in `fluid.py`

`song_render.render_song` (`song_render.py:184-219`) and
`graph_render.render_stream` (`graph_render.py:965-998`) both hand-roll: lazy
`open_stream_encoder` on the first block, `enc.stdin.write` with
`BrokenPipeError → RuntimeError(encoder_error(enc))`, finalize
(`stdin.close`/`wait`/raise on nonzero returncode), `close_encoder` in `finally`.

Add a small class in `backend/fluid.py` below `open_stream_encoder`:

```python
class StreamEncoder:
    """The shared write/finalize/close protocol around open_stream_encoder.
    Lazy: nothing opens until the first write."""
    def __init__(self, path, fps, gw, gh, w, h): ...
    def write(self, frames) -> None       # opens lazily; BrokenPipeError -> RuntimeError(encoder_error)
    def finalize(self) -> None            # close stdin, wait, raise on rc != 0
    def close(self) -> None               # for finally: close_encoder, no-op if finalized
```

Both call sites switch to it and keep everything that actually differs: their
loops, cancellation checks, progress URLs, promote/mux steps, and the
`shutil.rmtree(scratch)` in `finally`. `song_render.py` can then drop its
`close_encoder`/`encoder_error` imports.

### B3 — `/resolve` + `/resolve-points` twins

`backend/routes/animation.py:70-92` and `:95-117` are copy-paste twins: same
missing-field 400, same `_bad_job` 404, same three-branch `try/except`; only the
resolver call differs. Extract one `_resolve_endpoint(body, fn)` holding the
checks and error handling; the two routes become two-liners calling it with
`graphmod.resolve_node_curve` / `graphmod.resolve_node_points`. Their error
handling can no longer drift apart.

### B tests

Existing coverage exercises all three seams: `test_stream_render.py`,
`test_song_render.py` (encoder loops), `test_fluid_modulation.py`,
`test_graph_modulators.py` (port resolution), `test_resolve_points.py` (routes).
Add nothing unless the diff exposes a gap.

## F — Frontend

### F1 — `usePreservePlayback` + `useSyncedPlayback` (commit 4)

Two effects are copied verbatim between preview surfaces:

- **Preserve playback position** across a growing `videoUrl` (save on
  `timeupdate`, restore on `loadedmetadata`): `OutputNode.tsx:162-177`,
  `ExportStep.tsx:141-156`, `StreamPreview.tsx:70-85`.
- **Synced/idle playback** (idle loop + watchdog + segment-clock slave,
  ~45 lines): `OutputNode.tsx:180-232`, `StreamPreview.tsx:88-124`.

New hooks in `frontend/src/components/animation/nodes/`:

```ts
usePreservePlayback(videoRef: RefObject<HTMLVideoElement>, videoUrl: string): { reset(): void }
useSyncedPlayback(videoRef, videoUrl, groupPlaying, groupClock, segStart): void
```

`reset()` zeroes the saved position — OutputNode calls it when its `renderKey`
changes, ExportStep in `generate()`. Adopt in all listed sites; the JSX stays
unchanged.

### F2 — `useStreamRender` gains `{ slot?: boolean }`; OutputNode drops its copy (commit 4)

`OutputNode.tsx:82-157` is a near-verbatim ~75-line copy of `useStreamRender`
(same 250→1000 ms poll backoff, same `reqId`/`activeRender` guards, same
404-means-gone handling) that predates the hook's extraction — the only real
difference is that it doesn't take a preview slot.

- `useStreamRender.ts`: add an options arg `{ slot?: boolean }` (default
  `true`). `slot: false` skips `acquireSlot`/`releaseSlot` entirely; the
  semaphore itself is untouched.
- `OutputNode.tsx`: delete the inline effect and the local
  `videoUrl/busy/error/progress/reqId/activeRender/lastTime` state; use
  `useStreamRender(ctx, node.id, renderKey, renderable, { slot: false })` plus
  the two F1 hooks.

Removes ~120 lines from OutputNode and returns the streaming logic to a single
implementation (locked decision 2 preserved by construction).

### F3 — ExportStep (commit 4, partial adoption only)

Per locked decision 1, `ExportStep.tsx:81-125`'s `pollRender` is kept. It adopts
`usePreservePlayback` only (its copy at `:141-156`).

### F4 — `jobIdOf` (commit 5)

`typeof job === "string" ? job : (job as {job_id?: string}).job_id` is repeated
in `useResolvedCurve.ts:22`, `useResolvedPoints.ts:19`, `ImagegenNode.tsx:43`.
Add to `components/animation/nodes/nodeProps.ts`:

```ts
export const jobIdOf = (job: unknown): string | undefined =>
  typeof job === "string" ? job : (job as { job_id?: string } | undefined)?.job_id;
```

and use it at all three sites (after spec 01 §D lands in `useResolvedPoints`).

### F tests

`exportStep.dom.test.tsx` and `animationCanvas.dom.test.tsx` must pass
unchanged — that's the point of behaviour-preservation. Add a cheap
`useStreamRender` assertion that `slot: false` never touches the semaphore if
the hook's test file makes it easy; otherwise the OutputNode DOM tests cover it.

## Verification

- Commit 3: `make test-backend`, `make lint`.
- Commits 4–5: `make test-frontend`, `npx tsc --noEmit`, `make lint`; live
  check (`make dev`): open a project with several outputs + card previews —
  outputs still start streaming immediately even when preview slots are
  saturated, and a growing preview keeps its playhead across chunk swaps.

## Out of scope

- Merging `jobs.py`/`render_jobs.py` into one manager (the duplication is
  acknowledged in both files; the two-manager split is a documented design
  choice — GPU work must never overlap renders).
- Any change to poll cadences, debounce windows, or the slot cap.
