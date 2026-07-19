# Step 04 — Backend seam tests, and the GC data-loss bug

**Goal.** Put a test under every backend surface a later step rewrites — and fix the one
bug in this plan that silently deletes user data.

**Blocked by.** Steps 02, 03.

**Gates.** Step 09 (`export.py` helpers, `_prune_locked` dedupe) and step 10
(`validate` split) are **unsafe** until this lands. See the table at the bottom.

> Line numbers are a snapshot — re-grep before relying on one.

---

## 1. The GC can delete live clips — `cache_gc.py:66`

This is a behaviour fix, not a cleanup, and it is the reason this step is not purely
additive.

`cache_gc.py:66` wraps `output_hash` in a broad `except`. If hashing ever raises, the
segment's clips are treated as **unreachable** and the sweep deletes them. A genuine bug in
hashing therefore degrades into silent destruction of rendered work rather than a loud
failure.

**Order matters:** write the test that pins the intended behaviour *first* (a raising
`output_hash` must abort the sweep, or at minimum leave the clips alone), watch it fail,
then narrow the except clause. Do not fix it and test afterwards — the whole point is that
the current behaviour is plausible-looking.

---

## 2. `graph_validate.validate` — a table-driven case per rule

`graph_validate.py:41-174`. One 130-line function, C901 **35**, 34 branches, 58 statements
— the worst in the repo. It is already six comment-delimited sections:

| Rule | Lines | Covered today? |
|---|---|---|
| outputs | `:63-87` | partially |
| bindings | `:90-93` | partially |
| combine slots | `:96-99` | partially |
| montage exclusivity | `:107-151` | ✅ `test_montage.py:350,379` |
| merge sources | `:155-164` | ❌ **none** |
| acyclic | `:166-174` | ❌ **none** |

Cycle rejection and the merge-source rule have no test at all. Write one case per rule,
named after the rule, so step 10's split can be verified rule-by-rule.

**Why this gate is hard:** a 130-line function with no per-rule coverage loses a rule
*silently* when split. Validation fails open — the graph renders, wrongly — rather than
throwing. Nothing goes red.

## 3. `routes/export.py` — the seams step 09 rewrites

- **HD-slot admission** (`:76-89` and `:139-151`): `acquire(blocking=False)` → 409 →
  `try: render_jobs.start(...) except: release; raise`. Test that a second concurrent
  export gets a 409 and that a failing `start` releases the slot. A leaked HD slot is
  invisible in dev and in CI — the next export just hangs.
- **Job teardown** (`:167/222-224`, `:231/256-258`): the `finally: _HD_RUNNING = None;
  _HD_SLOT.release()` pair. Test the error path, not just the happy path.
- **The lyric-line read** (`:65-66`, `:135`): duplicated from `cache_gc.py:37-46` **minus
  its `try/except`**. A corrupt analysis-cache JSON 500s the export route but is handled in
  the sweep. Pin the guarded behaviour here so step 09 can promote one shared helper.
- `_record_export` — the cache_gc reachability contract, untested. `test_export_segment.py`
  covers routing / 409 / hashing only.

## 4. `render_jobs.py` — 134 lines, zero coverage

`jobs.py` has two test files; its sibling has none. `ARCHITECTURE.md:213` calls
cancel-on-edit a core behaviour and nothing tests it.

Cover: `_prune_locked` (step 09 dedupes it against `jobs.py:73-83`, which is verbatim
identical — the docstring even says "mirrors `render_jobs._prune_locked`"), cancel during
run, the error state, and the `phase=` kwarg contract that `routes/export.py` depends on.

## 5. Smoke coverage: `logbus.py`, `llm.py`

- `logbus.py` (105 lines) — the ring buffer, and specifically the **`/logs` must never log**
  invariant (`CLAUDE.md:60`), which is asserted in prose only. It would feed itself. The
  frontend has `logbus.test.ts`; the backend has nothing. Small, and it guards a stated rule.
- `llm.py` (113) — the Ollama section-labelling path and its fallback.

---

## Acceptance criteria

1. Make `output_hash` raise → the GC test goes red, and no clips are deleted.
2. Delete any one rule from `validate` → its named case goes red. Repeat for all six.
3. Make `render_jobs.start` raise after the slot is acquired → the admission test goes red
   on a leaked slot.
4. Corrupt an analysis-cache JSON → the lyric-line test pins whichever behaviour you chose,
   and the export route and the GC sweep agree.

## Risks

- **Large step.** Split it: GC fix first (it is a real bug and wants its own bisectable
  commit), then `validate` cases, then `export.py`, then `render_jobs`, then the smoke tests.
- **Testing `export.py` may require more fixture scaffolding than expected** — it is the
  route file with the most stateful globals. If it fights back, that difficulty is itself
  the argument for step 09's extraction; note what hurt so step 09 can fix the right thing.

## What this gates

| Later refactor | Why it is unsafe first |
|---|---|
| 10 — `validate` → 6 named checks | a dropped rule fails open, not loud |
| 09 — `export.py` helpers | leaked HD slots are invisible in dev and CI |
| 09 — `_prune_locked` dedupe | two verbatim copies, neither tested |
