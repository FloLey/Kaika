# Cleanup series

One file per step. `00-backlog.md` and `01-safety-net.md` are the original wave;
`02`–`15` come from a three-way audit (backend / frontend / docs-tests-tooling) run on
2026-07-19.

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
