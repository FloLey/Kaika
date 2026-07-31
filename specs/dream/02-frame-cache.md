# 02 — The per-frame generation cache

> **Status: BUILT.** `backend/dream_cache.py`, `paths.DREAM_CACHE_DIR`, wired into
> `imagegen.dream_frames`, `tests/test_dream_cache.py` (19), `make clean-cache`.
>
> Two things landed slightly differently from the plan below, both recorded in code
> comments: `store()` does **not** evict (it is called once per *frame*, so globbing the
> directory each time would cost more than it saves — `dream_frames` evicts once when the
> job ends), and the pipe is now loaded **lazily**, so a fully-cached run never pays for
> 6 GB of weights at all.

**Goal:** `backend/dream_cache.py`, and `dream_frames` consulting it. After this step,
regenerating a clip whose prompts and cuts are unchanged costs zero diffusion calls, and
moving one cut costs only the frames whose prompt state actually moved.

**Prerequisites:** step 01.

## Why per-frame and not per-clip

AI Stylize caches the whole clip as one content-addressed asset, which is right for it:
its inputs are a prompt and a strength, and changing either changes every frame. Dream's
inputs are a *schedule* — and the editing gesture the card exists for is dragging a cut
around, which changes a handful of frames out of hundreds. At one diffusion call per
frame, whole-clip regeneration makes the timeline editor in step 05 unusable. The cache is
not an optimisation here; it is what makes the card's core interaction viable.

## The key

```
sha1(control_frame_hash, prompt_a, prompt_b, w_q, seed, model, H, W, scale_q)
```

- `control_frame_hash` — sha1 of the *resized* control frame's bytes. The frames are
  already in hand once the upstream clip renders, so this is free, and it buys the right
  invalidation: an upstream edit that happens to leave a given frame unchanged keeps that
  frame's cache. A still control gives identical keys across time and dedupes for free.
- `w_q`, `scale_q` — rounded to 3 decimals. Float noise from a re-resolved curve must not
  bust a key.
- **Hold frames canonicalize.** At `w == 0` the key drops `prompt_b` entirely; at `w == 1`
  it drops `prompt_a`. This is the property the whole design rests on: a cut nudge changes
  the weights of that transition's ramp frames only, so hold frames on both sides survive.
  Without canonicalization every hold frame would key against its neighbouring prompt, a
  cut nudge would invalidate two whole parts, and the cache would buy nothing.
- No `negative` — it is inert at `guidance_scale=0` (step 01).

## Storage and eviction

Mirror `fluid_cache.py`'s shape rather than inventing one: module-level `CACHE_DIR`
(`data/dream_cache`), `load(key)` / `store(key, frame)`, budget and age from env
(`DREAM_FRAME_CACHE_MAX_BYTES`, `…_MAX_AGE_DAYS`, `…_ENABLED`), and `render_cache.evict`
for the sweep — the same shared machinery `fluid_cache` uses (`render_cache.py:65`
already describes itself as serving both caches; this makes it three).

**PNG, not `.npy`.** Lossless, so a cache hit is byte-identical to a miss — which is what
makes the parity test meaningful — at roughly a third of raw size. A 576² frame is ~1 MB
raw and ~300 KB as PNG; a 300-frame segment is 90 MB rather than 300 MB.

`store` self-evicts after writing, the `fluid_cache` discipline. **Deliberately not done:**
a reachability sweep in `cache_gc.py`. That module computes keep-sets for *clips and
assets*, where wrongly evicting something costs tens of minutes of regeneration; the frame
cache is age-and-budget bounded exactly like `fluid_cache`, which `cache_gc` also does not
touch. A generated clip's `assetUrl` is already kept alive by `_assets_from` (it keeps any
node carrying an `assetUrl`), so the *output* is protected; the frame cache is scratch.

## Wiring into `dream_frames`

Per frame: build the key, `load` it, and on a hit skip the pipe entirely — still calling
`on_progress` so the card's progress bar advances at cache speed rather than appearing to
hang at 0. On a miss, generate and `store`.

The lock discipline matters: `_infer_lock` is held around *inference*, not around the
cache lookup. A run that is entirely cache hits must not serialize against a live AI
Stylize job for no reason.

Cache reads are also what make the job cheap to *re-run*, which is the intended UX: the
card's ✨ button is always safe to press, and pressing it after a small edit is fast.

## Risks

- **Key omissions are silent corruption.** Anything that changes a generated pixel and is
  not in the key produces a wrong cached frame that looks plausible. The guard is a test
  that enumerates every argument reaching the pipe and asserts each one changes the key —
  it fails when someone adds a parameter and forgets the key.
- **Disk growth.** Draft frames at 384² are small; HD export frames at 768² are not, and
  an export generates a full song. The budget default should be sized like
  `fluid_cache`'s (8 GB) and documented in README's storage section (step 06).
- **A stale cache across a model upgrade.** `model` is in the key, so a model *swap* is
  safe; a model whose *weights* change under the same repo id is not. Acceptable — the
  same exposure `fluid_cache` has to a code change, handled the same way (bump nothing,
  clear the cache).

## Exit gate

Generate a clip; regenerate it unchanged and watch the job finish in seconds with every
frame a hit. Move one cut by a few frames; watch only that transition's ramp regenerate.
Edit the text of prompt 3 of 5; watch parts 1, 2, 4 and 5 stay hit.

## Verification

- pytest: hit/miss parity (a cached frame is byte-identical to a freshly generated one);
  key canonicalization at `w∈{0,1}`; every pipe-affecting argument changes the key; a cut
  nudge invalidates only ramp frames (drive `_dream_plan` from step 03 once it exists, or
  a hand-built plan until then); eviction bounds the directory; `ENABLED=0` bypasses
  cleanly. Tests patch `backend.paths` for the cache directory — the hard invariant; no
  new per-module dir constant that tests cannot redirect.
- `make lint`.
