# Kaika — Code Health Review & Improvement Plan

A consolidation pass after a fast feature run (animation node-graph, signals,
combine, points, the per-component wrap fix, output settings, the logs panel). This
is a **prioritized, batched action-plan**: approve a batch → we execute it → verify
→ move on, same cadence as the feature steps. Nothing here is done yet.

**How to use.** Pick a batch (or individual `ID`s). Batches are ordered by
safety/ROI and rough dependency, but most items are independent.

**Legend.** Effort: **S** ≈ <30 min · **M** ≈ 1–3 h · **L** ≈ half-day+. Risk:
**low** (mechanical/covered by tests) · **med** (touches shared logic) · **high**
(behavioural/perf-sensitive).

> Verified against the live tree on review day. Notes where the scouts were stale:
> `.claude/settings.local.json` is **not** tracked (only `graph-modulated.local.json`
> is); `FluidLab`'s path editor uses **local** React state (cheap) while only
> `PointsNode` commits the whole graph per pointer-move; a new
> `MinimizedCard`/`minimizeContext` node-minimize feature exists and is untested.

---

## Decisions locked (review session, 2026-06)

These forks were settled with the owner; the items below reflect them:

1. **Logbus → keep + document** (B9) — already paid for, helps remote-debug a session.
2. **Param spec → generate `fluidParams.js` from the backend** (B2.6 / B8.6) — kill
   front↔back drift at the source rather than policing it with a parity test.
3. **Formatters → add Prettier + Black** (B7.2) — one reformat commit, then
   logic-only diffs.
4. **`graph_hash` → drop it + its test-only exports** (B1.2) — `output_hash` is the
   one canonical hash.
5. **Schema versioning → do it now** (B6.1 / B6.2) — versioned migration while node
   shapes still churn.
6. **Render cache → full LRU/age eviction** (B6.3) — not just the manual band-aid.
7. **TypeScript migration → in scope** (new **Batch 10**) — the shape-bug class
   (e.g. the dropped `positions` edge) is worth a real type system. **Skip** the
   canvas-library swap and the solver rewrite.

---

## Summary

| Batch | Theme | Items | Rough effort | Risk |
|---|---|---|---|---|
| 0 | Verify & triage (done as part of writing this) | — | — | — |
| 1 | Safe quick wins | 8 | S each | low |
| 2 | De-duplication / single source of truth | 6 | S–M | low–med |
| 3 | Correctness & robustness | 6 | S–M | med |
| 4 | Performance | 4 | S–M | low–med |
| 5 | Architecture / structure | 4 | M–L | med |
| 6 | Data / persistence | 4 | M–L | med |
| 7 | Tooling & process | 6 | S–M | low |
| 8 | Tests (coverage gaps) | 6 | M–L | low |
| 9 | Logbus (decided: keep + document) | 1 | S | low |
| 10 | TypeScript migration | 1 (staged) | L | med |

**Suggested order.** 1 → 7 (CI + formatters early, so the rest is gated and
diff-clean) → 2 → 3/4 (parallel-ish) → 6 → 5 → 8 → **10 last** → 9 is a doc line,
anytime. Do **Batch 1** first (it clears noise and makes later diffs readable). Put
**Batch 10 (TypeScript) last**: it touches every file, so it's far cheaper to convert
*after* the dead code is gone (B1), the dups are merged (B2), and the big components
are split (B5) — you convert less, smaller, cleaner code, and the type system then
locks in everything the earlier batches established. Run it only on a quiet tree
(in-flight feature work committed first).

---

## Batch 1 — Safe quick wins (low risk)

- **B1.1 — Delete dead `_fluid_value_node_ids`.** `backend/graph.py:250` defines it;
  zero call sites (the per-output hash now walks `_contributing_ids`). *Change:*
  remove. *Why:* dead code misleads readers about the hashing strategy. **S/low.**

- **B1.2 — Drop the legacy `graph_hash` + test-only exports.** _[Decided: drop.]_
  `backend/graph.py:224` `graph_hash` + frontend `graphModel.js:graphHash` are used
  **only by tests** (`test_graph.py`, `test_output_settings.py`); production renders
  use `output_hash`/`outputHash`. *Change:* delete `graph_hash`/`graphHash` and the
  tests that exist solely to exercise them; same for the frontend test-only exports
  `fluidForOutput`/`setPortRange` (`graphModel.js`) — inline what those tests still
  need or delete them. Leave `output_hash`/`outputHash` as the single canonical hash.
  *Why:* two hashing functions with no stated canonical one invites a cache-isolation
  regression. **S/low.** (Note: B2.3's shared payload-builder is moot once `graph_hash`
  is gone — fold any still-useful structure into `output_hash`.)

- **B1.3 — Fix the 2 standing eslint warnings.** `GraphCanvas.jsx` (keydown effect
  missing `removeEdge` dep — wrap `removeEdge` in `useCallback` or add the dep) and
  `FluidNode.jsx:~77` (unused `ctx` arg in a nested helper — drop it or prefix `_`).
  *Why:* a clean `npm run lint` makes CI (B7.1) trivially green and stops new
  warnings hiding in the noise. **S/low.**

- **B1.4 — Magic numbers → constants.** Legacy square grid `96` appears in
  `backend/fluid.py:351` and `backend/graph.py:418`; the canvas paper-grid `26px` /
  `-13px` are hardcoded in `styles/animation.css`. *Change:* a `LEGACY_GRID = 96`
  constant; a `--gc-grid: 26px` token. *Why:* single edit point, intent named.
  **S/low.**

- **B1.5 — Centralize `RENDER_VERSION`.** `backend/graph.py:237` (`2`) and `:295`
  (`3`) are two inline literals that must move together. *Change:* `RENDER_VERSION = 3`
  module constant + a 3-line changelog comment (what each bump invalidated). *Why:*
  forgetting one bump silently serves stale clips. **S/low.** (Belongs with B6.2.)

- **B1.6 — Repo hygiene.** `specs/create-animation/fixtures/graph-modulated.local.json`
  is tracked but embeds a machine-specific `job_id` (`dbce4ed1`) — useless on a fresh
  clone. *Change:* `git rm --cached` it, add `*.local.json` to `.gitignore`, and have
  `fixtures/README.md` say "generate your own from a local project." (`.claude/` is
  already untracked — no action.) *Why:* clone-cleanliness. **S/low.**

- **B1.7 — Render-cache growth + `make clean-cache`.** `data/fluid/` is **~992 MB /
  839 mp4s** (gitignored, so not in the repo, but unbounded on disk). *Change:* a
  `make clean-cache` target (`rm -f data/fluid/*.mp4`) + a README line. *Why:* a dev
  machine quietly fills up; trivial relief now, real eviction is B6.3. **S/low.**

- **B1.8 — Expand the Makefile + README/Docs touch-ups.** Makefile only has
  `dev/db-up/db-down/install/rerender-spectrograms`; add `test`, `lint`, `format`,
  `build`, `clean-cache`. README/Docs: confirm combine + points + the node-minimize
  feature + the logs panel are described (they were added after the last doc pass).
  *Why:* discoverable dev commands; docs match reality. **S/low.**

---

## Batch 2 — De-duplication / single source of truth (low–med)

- **B2.1 — Unify fluid-params assembly.** `backend/graph.py` `build_params` (~345)
  and `_Dag._merge_params` (~475) both hand-build the `{duration, fps, source/sources,
  fluid, output|grid}` dict with overlapping logic. *Change:* one helper that takes
  emitters + medium + output and returns the params dict; both paths call it. *Why:*
  one place to evolve the sim contract; no drift. **M/med.**

- **B2.2 — Move `_MERGE_MEDIUM_DEFAULTS` into `animation_params.PARAMS`.**
  `graph.py:43` duplicates the medium defaults that already live in `PARAMS`. *Change:*
  derive them from `PARAMS` (filter `group=="fluid"`). *Why:* the medium defaults are
  declared twice; the spec says `PARAMS` is the source of truth. **S/low.**

- **B2.3 — ~~Share the hash-payload builder.~~** _[Superseded by B1.2's drop.]_ Was:
  unify the near-identical payloads in `graph_hash` and `output_hash`. Since B1.2
  deletes `graph_hash`, there's only one payload builder left — nothing to share.
  *Residual:* ensure `output_hash` reads `RENDER_VERSION` from the one B1.5 constant.
  **S/low.**

- **B2.4 — Extract a shared `useDragPoint` hook.** `PointsNode.jsx:28-36` and the
  `FluidLab.jsx:91-113` path-editor markers both implement "normalize pointer →
  window pointermove/up → move". *Change:* a `useDragPoint(padRef, onMove, onEnd)`
  hook (also the natural home for the B4.1 commit-batching). *Why:* two copies of
  fiddly pointer math drift apart. **M/med.**

- **B2.5 — Route every aspect string through `aspectOf`.** `lib/output.js:41` exports
  `aspectOf(o)`; `OutputSettings.jsx` uses it, but node cards build
  ``${output.width} / ${output.height}`` inline (`OutputNode`, `PointsNode`). *Change:*
  import `aspectOf` everywhere. *Why:* one definition of "aspect," consistent fallback.
  **S/low.** (Verify current inline sites — some may already be consolidated.)

- **B2.6 — Generate `fluidParams.js` from the backend `PARAMS`.** _[Decided:
  codegen.]_ `fluidParams.js` must stay identical to `animation_params.PARAMS`; today
  sync is manual with a `paramsParity.test.js` that only checks keys+ranges. *Change:*
  make the backend the single source — emit the spec (a generated `fluidParams.js`, or
  a JSON the frontend imports) from `PARAMS`, and have CI assert the committed file
  matches what `PARAMS` would generate (no-diff check). Retire the manual mirror and
  the parity test once codegen is the gate. *Why:* a missed hand-edit ships a control
  the backend ignores; codegen makes drift impossible. **M/med.** (This *is* the
  mechanism described in B8.6 — do them together.)

---

## Batch 3 — Correctness & robustness (med)

- **B3.1 — Tighten broad `except Exception`.** 12 `except Exception` across
  `app.py`, `segment.py`, `llm.py` (all `# noqa: BLE001`). Several swallow real
  failures into a "missing"/"failed" fallback (e.g. Whisper, LLM, signal lookup).
  *Change:* catch the specific expected types; let unexpected ones surface (or log
  with the traceback) so a real bug isn't disguised as user error. *Why:* a typo
  currently reads as "signal not present." **M/med.**

- **B3.2 — Request-body validation → clean 400s.** `/animate`, `/segment`, `/fluid`
  read `request.get_json()` with `.get(...)` defaults; a malformed graph or missing
  field can 500 deep in `render()`. *Change:* a small shape check at the route
  boundary returning a 400 with a clear message. *Why:* clients get actionable errors,
  not stack traces. **M/med.**

- **B3.3 — Validate segment bounds + stem keys in extraction.** `graph._signal_curve`
  / `signals.extract` don't check `start < end ≤ duration`, and an invalid `stemKey`
  silently degrades to flat-0 (looks like a disabled signal). *Change:* validate
  bounds; surface an unknown-stem as a warning/validation error rather than silent 0.
  *Why:* garbage-in is currently invisible. **S/med.**

- **B3.4 — Postgres connect grace.** `db._connect()` opens a fresh connection per
  call with no retry; a momentary DB blip → 500. *Change:* a short retry/backoff (or
  a clearer error). *Why:* transient unavailability shouldn't hard-fail a save.
  **M/med.**

- **B3.5 — Stable point ids (drop `key={i}`).** `PointsNode.jsx:67` and
  `FluidLab.jsx:194,213` key markers by array index; add/remove mid-list can mis-bind
  React DOM/focus. *Change:* give each point a stable id (or key by rounded coords).
  *Why:* list-mutation correctness. **S/low.**

- **B3.6 — Audit the 6 `exhaustive-deps` suppressions.** `PulsePad`, `SignalNode`,
  `FluidNode`, `OutputNode`, `NodeFrame`, `FluidLab` each disable the rule. *Change:*
  confirm each is a deliberate "fire on key X only" (memoize the key) vs a real
  stale-closure; add a one-line justification or fix. *Why:* the rule is off in 6
  places — at least one is worth re-checking. **M/med.**

---

## Batch 4 — Performance (low–med)

- **B4.1 — Batch the per-pointer-move graph commit in `PointsNode`.**
  `PointsNode.jsx:30` calls `onGraphChange(movePoint(...))` on **every** pointermove →
  a full segment-graph replace + autosave churn + canvas edge recompute per event.
  *Change:* drag against local state, commit once on pointerup (pair with B2.4's
  hook). *Why:* dragging a point currently thrashes the whole graph pipeline.
  **M/med.** (FluidLab already uses local `setP` — fine.)

- **B4.2 — Memoize the small graph walks in node cards.** `FluidNode` recomputes
  `posSrcId`/`posNode`/`posCount` and `OutputNode` recomputes `renderable` every
  render. *Change:* `useMemo` keyed on `graph`+`node.id`. *Why:* cheap, removes O(n)
  walks from the hot render path. **S/low.**

- **B4.3 — Drop redundant per-frame `float()` in `simulate`.** The medium series are
  already `float32`; `sim.dissipation = float(diss_s[i])` etc. cast每 frame. *Change:*
  index the array directly (or cast once). *Why:* micro-win in the per-frame loop;
  also cleaner. **S/low.**

- **B4.4 — Memoize signal extraction across one `/animate`.** A render re-extracts
  each signal curve via `signals.extract` even when several emitters share a signal;
  the STFT is cached but the shaped curve isn't. *Change:* memoize the shaped curve by
  `(signal-def, start, end, fps)` within a render. *Why:* multi-emitter / multi-output
  graphs recompute the same curve. **M/low.**

---

## Batch 5 — Architecture / structure (med–L)

- **B5.1 — Split oversized components.** `FluidNode` (~250 LOC: static controls +
  `ParamRow`/`RangeControl` + collapsible groups + re-anchor), `Studio` (~290:
  playback + audio registry + signal edits + rail + tabs), `FluidLab` (~290: params +
  path editor + double-buffered video). *Change:* extract `ParamRow`/`RangeControl`
  files, a `useSegmentPlayback` hook, a `PathEditor` subcomponent. *Why:* each is a
  big surface to reason about; extraction lowers churn-blast-radius. **L/med.**

- **B5.2 — Clarify the `_Dag` resolver.** `graph.py` `_Dag` (~120 LOC, `_video`/`_emit`
  memo dicts, resolution spread across `video`/`emitters`/`_fluid_*`). *Change:* a
  single typed dispatch per node type + a short docstring of the resolution pipeline.
  *Why:* adding a node type currently means touching several methods with implicit
  memo. **M/med.**

- **B5.3 — Type the node `ctx` object.** `renderAnimNode` passes a `ctx` with ~10
  fields; consumers unpack ad-hoc, documented only in a comment. *Change:* define the
  `ctx` (and `helpers`) shape as a real type. *Why:* adding a field today silently
  risks a typo in a consumer. **S/low.** _Note: with Batch 10 in scope, do this as a
  proper TS `interface` during the migration rather than a JSDoc `@typedef` — it's the
  same work, so don't do it twice._

- **B5.4 — Fold in the new node-minimize feature cleanly.** `MinimizedCard.jsx` +
  `minimizeContext.js` were added recently. *Change:* confirm it's wired through
  `renderAnimNode` consistently, has a test (B8.x), and is in the spec/docs. *Why:*
  newest code, least reviewed. **S/low.**

---

## Batch 6 — Data / persistence (med–L)

- **B6.1 — Project + graph schema versioning.** The project JSONB now nests
  `segments[].{signals, graph, tracks}`; there's no `schema_version` and the graph has
  a `version: 1` that nothing reads. *Change:* a `schema_version` on the project (and
  honor `graph.version`), checked on load. *Why:* a future field change can silently
  break old saves. **M/med.**

- **B6.2 — Make `normalizeGraph` version-aware.** `graphModel.js:normalizeGraph`
  migrates shape (adds ports, fills combine/points fields, drops stale edges) but
  doesn't know which version it's migrating *from*. *Change:* read `graph.version`,
  migrate stepwise, bump on write. *Why:* the current "fix whatever looks wrong"
  approach bitrots as shapes accrue. **M/med.** (Ties to B1.5 / B6.1.)

- **B6.3 — Render-cache eviction policy (full LRU/age).** _[Decided: full policy, not
  just the B1.7 band-aid.]_ `data/fluid/` grows unbounded (~1 GB today). *Change:*
  track `{hash, path, bytes, atime}` in a small sidecar (a `cache.json` or a tiny
  SQLite next to the mp4s); on write, and on a periodic sweep, cull by **size cap +
  age** (e.g. keep ≤ N GB / drop entries unused > D days, evicting least-recently-used
  first). Touch `atime` on cache hit so hot clips survive. Wire the manual
  `make clean-cache` (B1.7) to call the same evictor with an "all" flag. *Why:* the
  cache needs a real lifecycle, not unbounded growth. **L/med.** (Decide N/D when we
  build it — sensible defaults: 5 GB cap, 30-day age.)

- **B6.4 — Confirm cache-bust coverage with a test.** `output_hash` folds in
  referenced signal defs + output settings; add a test that editing a signal knob (or
  an output setting) changes the hash (some of this exists for combine/points — close
  the gaps). *Why:* a hash-omission silently serves stale renders. **S/low.** (→ B8.)

---

## Batch 7 — Tooling & process (low)

- **B7.1 — CI (GitHub Actions).** None today (`.github/workflows` absent). *Change:* a
  workflow running `ruff check`, `pytest`, `npm run lint`, `npm run test`,
  `npm run build` on push/PR. *Why:* the 2 lint warnings + any ruff/test regressions
  currently only fail on someone's laptop. **M/low.** (Do early — gates every batch.)

- **B7.2 — Formatters (Prettier + Black).** _[Decided: add both.]_ No formatter today.
  *Change:* add Prettier (matching the current React style as closely as the config
  allows) and Black for the backend, plus a pre-commit hook and the `make format`
  target (B1.8). Land the one-time reformat as a **single isolated commit** (no logic
  changes) so it's easy to skip in `git blame` (add it to `.git-blame-ignore-revs`).
  *Why:* kills whitespace churn in diffs (which currently hides real logic changes).
  **M/low.** (Do this in Batch 7 *before* the big refactors so they format-land clean.)

- **B7.3 — Coverage measurement.** No `pytest-cov`/vitest coverage. *Change:* add
  coverage, print it in CI, set a soft floor on the high-risk modules
  (`graph`/`fluid`/`signals`, `graphModel`). *Why:* know the blind spots before B8.
  **S/low.**

- **B7.4 — Pin Python deps.** `requirements.txt` is essentially unpinned (1 `==`).
  *Change:* pin (`pip freeze` a known-good env). *Why:* torch/librosa/demucs combos
  are famously brittle across versions; reproducibility. **S/low** (verify after pin).

- **B7.5 — `DEVELOPMENT.md`.** None. *Change:* an architecture map (upload → segment
  → studio → animation graph → `simulate` → mp4), "how to add a param / node type"
  (the `PARAMS`/`fluidParams`/parity/`render_version` checklist), and a test/lint
  checklist. *Why:* the param/node add-path touches 4 files in lockstep — easy to miss
  one. **M/low.**

- **B7.6 — Document the ruff config rationale.** `ruff.toml` intentionally excludes
  `I`/`UP` and tolerates `BLE001` via per-line noqa. *Change:* a comment explaining
  why (e.g. `matplotlib.use("Agg")` ordering) so it isn't "fixed" later and broken.
  *Why:* the exclusions are deliberate but undocumented. **S/low.**

---

## Batch 8 — Tests (coverage gaps) (med–L)

- **B8.1 — Backend end-to-end render test.** No test runs `graph.render` →
  `fluid.simulate` → `render_mp4` and asserts a valid mp4 (frame count/dims). *Change:*
  one tiny-grid/short-duration case (const fluid → output) + a combine + a points
  case. *Why:* rendering is the highest-stakes code and only its *pieces* are tested.
  **M/low.**

- **B8.2 — `db.py` round-trip.** No tests for create/save/list/get/delete. *Change:*
  a save→load→assert test (Postgres or a sqlite shim). *Why:* persistence is untested;
  a schema change (B6.1) needs a guard. **M/med.**

- **B8.3 — `jobs.py` state machine.** No tests for the ThreadPoolExecutor / state
  transitions / `_JOBS` growth. *Change:* mock a slow op, assert polling + terminal
  states; note `_JOBS` is never pruned (a TTL is optional). *Why:* background
  concurrency is untested. **M/med.**

- **B8.4 — Signal feature extractors.** `test_signals.py` covers only `shape()`; the
  raw extractors (`energy/onset/flux/brightness/harmonic/chroma/beat/bar`) are
  untested. *Change:* golden/shape tests per feature on a synthetic stem. *Why:* a
  librosa bump or refactor could silently change curves. **L/low.**

- **B8.5 — Frontend canvas + transport.** `GraphCanvas` (drag/connect/pan/zoom),
  `AnimationCanvas` (commit/render/fullscreen/minimize), and Studio transport/`OutputNode`
  sync are untested. *Change:* jsdom + `@testing-library/user-event` for the pointer
  interactions and the transport. *Why:* the 2 lint warnings hint at canvas
  stale-closures tests would catch. **L/med.**

- **B8.6 — CI no-diff guard for the generated param spec.** _[Merged with B2.6 —
  codegen is decided.]_ Once `fluidParams.js` is generated from the backend `PARAMS`,
  add the CI step that regenerates it and fails on any diff from the committed file.
  *Why:* this is the gate that makes the codegen actually enforce sync. **S/low.**

---

## Batch 9 — Logbus: keep + document _(decided)_

The unified log stream is **~500 LOC, always on**: `backend/logbus.py` (+ `/logs`
route), `frontend/src/lib/{logbus,logCapture,useLogPoll}.js`, `LogsPanel.jsx`,
`styles/logs.css`. It rings 1000 entries, polls every ~2 s, and captures global
errors. Production-quality but undocumented.

- **B9.1 — Keep it on, document it.** _[Decided.]_ *Change:* add a short
  README/`DEVELOPMENT.md` paragraph (what it captures, the `/logs` endpoint, the ring
  size + poll interval) and a one-line user-facing `?` blurb on the panel. No code
  behaviour change. *Why:* it's already paid for and genuinely helps remote-debug a
  session; the only gap was discoverability. **S/low.**

---

## Batch 10 — TypeScript migration _(in scope, do last)_

_[Decided: in scope.]_ The motivating pain is real — the `normalizeGraph` bug that
silently dropped the `positions` edge was a shape error a type system catches at the
boundary. Done **after** Batches 1/2/5 so we convert less, smaller, already-cleaned
code, and the types then lock in what those batches established. Staged so it's never
a single terrifying diff:

- **B10.1 — Toolchain + incremental setup.** Add `typescript`, a `tsconfig.json`
  (`allowJs: true`, `strict: true`, `noEmit` — Vite already transpiles), and let
  `.ts`/`.tsx` and `.js`/`.jsx` coexist. Wire `tsc --noEmit` into `npm run lint`/CI
  (B7.1). *Why:* lets us convert leaf-by-leaf with green CI the whole way. **M/med.**

- **B10.2 — Type the core domain shapes first.** A `types.ts` for the graph model:
  `Node`, `Edge`, `Binding` (`const` | `node`), `Graph`, the param spec, and the node
  `ctx`/`helpers` (subsumes **B5.3**). Convert `lib/{graphModel,fluidParams,output}.ts`
  to use them. *Why:* this is where the shape bugs live — typing the model is 80% of
  the value. **M/med.**

- **B10.3 — Convert the leaves, then the components.** `.jsx`→`.tsx` outward from the
  pure helpers to `nodes/*`, then the canvas/studio components. Type props per
  component; let `strict` flush out the real nulls/optionals. *Why:* mechanical once
  the domain types exist; smaller if B5.1's component split landed first. **L/med.**

- **B10.4 — Backend types (optional, lighter).** Add type hints + `mypy`/`pyright` to
  the high-value modules (`graph.py`, `animation_params.py`, the `Binding`/params
  shapes) so the front↔back contract (B2.6 codegen) is typed on both ends. *Why:* the
  codegen'd param spec is most useful if both sides are typed. **M/low.** (Skippable.)

> Prereqs: a quiet tree (commit in-flight feature work first) and ideally B1 (less to
> convert), B2 (no dup to convert twice), B5.1 (smaller components). Risk is **med**
> not high because `allowJs` + incremental conversion keeps every step shippable.

---

## Out of scope (considered, not doing)

- **Replacing the hand-built canvas with a library** — you chose hand-built
  deliberately and it works (pan/zoom, ports, edges, minimize all exist); a library
  rewrite lands roughly where you already are. Revisit only if you want auto-layout /
  edge-routing / minimap / undo-redo for free.
- **A real fluid-solver optimization** — the spectral FFT Poisson solve is already the
  fast method and clips render sub-second; the only real wins (per-frame `float()`
  casts, signal-curve memo) are already captured as B4.3/B4.4. Revisit only at much
  larger grids/durations.
