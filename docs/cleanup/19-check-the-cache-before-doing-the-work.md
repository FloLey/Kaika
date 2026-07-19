# Step 19 — Check the cache before doing the work

**Tier.** Core.

**Goal.** Make a cache hit cost what a cache hit should cost. Both export paths currently do
the expensive thing *first*, then discover they didn't need to.

**Blocked by.** Step **16** — finding 2 changes a cache key, so a mistake here silently
serves the wrong clip, which is the worst bug class in this repo.

**Size.** M.

> Line numbers are a snapshot — re-grep before relying on one.

---

## 1. The whole-song export runs full signal analysis before checking the file exists

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

## Acceptance criteria

- Neither path does its expensive work before its `exists()` check.
- `ctx["total"]` and the derived total agree, on a multi-segment project with segments of
  differing lengths (a test with two equal segments would pass with a wrong formula).
- The step-06 drain guarantee still holds, with the comment updated to match.
- Old `hd-stylize-*` files are confirmed GC-reachable.

## Risks

- **The derived total drifting from `ctx["total"]`.** They are two computations of one number,
  which is the duplication wave 2 spent five steps removing. If the formula is non-trivial,
  factor it into one helper that `build_plan` also uses, rather than writing it twice.
- **`output_hash` missing an input** — the one way finding 2 serves a stale clip. Verify by
  enumeration, not by testing one case.
