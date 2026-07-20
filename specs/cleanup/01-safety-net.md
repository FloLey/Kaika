# Step 0 — Safety net

**Goal.** Make the suite fail when the product is broken. Today it does not: this week
two shipped bugs (a segment rendering 79 frozen frames out of 80; an editor taking
minutes to open a segment) both passed 487 green pytest + 252 green vitest.

**Non-goals.** No refactoring, no behaviour changes, no new features. Every later step
depends on this one, so it lands first and alone.

---

## Measured baseline (run before writing the assertions)

Motion across all 34 Playground demos, at `test_card_impact.py`'s settings
(120×120, 8 fps, 1 s ⇒ 8 frames), measuring mean |frame[i+1] − frame[i]| on the
flattened RGB and the count of distinct frames:

| | value |
|---|---|
| Demos that move | **34 / 34** — no legitimately static demo, so **no allowlist is needed** |
| Weakest mover | `image` at **0.65** |
| Strongest | `montage` 35.4, `waves` 34.9 |
| Fewest distinct frames | `slideshow` / `imagegen` at **3 / 8** (they step between stills — motion is not per-frame) |
| A frozen clip | delta ≈ **0.0**, distinct = **1** |

**Chosen thresholds**: `mean |Δ| ≥ 0.1` **and** `distinct frames ≥ 2`. That sits ~6×
below the weakest real demo and ~7× above a frozen clip, and the distinct-frame form
tolerates the stepping cards. Record these numbers in the helper's docstring so a future
threshold change is an argued decision, not a guess.

---

## Commits

### 1. `tests/helpers.py` — the shared vocabulary

- `assert_moves(frames, *, label="")` — the assertion above, with a failure message that
  prints the measured delta and distinct count (so a red test says *how* static it is).
- `assert_not_black(frames)` — lift the existing peak/lit checks out of
  `test_card_impact.py:57-61` verbatim, keeping their calibrated floors (peak ≥ 32,
  lit ≥ 0.005) and the comment explaining why `max > 0` was too lax.
- `out(**overrides)` — one documented default render setting. **Do not** mass-replace the
  13 existing `OUT` dicts (`test_cache_gc.py:21`, `test_card_impact.py:16`, … — their
  sizes/fps/backgrounds differ *meaningfully*, and rewriting them would silently change
  what those tests assert). New tests use `out()`; migrate an old one only when touching
  it for another reason.
- `node()` / `wire()` / `dag()` graph builders, replacing the per-file `_fluid_node`,
  `_image_node`, `_montage_node`, `_node`, `_edge` copies. Same rule: adopt on touch,
  no big-bang rewrite.

### 2. Wire motion assertions into the render tests

- `test_card_impact.py::test_pipeline_renders` — add `assert_moves` for all 34 demos.
  **This single line is the highest-leverage change in the whole cleanup**: it would have
  caught the frozen verse across every card at once.
- `test_render_e2e.py:50` — today asserts only `shape` and `dtype`; six identical frames
  pass.
- `test_gen_sim_cards.py` — each generative card must move.
- `test_montage.py` — the video-asset paths (`test_montage_retimes_each_slot_to_its_cut`).
  ⚠ `test_montage.py:194` deliberately asserts *staticness* (its fixture uses stills):
  rename to say so (`…_holds_each_still_for_its_slot`) and comment, so the next reader
  doesn't "fix" it.

### 3. Path isolation + leak guard

- One autouse fixture pointing **all** `paths.*` directories at `tmp_path`. It must patch
  both `backend.paths.X` *and* the modules that did `from .paths import X` at import time
  (grep them; `routes/uploads.py`, `routes/serving.py`, `cache_gc.py` are known cases —
  today `test_assets.py` patches the importing module while everything else patches
  `paths`, two conventions that only accidentally cover each other).
- A guard that snapshots the repo's real `data/` before and after each test and fails on
  any new file — leaks are invisible today because `data/` is gitignored.
- Keep the existing `_isolated_frame_cache` behaviour (it already covers
  `fluid_cache.CACHE_DIR`) and fold it into the same fixture.

### 4. Time budget

- A `@pytest.mark.perf` test rendering one fixed Playground demo at fixed settings,
  asserting wall time under a **generous** ceiling (target ~10× the measured baseline —
  we're catching order-of-magnitude regressions, not milliseconds).
- Same shape for the two routes that dominate interactive latency (`/resolve`,
  `/animate/stream` start).
- Print the measured time on every run (not just on failure), so a slow drift is visible
  before it trips the ceiling.

### 5. A real end-to-end through the real routes

- Use the Playground project (deterministic, already seeded) via the Flask test client:
  `POST /playground` → `GET /projects/playground` → render one segment → assert the
  response is a real clip **and** that its frames move.
- Gated on `live_db` + ffmpeg like the existing integration tests. This is the seam where
  both of this week's bugs lived: `test_assets.py` monkeypatches storage away and
  `test_app_routes.py` only checks 400/404 shapes, so nothing exercised the real path.

### 6. Dependency honesty

- Always print a collection summary: how many tests were skipped and why
  (`ffmpeg`, `torch`, `db`). "487 green" currently hides an unknown number of skips.
- `--strict-deps` turns those skips into failures, for a machine that should have
  everything.

---

## Acceptance criteria

The step is done when **reintroducing each of this week's bugs turns the suite red**:

1. Restore the `sync="song"` pre-roll for montage inputs (drop the `montage_slot` branch
   in `_video_src0`) → `assert_moves` must fail on the montage demo.
2. Point a card preview back at the raw asset URL → the byte-ceiling test (step 1) must
   fail. *(This one lands with step 1; step 0 only needs criteria 1 and 3.)*
3. Make any render handler return a constant frame → `test_card_impact` must fail for
   that card.

Verify each by making the change locally, running the suite, seeing red, and reverting.
A safety net nobody has watched fail is not a safety net.

## Risks

- **Threshold too tight** → flaky failures on a legitimately subtle card. Mitigated by the
  6× margin and by printing measured values on failure.
- **Perf test flakiness** on a loaded machine → generous ceiling, `perf` marker so it can
  be deselected, and the measured value always printed.
- **The isolation fixture breaking existing tests** that quietly relied on real paths →
  land it as its own commit so a bisect is trivial.
