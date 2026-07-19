# Step 06 — Drain the render DAG at every entry point

**Goal.** Make `render()` release what it opens, so step 07's conversions stop leaking
ffmpeg decoders.

**Blocked by.** Step 02.

**Gates.** Step 07 is **unsafe** without this. Not "nicer with" — unsafe.

**Size.** Small diff. It gets its own step because the existing suite is structurally
blind to the bug, so the test has to land with the fix and be watched failing.

> Line numbers are a snapshot — re-grep before relying on one.

---

## The hole

`Dag` tracks two cleanup lists (`graph_render.py:191-192`):

```python
self._cache_writers: list = []  # discard() for incremental frame caches (cancel cleanup)
self._closers: list = []        # persistent per-node resources (e.g. VideoClip decoders)
```

They are drained in exactly one place — `stream_blocks`' `finally` (`:478-483`):

```python
for discard in self._cache_writers:   # drop partial caches (no-op if committed)
    ...
self._cache_writers.clear()
for close in self._closers:           # reap persistent decoders (also on cancel)
    ...
self._closers.clear()
```

**`render()` (`:1968`) has no `try/finally` at all.** Three block handlers register
`clip.close` — `_slideshow_block` (`:1723`), `_video_block` (`:1817`), `_stylize_block`
(`:1862`) — plus a cache discard at `:1767`. Anything that reaches those handlers through
the synchronous path leaks the decoder.

## Why nothing catches it

`test_card_impact.py:124` — `test_whole_clip_matches_the_block_stream`, the repo's parity
guard and the obvious candidate — calls `_Dag(...).video()` and `.stream_blocks()`
**directly, constructing a fresh `Dag` per call**. It never invokes `render()`.

So the one test that exercises both paths side by side stays green straight through the
leak. That is the whole reason this is a separate, gated step rather than a line inside
step 07: **converting more cards to `_whole_from_block` moves `clip.close` registrations
onto the path that never drains, and the suite will not say a word.**

---

## The change

Give `Dag` a single drain path and call it from both entry points:

- a `close()` method holding the `:478-483` body, and `__enter__` / `__exit__` so callers
  can use `with`
- `stream_blocks`' `finally` calls it (behaviour unchanged — this is a pure move)
- `render()` (`:1968`) gets the `try/finally` it never had

Keep the drain order: cache writers before closers, matching today. Keep the per-item
exception tolerance too — a failing `close()` must not prevent the rest from running, and
must not mask the original exception if the body already raised.

## The test — must land in this commit

Nothing existing will catch a regression here, so:

1. Render a graph containing a video card **through `render()`** (not through `_Dag`
   directly — that is the mistake the current parity test makes).
2. Assert `dag._closers` and `dag._cache_writers` are empty afterwards.
3. Assert the same on the **exception** path: make a handler raise mid-render and confirm
   the drain still ran and the original exception still propagates.

Name the test so its purpose survives: `test_render_drains_the_dag_like_stream_blocks_does`,
with a comment pointing at why `test_card_impact` cannot cover it.

---

## Acceptance criteria

1. Remove the new `finally` from `render()` → the drain test goes red.
2. Make a `close()` raise → the remaining closers still run, and the test proves it.
3. `test_card_impact.py::test_whole_clip_matches_the_block_stream` stays green (this step
   changes no pixels).
4. Manually: render a segment with a video card via `make dev` and confirm no orphaned
   ffmpeg processes survive (`pgrep ffmpeg` before and after).

## Risks

- **Double-close.** If a handler already closes its own clip, `close()` runs twice. Verify
  the underlying decoder tolerates it, or make the drain idempotent.
- **Draining too early** in a path that returns a lazily-evaluated frame generator. Check
  whether any handler's return value still reads from a closed decoder — this is the one
  way this "obviously safe" change can break rendering, so look before committing.
