# Step 15 — Coverage debt: `segment.py` and `procgen.py`

**Goal.** Characterization tests for 1266 lines of zero-coverage backend.

**Blocked by.** Step 02 only.

**Why last, and why that is not a demotion.** Nothing in steps 06–14 refactors these two, so
their tests are not a prerequisite for anything — putting them in step 04 would have
inflated the critical path with work no other step waits on. **Pull this forward whenever
the tree is blocked** (for example while the uncommitted frontend work is in flight and
steps 05/11/12/13 are unavailable). It is the plan's designated filler.

> Line numbers are a snapshot — re-grep before relying on one.

---

## `backend/segment.py` (662 lines) — the largest untested module in the repo

It carries the entire review stage: the beat grid, Whisper alignment, vocal-activity
detection, and section clustering. Zero direct tests.

This is characterization work, not specification work — the goal is to pin what it *does* so
a future change has to be deliberate, not to assert what it *should* do. Prefer:

- pure helpers first (grid construction, boundary snapping, the clustering distance) — cheap
  and genuinely regression-catching
- small synthetic inputs over real audio fixtures; a 2-second generated click track exercises
  the beat grid without a 40 MB test asset
- committed golden outputs for the clustering, with a comment saying they were captured, not
  derived

`segment.py:26` also uses `List`/`Optional`/`Sequence`/`Tuple` while 35 other modules use PEP
585/604 builtins — step 09 covers the convention fix, but if you are in the file anyway,
coordinate so the two changes do not collide.

## `backend/procgen.py` (604 lines) — physics with no unit test

Exercised only transitively, by `test_gen_sim_cards.py` rendering the cards that call it.
That catches "the card is black" but not "the ripple propagator is subtly wrong".

It holds the DBM tree, the ripple propagator, the wave spectra and the caustics kit. Cheap,
high-value numeric invariants:

- `sim_dims` respects its cap
- `ripple_*` round-trips
- `dbm_tree` is deterministic for a given seed — **the important one**, because seeded
  determinism is what makes a render reproducible, and nothing currently checks it
- wave spectra stay within their documented range

Step 10 refactors `sources.py`'s five gen-sim callers into a shared `_gen_frames` scaffold.
These tests are not a prerequisite for that (the parity test covers the caller side), but
they make step 10's diff much easier to trust — so landing this **before** step 10 is a
reasonable choice if the ordering is otherwise free.

---

## Also worth picking up here if there is appetite

The audit found more zero-coverage modules than this step targets. In rough value order:

**Backend:** `config.py` (57 — env parsing/defaults).
*(`logbus.py`, `llm.py`, `render_jobs.py` are covered by step 04.
`rerender_spectrograms.py` is deliberately `omit`ted in `pyproject.toml:24` — correct, leave it.)*

**Frontend:** `lib/audio.ts` (97), `lib/pointsGen.ts` (69), `lib/lyricsFont.ts` (53),
`lib/assetPreview.ts` (46), `lib/useLogPoll.ts` (32), `lib/logCapture.ts` (22). Untested
components: `SettingsModal`, `ProjectList`, `LogsPanel`, `Processing`, `ReviewStep`,
`UploadStep`/`UploadZone`, `InputPicker`, `ProblemsPanel`. `lib/api.ts` has 48 exports and
`api.test.ts` covers ~5 — the right 5 (error/abort paths), but thin.

**`lib/assetPreview.ts` deserves a callout:** `docs/cleanup/00-backlog.md` step 1b names it
as the site of a duplicated URL regex (written twice, `:14` and `:38`) *and* the source of
the 1 GB-request class of bug. It still has no test. 46 lines. Do this one.

---

## Acceptance criteria

1. `make coverage` shows `segment.py` and `procgen.py` moving off zero — and the report is
   readable, which depends on step 02 having fixed the `coverage` target.
2. Change a constant in the ripple propagator → a `procgen` test goes red.
3. Re-seed `dbm_tree` with the same seed twice → identical output, asserted.
4. The new tests run in reasonable time. If a `segment.py` test needs real audio and takes
   >5s, mark it `perf` or move it behind a fixture gate rather than slowing every run.

## Risks

- **Characterization tests can cement a bug.** If something looks wrong while writing the
  test, say so in the test name or a comment (`# captured behaviour — see #NN, may be wrong`)
  rather than quietly asserting it is correct.
- **Golden outputs rot.** Keep them small and regenerable, and document the command that
  regenerates them next to the fixture.
