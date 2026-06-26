# Polish — Master Plan (the deferred refactor tail)

The extensibility/optimization pass (the 8-phase refactor) shipped to `main` with CI
green. Four items were **consciously deferred** at the time — low-ROI-then, or best
done after the rest — and noted in commits + `DEVELOPMENT.md`. This folder turns each
into a **buildable, independently-verifiable spec**, same cadence + format as
`specs/create-animation/`: build one, verify it green, ship it, move on.

None of these change behaviour. They finish the TypeScript migration, extract two
remaining shells, reorganise the Flask routes, and apply the one-time auto-format —
so the codebase is uniformly typed, modular, and style-gated for whatever gets built
next.

---

## Build steps (one spec each)

| # | Spec | Delivers | Depends on |
|---|---|---|---|
| 01 | [`01-ts-migration.md`](./01-ts-migration.md) | Convert the remaining animation + studio/fluid `.jsx` → `.tsx`; tighten `NodeSpec.Component` from `any` to `NodeProps` | the TS foundation (shipped) |
| 02 | [`02-component-hooks.md`](./02-component-hooks.md) | `useStudioPlayback` (from `Studio`) + `PathEditor` (from `FluidLab`) — the B5.1 deferred extractions | **folds into 01** |
| 03 | [`03-route-blueprints.md`](./03-route-blueprints.md) | Split `app.py` into Flask blueprints + a shared helpers module | the route smoke tests (shipped) |
| 04 | [`04-formatters.md`](./04-formatters.md) | One-time Black + Prettier reformat commit; turn on the CI `format:check` gate | **after 01** |

**Dependency order.** **01 first** (it's the bulk). **02 folds into 01** — `Studio`
and `FluidLab` are rewritten to `.tsx` in 01's last step, so extract their hooks/
subcomponents *then*, typed from the start (not a second churn). **03 is
independent** (backend only) — do it whenever. **04 after 01** so Prettier formats
the final `.tsx`, not throwaway `.jsx`.

Suggested sequence: **01 → 02 → 04** (frontend, ending in a clean formatted tree),
with **03** slotted in anytime alongside.

---

## What's already in place (reuse — do not reinvent)

| Need | Reuse | Path |
|---|---|---|
| TS toolchain (allowJs, strict, `tsc --noEmit` in CI) | `tsconfig.json`, `npm run typecheck` | `frontend/` |
| Domain types (discriminated `GraphNode` union) | `types.ts` | `frontend/src/lib/types.ts` |
| Node-card props contract | `NodeProps` | `frontend/src/components/animation/nodes/registry.ts` |
| TS conversion precedent (rename + extensionless imports) | `output.ts`, `graphModel.ts`, `registry.ts`, `useGraphEditor.ts` | `frontend/src/` |
| Pointer-drag hook (for `PathEditor`) | `useDragPad` | `frontend/src/lib/useDragPad.ts` |
| Hook-extraction precedent | `useGraphEditor.ts` | `frontend/src/components/animation/` |
| Shared HTTP helpers | `json_body`, `validate_audio_params` | `backend/web.py` |
| Route smoke tests (guard the blueprint split) | `test_app_routes.py` | `tests/` |
| Formatter config (Black + Prettier + pre-commit) | `[tool.black]`, `.prettierrc.json`, `format` target, blame-ignore | `pyproject.toml`, `frontend/`, `Makefile`, `.git-blame-ignore-revs` |

---

## Global acceptance

- Each spec ends on its green gate — `npm run typecheck && lint && test && build`
  (frontend) or `pytest && ruff check` (backend) — and the existing test suites
  (72 vitest, 113 pytest) stay green throughout.
- No behaviour change: a `make dev` end-to-end smoke (upload → segment → signals →
  animate → render) works identically before and after each spec.
- Every spec references **real, current** code (verified against the tree: 6 files
  already `.ts(x)`, ~30 `.jsx` remaining at the time of writing).
