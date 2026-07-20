# Step 03 — Tests that cannot fail, made able to fail

**Goal.** Remove or repair the assertions that are decoration, before later steps lean on
them as a safety net.

**Blocked by.** Step 02 — there is no point auditing assertion quality on a suite that does
not run.

**Non-goals.** No new coverage (that is steps 04, 05, 15). This step only fixes tests that
already exist and cannot go red.

> Line numbers are a snapshot — re-grep before relying on one.

---

## The findings

### 1. `test_graph_registry.py` asserts nothing that can fail

- **`:15`** — `assert set(graph._VIDEO_PRODUCERS) == set(graph._VIDEO_HANDLERS)`.
  `graph_render.py:1961` already asserts this **at import time**, and `:1965` defines
  `_VIDEO_PRODUCERS = VIDEO_PRODUCERS` as a back-compat alias. If it were ever false,
  importing `backend.graph` would raise before this test could collect. The docstring even
  admits "The module asserts this at import" — the test body is unreachable.
- **`:26-28`** — `test_unknown_node_type_has_no_handler` asserts that
  `dict.get("totally-new") is None`. That tests Python.

**Fix.** Delete `:26-28`. For `:15`, either delete it or replace it with the assertion that
*would* catch something — the backend↔frontend parity that step 08 makes structural. Say
in a comment which one you chose and why.

### 2. `tests/helpers.py:96` hardcodes `version: int = 28`

`GRAPH_VERSION` lives at `frontend/src/lib/graph/factories.ts:160`. On the next bump this
silently stamps fixture graphs at a stale version — exactly the failure mode
`ARCHITECTURE.md:365-369` warns about: *"a stale `version` stamp on a fixture graph is
invisible to pytest and silently drops a card the moment the UI loads it."*

**Fix.** Read it from the same place `playgroundFixture.test.ts` does, or assert it matches
and fail loudly on drift. Do not leave a second copy of the number.

### 3. `paramHelp.test.tsx` lets a help-less card pass

Two independent holes:

- `INLINE_ARGS` (`:62-98`) omits 11 card types: `gate`, `scope`, `points`, `merge-points`,
  `extract`, `stylize`, `echo`, `transform`, `slideshow`, `output`, `signal`. Several of
  those *do* render inline args (per the `EXPECTED_BADGES` comments: `transform.mode/wrap`,
  `stylize.model/inpaint`, `echo.mode`, `extract.kind`, `slideshow.fit/box/threshold/hysteresis`,
  `gate.invert/divide`), so the "every inline argument has a help entry" assertion never
  sees them.
- `:157` — `EXPECTED_BADGES[spec.type] ?? 0` means a brand-new card rendering **no** badges
  at all passes silently.

**Fix.** Derive the card list from `NODE_TYPES` instead of hand-maintaining it: assert
`Object.keys(NODE_TYPES)` ⊆ `Object.keys(EXPECTED_BADGES)` ∪ a small *explicit* no-args
allowlist, then backfill the missing `INLINE_ARGS` rows. A new card should have to opt out
in writing, not by omission.

*This is the same pattern step 14 reuses for the step screens, so get the shape right here.*

### 4. Ten hand-rolled `afterEach(cleanup)` copies, one of them missing

`boxPadStability.dom.test.tsx` renders four times with **no** `afterEach(cleanup)`, so
mounted trees leak across its own tests. `portalTarget.dom.test.ts` also lacks it (lower
risk — it renders no components). Every other DOM test has its own copy.

**Fix.** Add `test.setupFiles: ["./src/__tests__/setup.ts"]` to `frontend/vite.config.js`
with a single global `afterEach(cleanup)`, and delete the ten duplicates. This also closes
the class of bug where a new DOM test forgets it.

---

## Explicitly NOT in this step

**Do not mass-adopt `tests/helpers.py`'s `edge()` / `node()` / `graph_of()` builders.**

They have zero callers today, while 17 test files hand-roll their own builders and **15**
define their own `OUT` dict. That looks like dead code begging for adoption. It is not:
`01-safety-net.md` already argued adopt-on-touch, and gave the reason — the 15 `OUT` dicts
differ in size, fps and background *meaningfully*, and rewriting them would silently change
what those tests assert.

Rewriting 15 passing files to fix a cosmetic inconsistency is the worse trade. This
paragraph exists so the next reader doesn't "fix" it.

---

## Acceptance criteria

Each repaired test must be watched failing:

1. Add a card type to `NODE_TYPES` with no help entry → `paramHelp.test.tsx` goes red.
2. Bump `GRAPH_VERSION` without touching `helpers.py` → the version assertion goes red.
3. Remove the global `afterEach(cleanup)` → at least one DOM test goes red from a leaked tree.

Verify each by making the change, running the suite, seeing red, and reverting. A test
nobody has watched fail is not a test.

## Risks

- **The global `cleanup` changes behaviour** for a test that quietly relied on a leaked
  tree. Land it as its own commit so a bisect is trivial.
- **Deriving from `NODE_TYPES` surfaces more missing help than expected.** If the backfill
  is large, split it: the guard in one commit (with the allowlist pre-populated to keep
  green), the backfill in the next, shrinking the allowlist to empty.
