# Step 08 — Codegen the three hand-mirrored tables

**Goal.** Make backend↔frontend constant drift impossible instead of currently-lucky.

**Blocked by.** Step 02 (CI has to actually run the `--check`).

**Size.** M. Pure prevention — the sets match today. That is the argument *for* doing it
now, while the diff is empty.

> Line numbers are a snapshot — re-grep before relying on one.

---

## The three tables

| Backend | Frontend | Guard today |
|---|---|---|
| `graph_common.py:75` `VIDEO_PRODUCERS` (20 entries) | `lib/graph/core.ts:71` (built from `VIDEO_SOURCES` + `VIDEO_FX`) | **none** |
| `graph_hash.py:27` `_SIGNAL_HASH_FIELDS` | `lib/graph/hash.ts:12` `SIGNAL_HASH_FIELDS` | **none** |
| `graph_hash.py:44` `_SLOT_CARDS` | `lib/graph/hash.ts:49` `SLOT_CARDS` | a comment saying "mirrors backend" |

`docs/cleanup/00-backlog.md` Step 4 flagged this and named the reason it is nasty:
*"hand-copied today and **drift is silent** (the digests differ on purpose, so nothing fails
loudly)."*

## Why it matters more than it looks

The two failure modes are different, and the second is the bad one:

- **`VIDEO_PRODUCERS` drift** — a card added to the backend producer set but not to
  `core.ts` makes the frontend refuse to render it. Annoying, but visible immediately.
- **`graph_hash` drift** — the two sides compute cache keys from different field sets. The
  preview and the export silently disagree about what a graph *is*. It would be reported as
  "the export doesn't match what I previewed", diagnosed as a render bug, and take a day.

There is no red test for either.

---

## The change

The machinery already exists: `backend/gen_fluid_params.py` generates
`frontend/src/lib/fluidParams.js` and CI runs `python -m backend.gen_fluid_params --check`
(`ci.yml:34`) to assert no-diff. This step is an extension of that pattern, not new
machinery.

1. Extend the generator to emit a second file — `frontend/src/lib/generated/graphConstants.ts`
   — carrying the three tables from their backend definitions.
2. Rewrite `core.ts` and `hash.ts` to import from it. Keep `VIDEO_SOURCES` / `VIDEO_FX` as
   *frontend-side* groupings if they carry meaning the backend doesn't have (the comments at
   `core.ts:64-70` suggest they do — `VIDEO_FX` encodes "never emitter sources", which is a
   rendering rule, not a producer list). Generate the union; derive the groupings locally,
   and assert the union matches.
3. Wire into `make gen-params` and add the `--check` to CI alongside the existing one.
4. Extend the never-hand-edit rule in `CLAUDE.md` (currently names `fluidParams.js` and
   `playground_pipelines.json`) and in `ARCHITECTURE.md`'s codegen-contract section.

## Acceptance criteria

1. `make gen-params` produces a **no-op diff** on a clean tree.
2. Hand-edit one entry in the generated file → CI's `--check` fails.
3. Add a card type to `VIDEO_PRODUCERS` in `graph_common.py`, run `make gen-params`, and the
   frontend picks it up with no hand edit.
4. This is also the replacement for the unreachable assertion at
   `test_graph_registry.py:15` that step 03 flagged — close that loop here.

## Risks

- **Generating into `.ts` rather than `.js`** — `fluidParams.js` is JavaScript; the graph
  constants want types (`Set<string>`). Confirm the generated file passes `tsc --noEmit`
  and is excluded from Prettier/ESLint the same way the existing generated file is, or CI
  will fight you over formatting on every regeneration.
- **Over-unifying.** If a frontend grouping genuinely has no backend counterpart, generate
  the shared union only and leave the grouping hand-written with an assertion. A generator
  that forces a false shared model is worse than the copy.
