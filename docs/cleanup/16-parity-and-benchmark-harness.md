# Step 16 — A parity gate and a baseline, before anything gets faster

**Tier.** Core. **This is wave 3's step 01** — the safety net, and nothing in 17–19 is safe
without it.

**Goal.** Be able to prove that a performance change made the renderer faster and did *not*
change the picture. Today neither half is possible: there is no benchmark, and no test
compares two renders frame-for-frame.

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

In `tests/helpers.py`, next to `assert_moves` / `assert_not_black`:

```python
def assert_frames_close(a, b, *, atol, note=""):
    """Two renders of the same graph agree within `atol` (0..255 per channel).

    For perf work that is meant to be behaviour-preserving. `atol=0` is exact;
    an approximation states its tolerance and WHY it is acceptable in `note`."""
```

Report on failure the way a human debugs it: max absolute delta, the fraction of pixels over
tolerance, and the index of the worst frame. A bare `assert allclose` tells you nothing about
whether you broke the physics or moved one edge pixel.

## 2. The tolerance decision — make it here, not in step 17

Step 17 truncates each emitter's Gaussian at a window of `k·σ`. This is an approximation and
the step file should not be the place it gets waved through.

- A 2-D Gaussian truncated at 3σ retains ≈98.9% of its mass; at 4σ, ≈99.97%.
- The discarded tail is spread over the *far* field, where `add_dye` contributes a value
  already below one 8-bit level for any realistic `amount`.

**Decide k here, empirically:** render the fluid Playground demos at both the current
implementation and a windowed prototype, sweep k ∈ {2.5, 3, 4}, and record the measured max
per-channel delta for each. Pick the smallest k whose delta is ≤ 1/255, and write the
measured number into this file. Then step 17's acceptance criterion is a concrete
`atol` that someone already justified — not a number invented while chasing a speedup.

⚠ If no k under ~4 gets the delta under 1/255, that is a finding: say so, and step 17 takes
a `RENDER_VERSION` bump on the grounds that the picture genuinely changed, rather than
pretending it didn't.

## 3. A benchmark with recorded baselines

There is no timing test in the repo (`grep perf_counter` finds only job-wait loops). Wave 1
asked for one and it never landed. Add `tests/test_perf_baseline.py`, marked so it does not
run in the default suite (CI machines are too noisy for tight ceilings):

| Case | Why this one |
|---|---|
| A fluid segment with a points-driven emitter chain | step 17's target; the `_POINT_CAP = 64` path (`graph_common.py:27`) |
| A transform block over an RGBA layer | step 18's `_transform_frames` (`graph_render.py:1280`) |
| A clouds clip | step 18's noise-lattice caching (`procgen.py:39`) |
| A repeat whole-song export that hits the cache | step 19; should become ~instant |

Assert **order-of-magnitude ceilings only**, generous enough not to flake — the goal is
catching a 10× regression, not a 10% one, exactly as wave 1 specified.

**Record the measured baseline in a table in this file before step 17 starts.** Wave 1's
working rules already say why: without a starting number, "it's faster" is an impression,
and that is how three fixes were wrongly declared done in one week.

---

## Verification

1. Run the parity helper against two identical renders → passes at `atol=0`.
2. Perturb one card's parameter slightly → the helper goes red, and its message names the
   worst frame.
3. The benchmark runs and prints numbers; the table in this file is filled in.

## Acceptance criteria

- `assert_frames_close` exists, is used by at least one test, and fails informatively.
- The k-sweep table is in this file with real measured numbers.
- The baseline table is in this file with real measured numbers.
- The default `make test` runtime is unchanged (the benchmark is opt-in).

## Risks

- **A tolerance chosen to fit the answer.** The sweep happens *before* step 17 is written,
  precisely so the number is not negotiated afterwards.
- **Flaky ceilings.** If the benchmark proves noisy in practice, keep it out of CI entirely
  and run it by hand per perf commit. A flaky perf test gets muted, and then it is worse
  than none.
