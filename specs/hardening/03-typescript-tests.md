# 03 — Tests to TypeScript + targeted coverage

> All source is now `.ts/.tsx`, but the 10 test files in `frontend/src/__tests__/` are
> still `.js/.jsx` and therefore **not type-checked** (`allowJs` + `checkJs:false`), and
> `vite.config.js`'s `test.include` only matches `*.test.{js,jsx}` — so a future `.test.ts`
> would be silently skipped. This converts the tests to TypeScript (gaining type-checked
> assertions + prop passing), retargets the tooling globs, and adds focused tests for the
> highest-risk code that has none today (the fluid simulation internals, the API error
> path, the shared drag hook). Mostly frontend; one backend test file.

## Locked decisions

1. **Convert in place, keep the `.test.`/`.dom.test.` naming.** `*.test.js → *.test.ts`;
   `*.dom.test.jsx → *.dom.test.tsx` (keeping the `// @vitest-environment jsdom` marker).
2. **Tests become type-checked** under the existing `tsconfig.json` (`include: ["src"]`
   already covers `__tests__`). Once they're `.ts/.tsx`, fix whatever `tsc` surfaces
   (wrong mock props, stale helper signatures) — that's the point.
3. **Retarget every tooling glob to `{ts,tsx}`:** `vite.config.js` `test.include`, the
   eslint test block (spec 01), and confirm tsconfig still includes them.
4. **`allowJs` stays** (the generated `lib/fluidParams.js` still needs it) but `checkJs`
   stays `false` — only `fluidParams.js` rides on `allowJs` now; note it in the tsconfig
   comment.
5. **Targeted, not exhaustive, new coverage.** Add tests only for the riskiest untested
   code; do not chase a coverage number (see PLAN.md non-goals).

## Architecture this builds on

- `frontend/src/__tests__/` — `animationNodes.test.js`, `graphModel.test.js`,
  `logbus.test.js`, `segments.test.js` (node env) and `animationCanvas.dom.test.jsx`,
  `fluidPath.dom.test.jsx`, `graphCanvas.dom.test.jsx`, `registry.test.jsx`,
  `studioLeaves.dom.test.jsx`, `studioShell.dom.test.jsx` (jsdom). The `studioShell` /
  `fluidPath` files are the current best patterns (render + interaction, media stubs).
- `frontend/vite.config.js:25-28` — `test.environment: "node"`, `test.include:
  ["src/**/*.test.{js,jsx}"]`.
- `frontend/tsconfig.json` — `allowJs:true`, `checkJs:false`, `include:["src"]`.
- `backend/fluid.py` — the time-varying sim + spectral-Poisson solve. Tested only by
  `tests/test_fluid_perf.py` (dtype/`complex64` guards) and `test_fluid_modulation.py`
  (param broadcasting) — **no behavioural tests** of advection, grid-wrap, or tonemap.
- `frontend/src/lib/api.ts` (`jsonOrThrow` error mapping) and `lib/useDragPad.ts` (shared
  by `PointsNode` + `PathEditor`) — zero direct tests.
- **Depends on spec 02** so the converted tests import the centralized domain types.

---

## Step 1 — Convert the test files + retarget the tooling

**Goal.** Tests are TypeScript and actually collected + type-checked.

**Files.** `git mv` the 10 files in `src/__tests__/`; `vite.config.js`; `eslint.config.js`
(if not already widened by spec 01); `tsconfig.json` comment.

**Design.** `git mv *.test.js *.test.ts` and `*.dom.test.jsx *.dom.test.tsx`. Set
`vite.config.js` `test.include: ["src/**/*.test.{js,jsx,ts,tsx}"]` (or `*.test.*`). Add
type annotations only where `tsc`/`vitest`'s types require (mock fns via `vi.fn()`,
component props in `render(<X .../>)`). Imports of converted source drop the `.jsx`/`.js`
extension where needed (extensionless, per the migration rule).

**Reuse.** `@testing-library/react` + `vitest` are already typed; jsdom marker comments
carry over unchanged.

**Acceptance.** `npm run test` collects all 10 (count unchanged); `npm run typecheck`
includes the tests and is green.

**Verification (two-audience).** *Agent:* `npm run test` → same test count green;
`npm run typecheck` green with `__tests__/*.tsx` checked; `find src/__tests__ -name '*.jsx' -o -name '*.js'` empty. *User:* none.

**Risks.** Type-checking the tests will surface real mismatches (e.g. a test passing a
prop the component no longer accepts) — those are bugs to fix, not suppress. A test that
imported a renamed/removed export breaks loudly; good.

---

## Step 2 — Add tests for the riskiest untested code

**Goal.** Cover the code where a silent regression would be costly and is currently
invisible.

**Files.** new `tests/test_fluid_internals.py` (backend); extend
`src/__tests__/` with `api.dom.test.ts` (or node) and `useDragPad.test.ts`.

**Design.**
- **`fluid.py` internals** (highest value — the core visual algorithm, only perf-tested):
  on tiny grids (8×8 / 16×16, fast) assert (a) **grid wrap/periodicity** — dye injected
  near an edge with `wrap` on reappears on the opposite side; (b) **advection direction** —
  inject a point + a constant velocity, step, check the centroid moved the expected way;
  (c) **tonemap clamps** dye/output into `[0,1]`; (d) **dissipation** monotonically
  decays a static dye field. Compare numerically within ±epsilon, not pixel-exact.
- **`api.ts` error mapping** — stub `fetch` (non-JSON 200 → throws with the body in the
  message; JSON non-ok → throws `error`/`detail`; `getLogs` failure rejects without
  logging). Guards the user-visible error UX + the no-runaway-log invariant.
- **`useDragPad`** — simulate pointerdown→move→up: `norm` clamps to `[0,1]` within the
  pad rect; `onMove` fires per move; `onEnd` reports `moved:false` for a click vs
  `moved:true` after a drag.

**Reuse.** The `studioShell`/`fluidPath` render+stub patterns; pytest's numpy asserts and
the existing fluid test fixtures.

**Acceptance.** New tests pass and fail when the behaviour they assert is broken (sanity-
check by temporarily inverting a sign).

**Verification (two-audience).** *Agent:* `pytest -q` (incl. the new fluid file) +
`npm run test` green; the fluid tests run in well under a second on tiny grids. *User:*
none.

**Risks.** Fluid numerics can be sensitive to defaults — pin the params each test uses and
assert tolerances, not exact floats, so the tests are robust to harmless reordering.

---

## Step 3 — Confirm the gates pick up the TS tests

**Goal.** CI runs the now-TS tests with no workflow change.

**Files.** none (CI already runs `npm run test` / `pytest`); optional `DEVELOPMENT.md`
note that tests are TypeScript + type-checked.

**Acceptance / Verification.** *Agent:* `npm run test`, `npm run typecheck`, `pytest -q`
all green; `git grep -n "test.{js,jsx}" frontend/vite.config.js` shows the widened glob.
*User:* none.

**Risks.** None — same commands, broader globs.

---

## v1 boundary & extension points

**This spec:** tests are TypeScript, type-checked, and collected by the widened globs; the
fluid core, API errors, and the drag hook have first coverage. **Designed-for:** new tests
are written in TS by default and the compiler catches drift between a test and the code it
exercises. **Out of scope (PLAN.md non-goals):** a CI coverage threshold and exhaustive
per-module unit tests — this adds the high-value tests, not a percentage gate.
