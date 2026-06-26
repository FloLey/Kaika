# Hardening — pre-feature cleanup

> A full read-only review of the codebase after the polish tail (TS migration, the
> `useStudioPlayback`/`PathEditor` extractions, the Flask blueprint split, the formatter
> gates) surfaced a small set of issues that will make future feature work harder or hide
> bugs. This folder is the buildable plan to close them **before** adding new features.
> Four independent specs, each shippable on its own green gate.

## Why now

The standout finding was discovered during verification, not just reported: **ESLint
no longer covers the codebase.** Its flat config matches only `src/**/*.{js,jsx}` and
`typescript-eslint` isn't installed, so every `.ts`/`.tsx` file — i.e. *all* source
after the migration — is unlinted, and the `no-explicit-any` disables already in the
tree are inert. A clean `npm run lint` is currently misleading. The rest of the tail is
type centralization (8 unsafe casts + 13 `Promise<any>` all trace to domain types living
in components instead of `lib/types.ts`), test type-checking, and backend HTTP-layer
consistency.

## Steps

| Spec | Delivers | Depends on |
|---|---|---|
| [01 — ESLint for TypeScript](01-eslint-typescript.md) | `typescript-eslint` wired up so `.ts/.tsx` are actually linted; the gate is real again | — |
| [02 — Centralize domain types + typed API](02-domain-types.md) | `Segment`/`Signal`/`StemInfo` in `lib/types.ts`; typed `api.ts` + `segments.ts`; **all 8 casts + 13 `Promise<any>` gone** | 01 |
| [03 — Tests to TypeScript + targeted coverage](03-typescript-tests.md) | `__tests__/*` → `.ts/.tsx` (type-checked); vitest/tsconfig aligned; tests for the riskiest untested code | 02 |
| [04 — Backend HTTP-layer hygiene](04-backend-http-hygiene.md) | `@json_body` on `/segment`; `validate_job_id` + shared error shape; `routes/media.py`→`serving.py`; minor `db.py` tidy | — (independent) |

**Dependency order:** 01 → 02 → 03 (each frontend step is guarded by the previous gate);
**04 is independent** of the frontend specs (no URL/JSON contract change) and can land in
any order.

## Reuse — what's already in place

- `lib/types.ts` already holds the graph types (`GraphNode`, `Graph`, `OutputSettings`,
  …) — the natural home for `Segment`/`Signal`/`StemInfo` (spec 02).
- `eslint.config.js` is already a flat config with the react-hooks rules — spec 01 adds a
  second block, it doesn't rewrite it.
- `web.py` (`json_body`, `validate_audio_params`) is the shared HTTP layer — spec 04
  extends it (`validate_job_id`, `error_response`).
- `tests/test_app_routes.py` (route smoke tests) guards spec 04's moves; the
  `studioShell`/`fluidPath` jsdom patterns guard spec 03.
- CI (`.github/workflows/ci.yml`) already runs `npm run lint` / `npm run test` / `pytest`
  / `black --check` / `format:check` — these specs make those gates cover more, not add
  new jobs.

## Deliberate non-goals

Considered during the review and **rejected** as over-engineering for a local,
single-user creative tool:

- **Job persistence / DB-backed jobs.** `jobs.py` is in-memory; jobs are lost on
  restart. Documented as "fine for dev" — keep it.
- **Upload rate-limiting / DoS quotas.** No multi-tenant threat model.
- **Log rotation / persistent backend logs.** The capped in-memory ring is sufficient.
- **Scheduled render-cache eviction.** Opportunistic eviction after each render is fine.
- **CI coverage thresholds.** Would force busywork; targeted tests (spec 03) are better
  ROI than a percentage gate.
- **Config consolidation** (`config.py` vs `paths.py`) and **`from __future__` removal** —
  cosmetic.
- **Path-traversal "hardening."** Mostly moot: Flask's default `<string>` URL converter
  already excludes `/` in `job_id`/`name`, so the media routes can't be walked. Spec 04
  adds `job_id` validation for **fail-fast consistency**, not as a security fix — framed
  as such so it isn't mistaken for closing a hole.

## v1 boundary

After these four specs: the lint gate covers the whole codebase, domain types live in one
place with no casts at the boundaries, tests are type-checked TypeScript, and the backend
HTTP layer validates and errors uniformly. Future features inherit a codebase where the
type system and the linter actually have teeth — which is the point of doing this before,
not after, the next feature.
