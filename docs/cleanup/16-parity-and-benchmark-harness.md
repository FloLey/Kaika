# Step 16 — A parity gate and a baseline, before anything gets faster

**Tier.** Core. **This is wave 3's step 01** — the safety net, and nothing in 17–19 is safe
without it.

**Goal.** Be able to prove that a performance change made the renderer faster and did *not*
change the picture — **reproducibly, from the repo**, rather than by hand on one laptop.

Both halves exist today in some form, and neither is reusable. Two-render comparison is
hand-rolled in nine test files under four different tolerances with no shared definition of
"agree" (§1). Timing exists as `tests/test_perf_budget.py` and `make measure-render`, but
neither records a baseline, so every speedup number in the last three commits lives only in
prose (§3).

**Blocked by.** Nothing.

**Gates.** Steps **17, 18, 19**. All three change either rendered pixels or a cache
identity.

**Non-goals.** No optimisation in this step. It lands alone, with numbers recorded, and the
first perf commit follows separately.

**Size.** M.

> Line numbers are a snapshot — re-grep before relying on one.

---

## Why the existing suite is not enough

Wave 1 built `assert_moves` (`tests/helpers.py`) because the suite could not tell an
animated clip from 80 identical frames. It fixed that. But it is a *motion* assertion — mean
frame-to-frame delta plus a distinct-frame fraction — and it is deliberately loose, because
34 different Playground demos have to pass it.

That looseness is exactly wrong for wave 3. Step 17 replaces a full-grid Gaussian with a
windowed one; the result is *supposed* to be nearly identical and will not be bit-identical.
`assert_moves` would stay green if the emitter radius silently halved. `test_card_impact`'s
two scalars (`rgb.max()`, lit-pixel fraction) would too.

Step 06's lesson applies again: **the test has to land before the change, and be watched
failing.**

## 1. A frame-parity helper

In `tests/helpers.py`, next to `assert_moves` / `assert_not_black`.

**This is deduplication first, new machinery second** — a stronger justification than the
audit originally gave it. The whole-clip vs block-streamed assertion is hand-rolled across
**nine test files under four different tolerances**, and no single place defines what "the
two renderers agree" means:

| Tolerance | Sites |
|---|---|
| exact (`np.array_equal`) | `test_graph_transform.py:79`, `test_look_fx.py:70,204,309`, `test_montage.py:200,250`, `test_fluid_cache.py:115`, `test_gen_sim_cards.py:79,104`, `test_sources_layers.py:254`, `test_imagegen.py:181` |
| mean `< 1.0` / `< 1.5` | `test_sources_layers.py:426`, `:468` |
| mean `< 2.0` | `test_imagegen.py:234`, `test_card_impact.py:148` |

⚠ **Count carefully — not every two-render comparison is the same invariant.**
`test_graph_combine.py:113` (mean `< 0.01`) is *not* whole-vs-streamed at all: it compares
`fluid.simulate(source=…)` against `fluid.simulate(sources=[…])`, an **API-equivalence**
assertion between two whole-clip renders. `test_fluid_cache.py:115` compares the two paths
but exists to prove the *cache* serves identical slices. Both can use the helper; neither
belongs in a "stream parity" migration. Re-read each site before moving it.

The three mean bounds that *are* the same phenomenon — seam jitter on a video-backed card,
at `< 1.0`, `< 1.5` and `< 2.0` — are three arbitrary numbers for one thing, and unifying
them onto a single named constant is worth its own later commit.

Design constraints, in order of how easy they are to get wrong:

- **Pair the bounds; do not pick one.** `test_card_impact.py:148` uses a clip-wide *mean*
  deliberately — the justification at `:144-146` is that ffmpeg seeking makes video-backed
  cards differ by a hair at block seams. So a naive `max()` bound will fail on those cards.
  But a mean alone is also wrong: a large divergence confined to three frames averages away
  over a whole clip. `test_flatten_contract.py:199` already pairs `mean < 2` with `max < 8`
  for exactly this reason. **That pairing is the shape to copy.**
- **Exact is the default, and both bounds default to zero.** Weakening should never be the
  result of an omission, only of someone typing a number. Make the reason *enforced*, not
  merely conventional:

  ```python
  assert not (atol or mean_atol) or why, "a nonzero tolerance must say why it is acceptable"
  ```

  That is the actual anti-weakening mechanism, and it is already this file's idiom — every
  floor in `helpers.py` carries a paragraph justifying its number. A copy-pasted
  `mean_atol=2.0` then drags its justification along with it, so a reviewer sees a claim to
  check rather than a bare float. Call the parameter `why`, not `note`: `note` reads as
  optional colour, `why` reads as an obligation.
- **Fail the way a human debugs.** Max absolute delta, the fraction of pixels over
  tolerance, and the index of the worst frame. A bare `assert allclose` cannot distinguish
  "you broke the physics" from "you moved one edge pixel".

⚠ **Do not mass-migrate the call sites in the same commit.** Three reasons, in order of
weight. `helpers.py:100-102` already states the adopt-on-touch policy, so a commit that
lands a helper and bulk-rewrites passing tests contradicts the note directly above it. This
commit is the *safety net for steps 17–19*, and its whole value is that when step 17 turns
something red you trust the harness — a thirteen-file mechanical diff in the same commit
gives the first red test two candidate causes. And the risk is asymmetric: tightening a
tolerance fails loudly and gets fixed, loosening one is invisible forever.

Convert **three**, chosen to exercise every mode:

| Site | Proves |
|---|---|
| `test_graph_transform.py:79` | the exact default path |
| `test_card_impact.py:147-149` (`mean_atol=2.0`) | the tolerant path, across all 34 demos — and it is the message you will actually be reading during step 17 |
| `test_flatten_contract.py:199` (`atol=8, mean_atol=2`) | both bounds together |

Leave the rest to adopt-on-touch.

## 2. The tolerance decision — make it here, not in step 17

Step 17 truncates each emitter's Gaussian at a window of `k·σ`. This is an approximation and
the step file should not be the place it gets waved through.

- A 2-D Gaussian truncated at 3σ retains ≈98.9% of its mass; at 4σ, ≈99.97%.
- The discarded tail is spread over the *far* field, where `add_dye` contributes a value
  already below one 8-bit level for any realistic `amount`.

⚠ **The second bullet is true of `add_dye` and false of `add_radial`.** `add_radial`
(`fluid.py:199`) does not write pixels — it accumulates a **divergence source** that
`_project`'s global spectral Poisson solve consumes. Its truncation error therefore does
*not* stay in the far field; it propagates through the pressure solve into the whole
velocity field, and from there into where the dye goes. `add_heat` (`:191`) has its own
wrinkle: it MAX-blends via `np.maximum(..., out=self.T)`, so a windowed version must be a
max inside the window and a genuine no-op outside, not a max against zero.

**Decide k here, empirically:** render the fluid Playground demos at both the current
implementation and a windowed prototype, sweep k ∈ {2.5, 3, 4}, and record the measured max
per-channel delta for each. Pick the smallest k whose delta is ≤ 1/255, and write the
measured number into this file. **The sweep must include a radial-emitter demo and a fire
(heat) demo specifically** — a dye-only sweep measures the one case where the error is
guaranteed local, and would license a k that is wrong for the other two. Then step 17's acceptance criterion is a concrete
`atol` that someone already justified — not a number invented while chasing a speedup.

⚠ If no k under ~4 gets the delta under 1/255, that is a finding: say so, and step 17 takes
a `RENDER_VERSION` bump on the grounds that the picture genuinely changed, rather than
pretending it didn't.

### Two things that will change what the sweep measures

**Measure truncation, not slice arithmetic.** The prototype should *not* be a windowed-slice
implementation. Compute the full grid exactly as today and zero everything outside the k·rc
box. Truncation error is a mathematical property of k; off-by-ones at the window border and
the wrap case are step 17's *correctness* problem and belong in its parity run. Two
variables, two measurements — and it keeps the k decision from being contaminated by a bug.

Note the window is a **box, not a disk**, which retains more than the disk figures above:
`erf(k/√2)²` gives 99.46% at k=3, not 98.9%. Use the box numbers.

**Try mass renormalisation as a fourth column.** The pointwise tail value at k=3 is ~1.2e-4
— utterly negligible. The quantity that actually matters for `add_radial` is the
**fractional mass loss** (1.4% at k=2.5, 0.54% at k=3, 0.006% at k=4), because `_project`
consumes `div - (source - source.mean())`: losing tail mass shifts `source.mean()`, which
moves the compensating sink *everywhere*. Scaling the window by `1/erf(k/√2)²` preserves the
sum exactly and makes that error vanish. If it works it is a two-line change in step 17 and
the non-locality concern disappears — so measure it here rather than discovering it later.

Be prepared for the answer to be a **per-caller k**: dye/force/heat at 2.5–3 and radial at 4
(or renormalised) is a plausible outcome, and a single k forced across all four would be
chosen by the worst case.

**Record the window/grid area ratio at the chosen k, not just the delta.** "k=4 is safe" and
"k=4 windows 137² of 216², i.e. 2.5×" are two halves of one decision. Step 17's expected
gain is explicitly an unverified estimate; if the safe k gives a ratio near 1.0 for the
demos that matter, the optimization is worth less than assumed — and that should surface
here, before the code is written.

## 3. A benchmark — a new file, and a marker that actually deselects

> ⚠ **Corrected twice, 2026-07-20.** The audit claimed "there is no timing test in the repo
> (`grep perf_counter` finds only job-wait loops)". **Wrong** — `tests/test_perf_budget.py`
> has existed since `dc0d19e`, and that exact grep finds it at `:43,45`.
>
> The first correction then over-swung, proposing to fold the new cases into
> `test_perf_budget.py` "under the marker that already exists". **Also wrong**, for a reason
> worth internalising: **the `perf` marker does not deselect anything.** There is no
> `addopts` in `pyproject.toml`, `make test` runs bare `pytest -q`, and CI runs
> `pytest --cov=backend --strict-deps`. `-m "not perf"` appears **only in prose** — two
> docstrings and `02-ci-runs-the-suite.md:47`, which specified it for CI and never landed.
> The budgets run in CI today. Verify with `grep -rn "not perf"`.

What already exists, and must be built on rather than duplicated:

| Existing | What it gives you | Caveat |
|---|---|---|
| `tests/test_perf_budget.py` | Three budget tests, `pytestmark = pytest.mark.perf`, `_timed(label, fn)` printing `[perf] {label}: {elapsed:.2f}s`, and the "loose ceilings, always print the measured value" doctrine in its docstring | **Runs in CI** — see above |
| `pyproject.toml:9-12` | The `perf` marker | Declarative only; nothing deselects it |
| `scripts/measure_render.py` + `make measure-render` | Phase-attribution profiler over a real DB segment — decode / flatten / encode / opacity / to_rgba, peak ffmpeg procs and RSS | Manual, needs Postgres, records no baseline |
| `tests/test_flatten_contract.py:171-202` | The existing **two-render parity idiom**: encode the same RGBA both ways, decode both, assert `mean < 2 and max < 8` | — |

**So: a new `tests/test_perf_baseline.py` after all — but the reason is not "a second file
is tidier".** Budgets and baselines have *opposite* CI requirements. A 10× ceiling on a
0.3 s render **should** run in CI; that is how "the preview started rendering the whole
song" gets caught. A recorded baseline is seconds long, machine-specific, and asserting
tightly on it is precisely the flaky-perf-test trap this file's Risks section warns about.
One file cannot carry both without dragging one into the wrong regime.

That needs a second marker **and** the deselect the first one never got:

```toml
[tool.pytest.ini_options]
addopts = ["-m", "not bench"]   # this line is what makes "opt-in" true rather than documented
markers = [
    "perf: order-of-magnitude performance guard",
    "bench: recorded performance baseline; opt-in via `pytest -m bench`, never in CI",
]
```

A trailing command-line `-m bench` overrides `addopts` (addopts is prepended), so
`pytest -m bench` and a `make bench` target both work. ⚠ `addopts` applies to **every**
invocation including `make test-strict` and the coverage run — intended, but confirm
`--strict-deps` counts skips rather than deselects before assuming it is unaffected.

Move `_timed` (`test_perf_budget.py:42-47`) into `helpers.py` as `timed(label, fn)` so both
files share it. That is the only edit `test_perf_budget.py` needs.

⚠ **Do not build the cases from `card_demo.DEMOS`.** `backend/playground_pipelines.json` is
re-exported from the live UI, so a Playground rework silently changes the workload and
invalidates every recorded number without touching the benchmark. That is tolerable for a
10× ceiling — `test_perf_budget.py` is fine as it stands — and fatal for a baseline. Build
the graphs locally with `helpers.node`/`edge`/`graph_of`.

The cases:

| Case | Why this one | Build note |
|---|---|---|
| A fluid segment, points-driven emitter chain | step 17's target; the `_POINT_CAP = 64` path (`graph_common.py:27`) | **Fill the points list to all 64** so it measures the 128-exponentials-per-frame worst case, not the demo's handful. Record a second variant at `radius: 0.02` — small radii are where windowing wins most, and the demo's 0.08 under-reports the gain |
| A transform block over an RGBA layer | step 18's `_transform_frames` (`graph_render.py:1320` — moved from the audit's `:1280`) | Drive it through `stream_blocks`, not `video()`: step 18 targets the **block** path. Fluid output is already RGBA |
| A clouds clip | step 18's noise-lattice caching (`procgen.py:39`) | The one case with no fluid sim, so it isolates the lattice. Render **larger** than the others — lattice cost scales with output pixels and gets lost in overhead at 192² |
| A repeat whole-song export that hits the cache | step 19; should become ~instant | Needs no ffmpeg and no DB: stub `paths.ANIM_DIR / f"song_{_export_hash(...)}.mp4"` to put the run on the cache-hit branch (`test_dag_lifetime.py:191-195` is the precedent) |

⚠ **Case D needs a real bound signal, or it records a baseline that cannot improve.** With
`signals: []` and a null stem resolver, no STFT ever runs — so the pre-step-19 number is
already near zero and step 19 will look like it did nothing. Give at least one segment a
port bound to a `signal` node plus a synthetic stem; `test_card_impact.py:22-39` has exactly
that fixture, module-scoped and DB-free.

Every rendering case also asserts `assert_moves` on its frames. A benchmark that got 10×
faster by rendering nothing is the failure mode here, and it is not hypothetical — wave 1
exists because 79 frozen frames out of 80 shipped green.

Assert **order-of-magnitude ceilings only**, generous enough not to flake — the goal is
catching a 10× regression, not a 10% one. This is not a new doctrine to invent: it is
already written in `test_perf_budget.py`'s docstring ("roughly 10x the observed cost … the
measured value is always printed, so a slow drift is visible long before it trips the
ceiling"). Follow it.

**Record the measured baseline in a table in this file before step 17 starts.** Wave 1's
working rules already say why: without a starting number, "it's faster" is an impression,
and that is how three fixes were wrongly declared done in one week.

### Baseline

> Apple M5 Pro · Python 3.12.13 · numpy 2.4.6 · scipy 1.18.0 · commit `2e4d2e2`
> `make bench`, median of 3 runs, machine otherwise idle.

| Case | Time | Notes |
|---|---|---|
| points fluid, 64 emitters, r=0.08, 2 s | **0.52 s** | 180×96 sim grid — step 17's target |
| points fluid, 64 emitters, r=0.02, 2 s | **0.50 s** | small-radius variant; windowing should win more here |
| transform block, 1080p RGBA, 0.5 s | **1.30 s** → **0.21 s** | native path; step 18 fix 1 landed in `8cefeb7` |
| clouds clip, 2 s | **0.15 s** | already 1.83× faster than pre-`372edb9` |
| repeat song export, cache hit | **0.00 s** | already fixed by `4a39773`; recorded so a regression shows |

⚠ **Two of these are post-optimisation** (clouds, song export). They are *not* virgin
numbers, and a future reader comparing against the audit's prose will be confused unless
that is stated. The two fluid rows and the transform row are untouched.

⚠ **The output settings are load-bearing, and getting them wrong silently measures
nothing.** A heavy producer (`_HEAVY_TYPES`) drags the render onto the coarse simulation
grid; a *light* graph with `nativeShort` set renders at full 1080p. The first draft of the
transform case put a fluid upstream and measured **64×64×3 at 0.05 s** — for an operation
that costs 1.30 s on the path an HD export actually takes. The case now asserts its own
frame shape so it cannot regress into measuring nothing.

### ⚠ The baseline is post-optimization, not virgin

Three perf commits landed *after* this audit was written and *before* this step is built:

| Commit | Change | Reported |
|---|---|---|
| `e47c80b` | skip two conversions producing identical pixels | 133.0 s → 24.2 s on 4K (5.5×) |
| `fbfb8d3` | hand RGBA to ffmpeg and let it composite | 133.0 s → 12.6 s total (10.6×), 3.0 → 31.8 fps |
| `a8f5667` | build montage slots on demand, stop caching what LRU evicts | — |

Two things follow. First, **the numbers this step records are measured against an already
much-faster renderer**, so a modest further win from 17/18 is the expected outcome, not a
disappointment. Second, those commits are the proof that this step's discipline is
achievable: `e47c80b` shipped `test_flatten_contract.py` asserting each shortcut
byte-identical against the arithmetic it skips, and **declined a `RENDER_VERSION` bump on
the stated grounds that the frames are identical "and that is asserted rather than
assumed."** That is the standard step 17 is held to.

They also demonstrate the gap this step closes: every one of those numbers was read off a
terminal by hand and typed into a commit message. Nothing on disk can reproduce or verify
one.

⚠ A methodology trap, recorded in `fbfb8d3`'s message and worth not rediscovering: a first
attempt at the composite parity check used random noise and reported a mean error of 13.9
levels. Random noise is worst-case for a lossy codec — *"it measured compression, not the
composite."* Flat colours are what that check needed. Any parity check that round-trips
through ffmpeg has this hazard.

---

## Verification

1. Run the parity helper against two identical renders → passes at exact.
2. Perturb one card's parameter slightly → the helper goes red, and its message names the
   worst frame.
3. The two migrated call sites still pass, and still at the tolerance they had before —
   diff them and check the number did not move.
4. `pytest -m bench` runs the new cases and prints numbers; the baseline table in this file
   is filled in, with its provenance header.
5. **`make test` does not run them** — check the deselect empirically (the count must not
   grow), because the `perf` marker proves that a documented deselect is not a deselect.
6. `pytest --cov=backend --strict-deps` (what CI runs) still passes with `addopts` in place.

## Acceptance criteria

- One parity helper exists in `tests/helpers.py`, is adopted by three existing call sites at
  their original tolerances, refuses a nonzero tolerance with no `why`, and fails
  informatively.
- The k-sweep table is in this file with real measured numbers, covering dye, **radial** and
  **heat** emitters.
- The baseline table is in this file with real measured numbers **and a provenance header**
  — machine, Python/numpy/scipy versions, the commit measured at, and "median of N runs,
  machine idle". A wall-clock number without those is not reproducible, and reproducibility
  is the entire point of this step.
- The `bench` marker is deselected by `addopts`, and that is verified by running, not by
  reading the config.
- The default `make test` runtime is unchanged (the benchmark is genuinely opt-in).

## Risks

- **A tolerance chosen to fit the answer.** The sweep happens *before* step 17 is written,
  precisely so the number is not negotiated afterwards.
- **Flaky ceilings.** If the benchmark proves noisy in practice, keep it out of CI entirely
  and run it by hand per perf commit. A flaky perf test gets muted, and then it is worse
  than none.
- **Silently loosening a tolerance during migration.** The reason only two call sites move
  in this step, and the reason verification step 3 diffs the numbers rather than trusting
  green.
- **Trusting this file.** Its original §3 was confidently wrong about something a one-line
  grep disproves. Re-run the greps; do not inherit a claim because it is written down.
