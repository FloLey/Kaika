# Step 22 — Cover the HD-export seam

**Status: DONE** — `ca6c396`, then `66175d9` (wave 4). `routes/export.py` 46% → 53% → **80%**,
`procgen.py` 95% → 99%.

> The job bodies this step called "still uncovered, deliberately" are covered now, using the
> way out this step itself argued for: assert properties, never mock a renderer and check the
> mock. Every test was mutation-checked — and one did **not** survive that check on the first
> pass, comparing the test file's own key helper against itself. See
> [`29`](29-wave4-layout-and-the-unaudited-layer.md). What remains uncovered (the diffusion
> body, the `generate` arm, the ffmpeg mux arm) is listed with a reason in
> `tests/test_export_hd_jobs.py`'s docstring.

The procgen half is the interesting one and it argues against reading these numbers at
all: procgen was *already* 95% line-covered with almost no direct tests, because every line
is walked transitively by a card rendering. That proves "the card is not black". The new
tests assert **properties** instead — seeded determinism *and its converse* (a routine that
ignores its seed passes the first test), `dbm_tree` actually being a tree, `omega² = g·k`,
and a ripple kernel that loses energy rather than gaining it.

⚠ **Still uncovered, deliberately**: `_segment_hd_job`, `_export_job`,
`_regenerate_hd_images`, `_regenerate_hd_stylize` (`259-309`, `316-349`, `383-540`). They
need a diffusion model or a full render to reach, and a mock deep enough to execute them
would be testing the mock. That is the coverage theatre this step warned against — left
honestly uncovered instead.

> Three bugs found while writing these, all mine and all from not reading a signature:
> `dbm_tree` returns `(pts, parent, tip)`; `dbm_polylines` yields `(points, depth)` pairs;
> and `ripple_step` returns the tuple `(ĥ⁺, ĥ)`, which I re-wrapped into another tuple — so
> every iteration added an array dimension and the shape grew exponentially. It presented
> as a hung suite.

**Tier.** Core.

**Goal.** Put tests under the largest uncovered block in the repo — which happens to be the
one place "the export doesn't match the preview" bugs live.

**Blocked by.** Nothing. **Worth doing early**, because steps 19 and 20 both rewrite parts of
`routes/export.py` and would rather land on top of coverage than under it.

**Size.** L.

> Line numbers and coverage figures are a snapshot (measured 2026-07-20) — re-measure before
> relying on one.

---

## 1. `routes/export.py` — 46%

142 of 264 statements uncovered. Missing ranges: `260-310, 317-350, 365-375, 384-443,
456-526`.

`tests/test_export_segment.py` and `tests/test_export_hd_slot.py` exist, but they touch the
cached path and the slot-admission path only. The HD regeneration body — the part that
decides what the user actually downloads — is dark.

This matters more than a coverage percentage usually does. The export path is where the
render pipeline runs under *different settings* than the preview: a different grid
(`nativeShort` at `:229`), a different cache, a separate HD regeneration for images and
stylize. Every divergence between what the user previewed and what they exported is
introduced somewhere in these 142 statements. `CLAUDE.md` names the whole/streamed lockstep
as a hard invariant and `test_card_impact` enforces it for cards — nothing does the
equivalent for preview-vs-export settings.

Priorities within the file, highest value first:

- **`456-526` — the HD stylize path.** Steps 19 and 20 both rewrite it (rekeying the cache;
  making the write atomic). Tests here are a prerequisite for changing it confidently, not a
  follow-up.
- **`384-443` — HD image regeneration.** Includes the progress-counter bug below.
- **`317-350`, `365-375`** — the segment-export branches.
- **`260-310`** — settings resolution. Cheap to cover, and it is the input to everything else.

**Bundle the small bug found while auditing:** `routes/export.py:419` increments `done` only
inside `if not dest.exists()`, so the progress log reads "HD image 1/12" for the first
*uncached* image regardless of its actual position. Cosmetic, but it is in the block being
covered and a test for the progress contract will trip over it anyway.

## 2. `procgen.py` — 95% covered, zero direct tests

The more interesting gap, and the one wave 2 left unfinished.

Every line of `procgen.py` is executed — transitively, by `tests/test_gen_sim_cards.py`
rendering the cards that call it. That catches "the card is black". It cannot catch "the
ripple propagator drifted", because nothing asserts a numeric property of the output.

`specs/cleanup/15-coverage-debt.md` named the one that matters and it is **still undone**:
**`dbm_tree` seeded determinism is asserted nowhere.** Seeded determinism is what makes a
render reproducible, and reproducibility is what the entire content-hash cache is built on —
if a generator is not deterministic for a fixed seed, the cache serves clips that do not match
a fresh render, and the fault looks like a caching bug rather than a generator bug.

A dozen numeric invariants, cheap to write:

- **Determinism**: same seed → identical array, for `dbm_tree` and each `procgen` entry point.
  Assert across two calls *and* across two fresh processes if any global RNG state is
  involved.
- **Independence**: different seeds → different output (guards against a seed being ignored,
  which determinism tests alone would happily pass).
- **Bounds/shape**: outputs in their documented range, no NaN, expected dtype and shape.
- **Step 18 interaction**: the noise-lattice `lru_cache` from step 18 is only safe if these
  determinism assertions exist. If 18 lands first, this is retroactive cover; if this lands
  first, 18 gets a real gate. **Either order works — but say in the commit which one it was.**

## 3. Lower-priority gaps, listed so they are not forgotten

Not this step's job; recorded because the audit measured them.

| Module | Cover | Note |
|---|---|---|
| `backend/segment.py` | 43% | `141-196` Whisper alignment, `208-264` vocal activity, `567-632` section clustering — the whole review stage. Wave 2 took it 13%→43%; the rest is an L of its own. |
| `backend/imagegen.py` | 23% | Lazily imported; needs a fake-pipeline fixture. |
| `backend/routes/{uploads,animation,stylize,settings,serving}.py` | 48–66% | ~210 statements; best done as one route-contract pass. |
| `backend/llm.py` | 28% | Small — `56-113` is the whole call path. |

---

## Verification

1. `make test` with coverage; `routes/export.py` moves substantially off 46%. **Pick the
   target by what the tests assert, not by the number** — a percentage reached with
   assertions that cannot fail is exactly what wave-2 step 03 had to undo.
2. Each new test is watched failing first: break the thing it covers, confirm red, restore.
3. The `procgen` determinism tests fail if a seed is ignored — verify by temporarily hardcoding
   the seed.

## Acceptance criteria

- The HD stylize and HD image bodies have tests that assert *behaviour* (what is cached, what
  is regenerated, what the progress callback reports), not just that a route returns 200.
- `dbm_tree` seeded determinism is asserted.
- The progress-counter bug at `:419` is fixed with a test that would have caught it.
- `specs/cleanup/15-coverage-debt.md` gets a note that its `procgen` half is now done (its
  `segment.py` half is already stale — it says "zero direct tests", which stopped being true
  when `tests/test_segment_helpers.py` landed).

## Risks

- **Coverage theatre.** The `pyproject.toml` gate is a floor, not a goal. A test that exercises
  lines without asserting anything meaningful makes the number go up and the codebase no
  safer — wave-2 step 03 exists because that already happened here once.
- **Over-mocking the export path** until the test no longer resembles a real export. The
  wave-2 `test_studio_e2e.py` pattern — real routes, real fixture project — is the model to
  follow where affordable.
