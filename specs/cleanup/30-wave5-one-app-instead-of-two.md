# Wave 5 — one app instead of two (done)

**Status: done.** Commits `5a473a7` … `7ae510c`, 2026-07-26/27. Backend and frontend
suites green at every commit; nothing was pushed mid-wave.

Wave 4 closed with *"there is no open cleanup backlog. A wave 5 starts by auditing the
tree."* This is that audit and what it found.

---

## What the audit found

The codebase is not rotting. Ruff clean, zero TODO/FIXME, an AST scan over every
top-level definition in `backend/` found **zero** unreferenced ones, backend coverage 76%,
frontend 70.7%. What it carried instead was **one large duplication and a set of named
loose ends**.

The duplication was `?ui=next`. `lib/uiFlag.ts` had shipped a routed shell as live code
beside the step-string one — *"nothing is deleted until one of them wins"*. It had won
weeks earlier and nothing had been deleted. The fork was **not** two files:

| fork | found by | size |
|---|---|---|
| `main.tsx` root branch | grep `isNext` | 2 arms |
| `Studio.tsx`, `SignalCard.tsx`, `AnimationCanvas.tsx` ×4, `useGraphEditor.ts` ×3 | grep `isNext` | 9 sites |
| **`ReviewStep.tsx`'s `shared` prop** | **nothing — it is a prop, not a flag** | **12 sites, zero tests** |
| **`useStudioPlayback.ts`'s shared arm** | **nothing** | **~180 of 261 lines** |

The two invisible forks are the finding worth carrying forward: **a feature flag threaded
as a prop is invisible to the search everyone runs.** Roughly 1,500 lines were one of two
answers to a settled question.

---

## Step 30 — the shell migration (10 commits)

The organising rule: **the flip is two files and six lines, atomically revertable.**
Everything before it exists to make it behaviour-preserving; everything after is a
deletion under a constant.

1. `5a473a7` — `useProject` returned a fresh object literal, so the shell's three
   URL-reconciling effects (which depend on `p` itself) ran every render behind ref
   guards. Memoized before the flip promoted them to the boot path.
2. `2faa043` — `ExportConsole` was *not* the superset it claimed: it silently dropped
   `ExportStep`'s ref-guarded `fitToRatio` aspect snap, the only thing that ever corrects
   a stored export size against a rotated canvas.
3. `f30d480` — first-ever `ReviewStep` tests, plus shared-transport tests, **before** the
   deletions in 7 and 8.
4. `5d07b60` — the Playground opened on an empty signals tab.
5. `2f0f010` — **the flip.** `main.tsx` + `isNext() → true`, same commit.
6. `4a390ac` — `App.tsx` + `ExportStep.tsx` deleted (769 net lines).
7. `1c4ae22` — one transport; `useStudioPlayback`'s private engine deleted.
8. `2abae48` — the signal card has one layout; `SignalCardNext` → `SignalCardView`.
9. `120c609` — the editor de-branched, `lib/uiFlag.ts` deleted.
10. `c6f6f15` — `10-next.css` (533 lines, four subsystems) filed by subsystem.

### The three traps, and which ones bit

- **The flip must be atomic.** Flipping `main.tsx` alone ships a green, broken commit:
  AppShell mounts `lib/transport` while `Studio.tsx` still reads the flag as false and
  mounts its own `<audio>` — two elements playing the same song. Anticipated; avoided.
- **`isNext()` becomes a constant, not a deletion.** Deleting `uiFlag.ts` at the flip
  forces all six de-branchings into one unreviewable commit. Anticipated; avoided.
- **The Playground tab.** Fixing the three `navigate()` call sites was NOT enough, and the
  test is what said so: `parseRoute` also hardcoded `signals` for a URL naming no tab, and
  the shell's reconcile deliberately bails when the URL already names the right stage. The
  rule belonged in the grammar — an unnamed tab means *this project's default tab*. That
  made `/signals` a form the parser must accept, because `formatRoute` now omits whichever
  tab is the default rather than always omitting signals.

### What was NOT done, and why

- **`<StudioBar>`.** Step 13 asked for it alongside `useCompositionNav`. The nav landed
  (`54529df`); the bar did not. It is a JSX extraction with a different risk profile than
  a state machine and belongs in its own commit.
- **CompactCard's modal fallback.** The plan said an always-defined `inspectNode` makes it
  dead. It does not: `ctx` itself is optional, so a card rendered with no context (tests,
  stubs, previews) still has no dock. Removing the branch would mean making `ctx`
  required — far wider than the commit, for a path that is genuinely reachable. Kept, with
  both comments rewritten to say that rather than to cite the flag.
- **42 of the 50 unreferenced CSS classes.** `.k-segment`, `.lv-error`, `.src-backend`,
  `.gc-port-*` are all built by template composition (`k-${kind}`), so a grep cannot see
  them. Only the eight attributable to a file this wave deleted were removed. `fluid.css`
  looks entirely dead and was left: it is not this wave's to prove.

---

## Step 31 — the residue (2 commits)

- `28f1911` — `useNodeDrag` / `useWireConnect` / `useMarquee` out of `GraphCanvas.tsx`
  (749 → 535). Step 25's acceptance criterion was *extract them or write down why they
  stayed*; neither had happened. `GraphCanvas` has **zero** `isNext` hits, which is why it
  could be done after the migration rather than before.
- `54529df` — `useCompositionNav` out of `Studio.tsx` (773 → 643), including the
  `NavFrame` interface that was declared **inside the component body**.

**The ordering matters and is worth recording.** Splitting `Studio.tsx` *before* the
de-branching would have shaped its seams around a `sharedTransport` parameter that commit
7 deletes — seams built around a dead concept, and double the diff on a 773-line file.
`GraphCanvas` is the opposite case; the asymmetry is the whole reason the two splits sit
in different steps.

---

## Step 32 — measure, then decide (2 commits)

`da99042` first: `make bench`'s comment and `test_perf_baseline.py`'s docstring both told
you to write measurements into `docs/cleanup/`, which wave 4 deleted.

Then the numbers, on the five candidates the audit raised:

| candidate | measured | verdict |
|---|---|---|
| `media.stem_audio_path` | 0.025 ms → **0.5 ms** per 20-node resolve | **no change** |
| `render_cache.evict` | 0.012 ms real dir; 14 ms at a synthetic 5,000 files | **no change** |
| `look_fx.echo_scan` | **19.45 ms/frame** at 1080p, ~44% dtype churn | **fixed** |
| `db.list_assets`, `_backfill_derived` | not measured — need a seeded live DB | deferred |

`0c88e98` rewrote the scan with three preallocated scratch buffers and `out=` kwargs:
**1168 ms → 494 ms** for 60 frames at 1080p, **2.36×**.

**Bit-identical, and that is the load-bearing claim** — echo feeds `output_hash`, so a
one-level difference is a silent cache invalidation and a `RENDER_VERSION` bump nobody
made. Two additions were reordered (`f + x` → `x + f`), exact in IEEE-754 for non-NaN, and
`np.copyto(..., casting="unsafe")` truncates exactly as `.astype(np.uint8)` did. The
pre-change loop is kept **verbatim** in `test_look_fx.py` as the oracle, checked across
all three modes seeded and unseeded — a copy rather than a tolerance, because a tolerance
is how that claim would quietly stop being checked.

Two of three testable priors came back negative. That is the expected outcome here and is
recorded rather than quietly dropped: waves 3 and 4 both ended at "the numbers supported
nothing", and the value of the pass is the two fixes NOT made.

---

## Step 33 — the honest tails (3 commits)

- `918f118` — eight dead rule blocks, each attributed to a file this wave deleted; plus
  folding `.anim-stage-docked` and `.signal-list-next`, which the migration left
  permanently on, into their base classes (both verified single-consumer first).
- `7ae510c` — the doc truth pass. ARCHITECTURE listed `/animate` and `/animate/stream`,
  neither of which exists; DEVELOPMENT said 34 cards (33) and 16 `SOURCE_PARAM_SPEC`
  entries (17, omitting `text`). `pyproject.toml`'s coverage comment — *a block whose
  purpose is warning about stale figures* — cited `routes/export.py` at 46% when it is
  80%. `docs/history/TODO.md` got the superseded header step 14 asked for.
- `776fec0` — **CI runs `npm run coverage`, not `npm test`.** The thresholds had been
  configured since step 23 and enforced never; dropping a test file failed nothing. Step
  23's own acceptance criterion, unmet for two waves. Verified by raising the thresholds
  above the measured value and confirming the run errors.

### Coverage moved, mostly without tests being written

| | before | after |
|---|---|---|
| frontend statements | 70.7% | **79.4%** |
| backend total | 76% | **81%** |

Most of the frontend jump is the deletions: `App.tsx` and `ExportStep.tsx` were ~600 lines
sitting at 0%. **This is why the gate commit is last** — the post-deletion figure was
unknowable until the deletions landed, and setting the ratchet first means setting it
twice. Thresholds: frontend 65/65/65/50 → 75/75/70/55; backend `fail_under` 72 → 76.

---

## Left open

- **Step 34, backend TypedDicts.** Scoped in the plan (a `backend/types.py` for
  `Node`/`Graph`/`Segment`/`Output`/`Export` plus a test tying the field names to the
  existing codegen tables, then applied at seams only) and **not built**. Without a
  checker a TypedDict is a docstring with syntax; the parity test is the only thing that
  would make it load-bearing, and that test is arguably step 08's job rather than a typing
  step's.
- `<StudioBar>` (above).
- `lib/assetPreview.ts` has no tests and a known 1 GB-request bug class — the one item on
  the cut list that is a *bug class* rather than a percentage. First thing in wave 6.
- `routes/projects.py` at 30%: pure CRUD, `live_db` and `test_project_duplicate.py` already
  exist. Cheap teeth.
- `db.list_assets` / `_backfill_derived`: still unmeasured, still structurally suspect.

## Re-affirmed, do not re-propose

Everything on waves 1–4's rejected list still holds and was deliberately avoided:
splitting `graph_render.py` (import cycle; declined as readability-only), splitting
`registry.ts`/`factories.ts`/`normalize.ts`/`mutations.ts` (line-moving), an
`EditorContext` (measured 0.1 ms/edit), moving pan off React state (<1% main thread),
windowing the fluid `_gauss` (198–202 level deltas), bulk-migrating tests onto
`tests/helpers.py`, mocking to reach the HD job bodies, and ruff `C90`.

One item was rejected on **new** analysis and should not be revived: the `signalsRef`
"fix" for `useStreamRender`. The stale-closure reading is wrong — every field that can
change the picture is already inside `renderKey` via `SIGNAL_HASH_FIELDS`, so an edit
cancels the in-flight job and restarts. The ref would have let the POST body diverge from
the key its clip is memoized under, permanently poisoning `renderMemo`. The reason is
written at the suppression so nobody applies it later.
