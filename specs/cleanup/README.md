# Cleanup series — waves 1 to 5 (all done)

The code-quality series, one file per step. **Every wave has landed**, which is why the whole
series lives in `specs/` — the reasoning is kept because it is still the best statement of
why the work existed, not because anything is pending.

| Wave | Steps | Audited | Theme | State |
|---|---|---|---|---|
| 1 | `00`–`01` | — | the original backlog | **done** — see [`00-backlog.md`](00-backlog.md)'s status table |
| 2 | `02`–`15` | 2026-07-19 | correctness infrastructure | **done** — last commit `7b36ff6` (step 14) |
| 3 | `16`–`28` + [audit](16-28-wave3-audit.md) | 2026-07-20 | speed, and wave 2's leftovers | **done** — several steps closed on *measurement* rather than by being built |
| 4 | [`29`](29-wave4-layout-and-the-unaudited-layer.md) | 2026-07-25 | UI grouping + the CSS layer + the honest tails | **done** — last commit `6dfad27` |
| 5 | [`30`](30-wave5-one-app-instead-of-two.md) | 2026-07-26 | the `?ui=next` migration + the deferred splits | **done** — last commit `7ae510c` |

**There is no open cleanup backlog.** `docs/cleanup/` used to hold wave 3 and no longer
exists: under `CLAUDE.md`'s rule that `docs/` carries only living things, an empty backlog is
not one. A wave 6 starts by auditing the tree — wave 5's own "left open" section is the
closest thing to a head start, and it is four items long.

⚠ **Read a step's own status header, never a summary table, when you want to know what is
done.** Wave 3's index claimed ten of its thirteen steps were unbuilt when nearly all of them
had landed — stale by a dozen commits, and it would have sent the next reader off to redo
finished work. Wave 4 (`29`) opens on that finding, and this table is the same kind of claim:
if it disagrees with a step file, the step file is right.

Two caveats worth keeping:

- `00-backlog.md`'s status table marks several wave-1 rows *partial* or *open* and
  forward-links to the wave-2 step that picked each one up. Those links still resolve —
  every file they point at is in this folder.
- Wave 3's steps were audited in 2026-07-20 and several carry **corrections to their own
  earlier drafts** (steps 16, 25, 26, 27 especially). The corrections are the interesting
  part: three of them are the same mistake — a claim written down without being run.

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
