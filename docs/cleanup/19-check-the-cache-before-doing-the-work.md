# Step 19 — Check the cache before doing the work

**Status: DONE** — 19a `4a39773`, 19b `8d6073c`. Both findings landed.

**Tier.** Core.

**Goal.** Make a cache hit cost what a cache hit should cost. Both export paths currently do
the expensive thing *first*, then discover they didn't need to.

**Blocked by.** Step **16** — finding 2 changes a cache key, so a mistake here silently
serves the wrong clip, which is the worst bug class in this repo.

**Size.** M.

> Line numbers are a snapshot — re-grep before relying on one.

---

## 1. ~~The whole-song export runs full signal analysis before checking the file exists~~ — **DONE**

> ✅ Landed in `4a39773`. Measured, 12 segments × 15 s, 3-minute stems, 1080p, repeat export:
>
> | | before | after |
> |---|---|---|
> | cold caches | 567.0 ms (12 extractions) | 0.2 ms (0) |
> | warm caches | 2.3 ms (12 extractions) | 0.1 ms (0) |
>
> ⚠ **The framing below overstates it, and the correction is worth keeping.** This step
> described "full STFT / HPSS / beat-track signal extraction over every segment", which reads
> as minutes. `signals.py:28-76` keeps bounded LRU caches (`_STFT_CACHE` / `_HPSS_CACHE` /
> `_BEAT_CACHE`, cap 4) keyed per stem + fps, so the real cost is roughly **one cold analysis
> per stem, not one per segment** — and in a long-lived server the second repeat export finds
> them warm anyway. 0.57 s saved, scaling with signal count and song length. Worth having,
> and worth stating accurately.
>
> The `total` is derived by `song_total_frames` through `graph_render._clip_dims`, which its
> own docstring already advertises for this exact use ("`render_stream`'s cache-hit path,
> which needs the frame total to report progress but has nothing to resolve"). That is also
> the one place the 0.5 s duration floor lives, so the two derivations cannot drift.

`song_render.py:256`:

```python
out_path = paths.ANIM_DIR / f"song_{_export_hash(job_id, segments, lyric_lines, export)}.mp4"
url = f"/fluid/{out_path.name}"
ctx = build_plan(job_id, segments, lyric_lines, export, stem_audio_path)
...
try:
    if out_path.exists():  # identical export already rendered
        render_cache.touch(out_path)
        ...
        return url
```

`build_plan` (`:131`) constructs a `Dag` per segment and calls `dag.field_layers(oid)`, which
runs `build_params` → `_make_value_resolver` → `_signal_curve` for every bound port in every
segment. **Signal extraction — STFT, HPSS, beat-tracking over the whole song — happens
there**, as its own docstring says.

The path name is already computed on line 254. So on a repeat export — the common case after
a UI reload, or any re-export of an unchanged project — the user waits through the entire
analysis pass to be handed a file that was sitting on disk the whole time.

`ctx` is needed for exactly one thing on that branch: `ctx["total"]`, passed to `on_progress`.
And `total` is `sum(max(1, round(dur * fps)))` over the segments — derivable from each
segment's `start`/`end` plus the export fps, with no DAG and no analysis.

**The change:** extract the total computation, check `out_path.exists()` against it, and only
then `build_plan`.

### ⚠ Do not break the drain

The `try` at `:262` and its outer `finally` exist *specifically* so the cache-hit early
return drains its decoders. The comment at `:257–261` is explicit — that return "leaked a
decoder per video card on EVERY repeat export", and the `finally` was the fix.

The reorder keeps this true trivially, because on the cache-hit path `build_plan` never runs
and there is nothing to drain. But the structure must make that obvious to the next reader:
keep `build_plan` and the `try` adjacent, and **update the comment** — it currently explains
a hazard that will no longer exist on that branch. A stale comment describing a fixed leak is
how the leak comes back.

## 2. The HD stylize cache key is derived from the render it is supposed to avoid

`routes/export.py:479`:

```python
frames, strength, fps, control = graphmod.stylize_source(...)   # full DAG render at export grid
sample = frames[:: max(1, len(frames) // 8)].tobytes()
key = hashlib.sha256(...).hexdigest()[:16]
...
if not dest.exists():   # ← the cache check, 17 lines AFTER the expensive part
```

The key is a content hash of the *rendered frames*, so producing it requires the render. Every
re-export of an unchanged project re-simulates the stylize input at export grid purely to
compute an identifier it then discards.

**The identity already exists cheaply.** `graph_hash.output_hash` over the stylize node's
upstream subgraph is precisely "what would change these frames" — and the repo already uses
it this way: `_montage_slot_key` (`graph_render.py:944`) solves the identical problem for
montage slots, caching them in *local* time so retiming the trigger reuses every slot.

Key on `output_hash` of the upstream subgraph plus the stylize parameters (`strength`,
`control`, fps, grid dims), and check `dest.exists()` **before** calling `stylize_source`.

### ⚠ This changes cache identity

Two consequences to handle deliberately:

- **Existing `hd-stylize-*.mp4` files become unreachable.** They are keyed the old way. They
  are not *wrong*, just orphaned — confirm `cache_gc` reclaims them (it sweeps by
  reachability, so it should) rather than leaving them to accumulate forever.
- **A frame-content hash and a graph hash are not equivalent.** The content hash collapses two
  different graphs that happen to render identically; the graph hash does not. That direction
  is safe (a spurious miss costs time, not correctness). The dangerous direction is the
  reverse — a graph hash that misses an input the frames depend on. **Enumerate what
  `stylize_source` reads** and confirm `output_hash` covers all of it, especially anything
  from the export settings rather than the graph.

---

## Verification

1. Time a repeat whole-song export (step 16's benchmark case 4). Before: full analysis. After:
   near-instant. **Report both numbers.**
2. A test that `build_plan` is not called on the cache-hit path — monkeypatch it to raise,
   assert the cached export still returns its URL. That is the assertion that cannot pass by
   accident.
3. `tests/test_dag_lifetime.py`-style check that the reordered path still leaves no open
   decoders (the step-06 guarantee).
4. For finding 2: render a stylize export, re-export, assert the second did not call
   `stylize_source`. Then change something upstream of the stylize node and assert it *did* —
   the miss direction is the one that matters for correctness.

## Status

| Finding | State |
|---|---|
| 1. song export plans before checking | ✅ `4a39773` — 567 ms → 0.2 ms cold |
| 2. HD stylize key derived from the render it avoids | **not started** |

## Acceptance criteria

- Neither path does its expensive work before its `exists()` check. ✅ for 1.
- `ctx["total"]` and the derived total agree. ✅ — the test asserts against `build_plan`'s own
  `ctx["total"]` rather than a literal, so the two derivations are pinned together rather
  than merely both being right today.
- The step-06 drain guarantee still holds, with the comment updated to match. ✅ — and the
  guarantee got *stronger*: the test now asserts a cache hit constructs no `Dag` at all,
  because what is never opened cannot leak. The old test asserted the mechanism (that
  `close` was called), which the fix made unsatisfiable.
- Old `hd-stylize-*` files are confirmed GC-reachable. — pending, belongs to finding 2.

## Risks

- ~~**The derived total drifting from `ctx["total"]`**~~ — addressed by routing through
  `_clip_dims` (the single home of the duration floor) and by pinning the two in a test.
- **`output_hash` missing an input** — the one way finding 2 serves a stale clip. Verify by
  enumeration, not by testing one case. ⚠ Still live, and note what makes it awkward:
  `strength` and `fps` currently arrive as *return values of the expensive call*
  (`graph_render.py:582-583`), so finding 2 requires splitting `stylize_source` into a cheap
  describe half and an expensive render half before the key can be computed at all.
- **Believing a step file's magnitude claim.** Finding 1's was overstated by roughly two
  orders of magnitude (see the correction above), and step 18's were wrong twice. Measure
  finding 2 before writing it.
