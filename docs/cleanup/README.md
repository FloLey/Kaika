# Cleanup series

One file per step, in three waves:

| Wave | Steps | Audited | Theme | State |
|---|---|---|---|---|
| 1 | `00`–`01` | — | the original backlog | **done** (see `00-backlog.md`'s status table) |
| 2 | `02`–`15` | 2026-07-19 | correctness infrastructure | **done** — last commit `7b36ff6` (step 14) |
| 3 | `16`–`28` | 2026-07-20 | **speed**, plus wave-2 leftovers | open → [jump](#wave-3--speed-and-the-leftovers) |

The wave-2 section below is kept as written. **Its steps have all landed**; it stays because
the reasoning is still the best statement of why that work existed.

---

# Wave 2 — correctness infrastructure (done)

**The thesis is unchanged from `00-backlog.md`: the safety net comes first**, because the
large refactors have no test that would notice if they broke the picture. Steps 02–05
rebuild it. Nothing after 05 is safe without them.

## The four findings that are not cosmetic

1. **CI is green on a suite it never runs.** `ci.yml:27` installs no torch and no Postgres
   and never passes `--strict-deps` — which `conftest.py:138-174` implements precisely to
   make silent skips loud. ~9 backend test files and the whole HTTP layer skip on every push.
   → **02**
2. **`render()` leaks ffmpeg decoders.** `dag._closers` is drained only in `stream_blocks`'
   `finally` (`graph_render.py:478-483`); `render()` (`:1968`) has no `try/finally`. The
   parity test that would notice (`test_card_impact.py:124`) builds a fresh `Dag` and never
   calls `render()`. → **06**
3. **Three backend↔frontend constant tables are hand-mirrored with nothing guarding drift.**
   `graph_hash` drift changes cache keys silently — it presents as "the export doesn't match
   the preview". → **08**
4. **`cache_gc.py:66`** swallows any `output_hash` exception, so a hashing bug degrades into
   deleting live rendered work. → **04**

## Steps

| # | Step | Size | Blocked by |
|---|---|---|---|
| [02](02-ci-runs-the-suite.md) | CI runs the tests it claims to run | M | — |
| [03](03-tests-that-can-fail.md) | Tests that cannot fail, made able to fail | S/M | 02 |
| [04](04-backend-seam-tests.md) | Backend seam tests + the GC data-loss bug | L | 02, 03 |
| [05](05-frontend-seam-tests.md) | Frontend seam tests | M | 02, 03, **uncommitted tree** |
| [06](06-drain-the-dag.md) | Drain the render DAG at every entry point | S | 02 |
| [07](07-one-handler-per-card.md) | One handler per card, round two | M/L | **06**, 02 |
| [08](08-codegen-the-mirrored-tables.md) | Codegen the three hand-mirrored tables | M | 02 |
| [09](09-backend-shims-and-duplicates.md) | Backend shims and duplicates | M | 04, 07, 08 |
| [10](10-backend-big-functions.md) | Backend big-function surgery | L | 04, 07 |
| [11](11-frontend-types.md) | Frontend types: eradicate `unknown` | M | 05 |
| [12](12-frontend-primitives.md) | Frontend primitives: extract before splitting | L | 05, 11 |
| [13](13-frontend-splits.md) | Frontend splits | L | 05, 12 |
| [14](14-docs-tell-the-truth.md) | Docs tell the truth; every control has a "?" | M | 07–09, 12, 13 |
| [15](15-coverage-debt.md) | Coverage debt: `segment.py`, `procgen.py` | M | 02 |

```
02 ──┬─> 03 ──┬─> 04 ──┬────────────> 09
     │        │        └─> 10
     │        └─> 05 ──> 11 ──> 12 ──> 13 ──┐
     ├─> 06 ──> 07 ──┬──> 09 ───────────────┼──> 14
     ├─> 08 ─────────┘                      │
     └─> 15 (floats)                   10 ──┘
```

## The four hard "test before refactor" gates

| Refactor | Blocked until | Why the existing suite won't catch it |
|---|---|---|
| 07 `_whole_from_block` conversions | **06** drain + drain test | `test_card_impact.py:124` builds a fresh `Dag` and never calls `render()` — green through the leak |
| 10 `validate` → 6 named checks | **04** per-rule cases | 130-line C901=35 function; a dropped rule fails **open**, not loud |
| 09 `export.py` + `_prune_locked` dedupe | **04** export/jobs tests | leaked HD slots and orphaned jobs are invisible in dev and CI |
| 12 `useJobRun` / OutputNode↔StreamPreview merge | **05** hook tests | zero coverage on all three job hooks; the two preview paths have *already* drifted |

## Working rules

- One step = one commit-sized unit that ends green (pytest + vitest + lint + `tsc --noEmit`).
- Docs ship with the change that makes them wrong. Step 14 is the one deliberate exception:
  it reconciles drift that predates this plan.
- `RENDER_VERSION` bump when render semantics change (step 07 needs one); `GRAPH_VERSION` +
  a `normalizeGraph` migration when the persisted graph shape changes (step 11 has a tripwire).
- Line numbers throughout are an audit snapshot — **re-grep before relying on one.**

## ⚠ Uncommitted-tree collision

At the time of writing, the working tree modified `lib/graph/{layout,mutations,graphModel}.ts`,
`useGraphEditor.ts` and `__tests__/layout.test.ts`. Steps **05, 11, 12, 13** re-enter exactly
those files; land or abandon that work first. Steps 02–04 and 06–10 are backend/CI-only and
collision-free — the main argument for doing the backend half first.

## Ordering calls worth defending

1. **Backend-first (02–04, 06–10) before frontend (05, 11–13)**, against the instinct to
   interleave — the backend half is collision-free with the in-flight work.
2. **Types (11) → primitives (12) → splits (13)**, never the reverse. Splitting first
   relocates duplication instead of removing it, and extracting a hook over `unknown` ships
   the cast into the new API. `useStreamRender.ts:158` is the existing proof that a bad cast
   reaches the wire.

---

# Wave 3 — speed, and the leftovers

Audited 2026-07-20 against the post-wave-2 tree (three-way: backend / frontend /
tests-tooling). The centre of gravity is different from wave 2's. Wave 2 was about
**correctness infrastructure**; wave 3 is about **speed** — the thing wave 2 explicitly did
not look at — plus the work wave 2 scoped out and the robustness holes its tests are now good
enough to expose.

## The four findings that are not cosmetic

1. **The emitters cost more than the solver they feed.** `FluidSim._gauss`
   (`fluid.py:172`) computes a full-grid exponential per emitter per frame. With
   `_POINT_CAP = 64` (`graph_common.py:27`) and two `_gauss` calls per emitter in
   `_emitter.inject` (`fluid.py:437`), a points-driven fluid does up to **128 full-grid
   `exp()` per frame** — ~6.4M transcendentals against the ~2M ops of the four FFTs in
   `step()`. The windowing fix already exists in this repo as `sources._stamp`
   (`sources.py:784`). → **17**
2. **Both export paths do the expensive work before checking the cache.**
   `song_render.py:256` runs `build_plan` — full STFT/HPSS/beat-track signal extraction over
   every segment — *before* the `out_path.exists()` check. `routes/export.py:479` renders the
   stylize input at export grid to derive a content key it discards on a hit at `:496`.
   Re-exporting an unchanged project pays full price twice. → **19**
3. **One hung ffprobe wedges every export for the life of the process.** Five
   `subprocess.run` calls on the render path have no timeout (`sources.py:1016`,
   `fluid.py:685`, `song_render.py:119`, `media.py:131,144`, `segment.py:61`) while the upload
   path times out everywhere. `_HD_SLOT` (`routes/export.py:43`) is a `BoundedSemaphore(1)`
   released in a `finally` that a hang never reaches. → **20**
4. **CI validates a dependency set that is never run.** `ci.yml:51` installs numpy, scipy,
   librosa et al. **completely unpinned**, while `requirements.txt:5-15` pins every one under
   a header explaining that "torch/librosa/demucs combos are brittle across versions."
   → **23**

## Steps

**Core** changes something real. **Optional** is worth doing but nothing depends on it — so
the series can stop after 23 and still have delivered the point.

| # | Step | Tier | Size | Blocked by |
|---|---|---|---|---|
| [16](16-parity-and-benchmark-harness.md) | A parity gate and a baseline | core | M | — |
| [17](17-the-fluid-emitter-hot-loop.md) | The fluid emitter hot loop | core | L | **16** |
| [18](18-the-other-three-hot-loops.md) | The other three hot loops | core | M | **16** |
| [19](19-check-the-cache-before-doing-the-work.md) | Check the cache before doing the work | core | M | **16** |
| [20](20-timeouts-and-an-atomic-hd-write.md) | Timeouts, and an atomic HD write | core | S/M | — |
| [21](21-the-editors-per-render-graph-walks.md) | The editor's per-render graph walks | core | S/M | — |
| [22](22-cover-the-hd-export-seam.md) | Cover the HD-export seam | core | L | — |
| [23](23-ci-tests-what-you-actually-run.md) | CI tests what you actually run | core | M | — |
| [24](24-frontend-dead-code-and-drifted-twins.md) | Frontend dead code and drifted twins | optional | S | — |
| [25](25-graphcanvas-edge-layer-and-free-panning.md) | GraphCanvas: an edge layer, free panning | optional | M | 21 |
| [26](26-one-editor-context.md) | One editor context, not a nine-prop drill | optional | L | **21 (measure first)** |
| [27](27-split-sources-and-one-gen-merge-producer.md) | Split `sources.py`; one gen-merge producer | optional | M | — |
| [28](28-test-hygiene-and-stale-numbers.md) | Test hygiene and stale numbers | optional | S | — |

```
16 ──┬─> 17 ──┐
     ├─> 18 ──┼──> (perf verified, numbers recorded)
     └─> 19 ──┘
21 ──> 25 ──> 26
20, 22, 23, 24, 27, 28   float — no blockers
```

## The one hard gate

| Refactor | Blocked until | Why the existing suite won't catch it |
|---|---|---|
| 17 / 18 / 19 | **16** parity helper + recorded baselines | `assert_moves` is a *motion* assertion, deliberately loose enough for 34 demos. It stays green if an emitter radius silently halves. `test_card_impact`'s two scalars do too. |

Step **26** is gated on **21** differently — measure-first, not technical. Step 21's cheap
memo fixes may take enough off the per-edit cost that 26's wide refactor stops being worth its
risk. Do not start 26 without numbers.

## Working rules

Unchanged from wave 2, plus one:

- One step = one commit-sized unit that ends green (pytest + vitest + lint + `tsc --noEmit`).
- Docs ship with the change that makes them wrong.
- `RENDER_VERSION` bump when render semantics change (**17 probably needs one — 16 decides**);
  `GRAPH_VERSION` + a `normalizeGraph` migration when the persisted graph shape changes
  (nothing in wave 3 should touch it; 26 has a tripwire).
- **New: every perf commit reports a before/after number in its commit message.** Wave 1's
  postmortem is explicit that without a starting number "it's faster" is an impression — which
  is how three fixes were wrongly declared done in one week.
- Line numbers throughout are an audit snapshot — **re-grep before relying on one.**

## ⚠ Uncommitted-tree collision

The audit ran against a clean tree; the tree did not stay clean. At the time of writing, nine
files are modified and uncommitted, three of them under wave 3's path:

| Uncommitted file | Blocks |
|---|---|
| `backend/graph_hash.py` (**RENDER_VERSION 13 → 14**) | step 17's bump, if 16's sweep decides it needs one |
| `backend/graph_render.py` (`drop_stale_blocks`) | step 18's `_transform_frames` hoist |
| `scripts/measure_render.py` | reusing the profiler from step 16's benchmark |

The `RENDER_VERSION` one is the sharp edge: bumping to 15 on top of an uncommitted 14 makes
one version cover two unrelated semantic changes, and `docs/render-versions.md` stops being a
usable changelog. **Land that work first and the problem is moot.**

Everything else wave 3 touches is clear — `fluid.py`, `procgen.py`, `sources.py`,
`look_fx.py`, `song_render.py`, `routes/export.py`, `tests/helpers.py` — which is the
argument for doing 16, 19 and the free three-quarters of 18 first.

## Checked and found fine — do not re-audit

Recorded so wave 4 does not spend itself here. Each was actively investigated in the
2026-07-20 audit:

- **ffmpeg invocation patterns.** Persistent decoders (`sources.py:1057`) and encoders
  (`fluid.py:734`), `lru_cache`d probes, an `FFMPEG_SLOTS` semaphore *inside* `_ffmpeg_atomic`
  so no call site can bypass it. No per-frame or per-block subprocess spawns anywhere.
- **The cache layer's key design.** `fluid_cache` serves mmap slices without copying;
  `output_hash` strips unwired slots and loose edges so `+ slot` doesn't bust the cache;
  `_montage_slot_key` caches slots in *local* time so retiming a trigger reuses every slot.
- **torch/MPS usage** — no dtype churn in a loop, no CPU↔GPU ping-pong, no stray sync points.
- **`segment.py` / `signals.py` complexity** — all O(n·m) with tiny m, all on the
  once-per-upload path. Bounded LRUs on STFT/HPSS/beats.
- **DAG resource lifetime** (wave-2 step 06 held), **`db.py` query patterns** (no N+1),
  **route-level request validation** (already deduplicated).
- **Broad-except discipline** — `grep 'except Exception' | grep -v BLE001` returns exactly one
  hit, and it is a re-raising cleanup.
- **Suite speed** — 642 pytest in 23.8s, 341 vitest in ~2s. No sleeps-as-polling. Not a
  problem.
- **`ruff.toml` leniency**, the 27 `BLE001` and 11 `E402` suppressions (all load-bearing), the
  Makefile↔CI mirror, and doc module-path accuracy (zero broken references after step 14).
- **Splitting `registry.ts` / `factories.ts` / `normalize.ts` / `mutations.ts`** — all four
  would be pure line-moving. Also **`graph_render.py`**: moving `Dag` out creates a cycle, and
  moving only the card helpers is readability-only (reasoning in step 27).
- **Frontend type quality** — one `any` in the tree, at the JSON-parse boundary, commented.
  Wave 2's `unknown` eradication held.

## Corrections to the audit itself

- An early draft claimed `centerInContainer` performs its own `getBoundingClientRect`,
  making the edge loop 3× worse than it is. **It does not** — `ports.ts:11` takes
  `containerRect` as a parameter. The finding in step 21 is real; the 3× was not.
- Step 16 claimed "there is no timing test in the repo (`grep perf_counter` finds only
  job-wait loops)" and proposed a new `tests/test_perf_baseline.py`. **Both halves were
  wrong.** `tests/test_perf_budget.py` has existed since `dc0d19e` — with a `perf` marker,
  loose ceilings and a `_timed` helper — and `grep perf_counter backend tests scripts` finds
  it at `:43,45`. The cited grep would have caught it; it was not run. Step 16 now carries
  the correction.
- **That correction was then itself wrong**, which is the most instructive entry here. It
  proposed folding the new cases into `test_perf_budget.py` "under the marker that already
  exists" — but **the `perf` marker deselects nothing**. There is no `addopts` in
  `pyproject.toml`, `make test` runs bare `pytest -q`, and CI runs
  `pytest --cov=backend --strict-deps`. `-m "not perf"` exists only in prose, including
  `02-ci-runs-the-suite.md:47`, which specified it for CI and **never landed** — so wave 2's
  step 02 is partially unshipped. Step 16 now specifies a `bench` marker *plus* a real
  `addopts` deselect.
- **All three are one failure**: a claim written down without being run, then inherited by
  the next reader. A documented deselect is not a deselect; a cited grep is not a grep.
  Re-run them.
