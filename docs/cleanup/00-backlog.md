# Cleanup backlog

Why this exists: in one week the full suite (487 pytest + 252 vitest) stayed **green**
while (a) a real segment rendered **79 frozen frames out of 80** and (b) the editor took
minutes to open a segment. Both bugs shipped through a green suite, and both were found
by hand. The same week's feature velocity also left four stacked video-preview layers, a
2047-line `graph_render.py`, and ~11 render handlers duplicated verbatim.

The order below is deliberate: **the safety net comes first**, because steps 2–4 are
large-surface refactors and there is currently no test that would notice if they broke
the picture.

Line numbers are a snapshot from the audit that produced this file — re-grep before
relying on one.

---

## Step 0 — Safety net

The hole: `tests/test_card_impact.py:51-61` reduces each clip to two scalars
(`rgb.max()`, lit-pixel fraction) **across the whole time axis**. 80 identical frames
pass exactly like an animated clip. It is the repo's only "does every card work" gate
and it is blind to motion.

- `tests/helpers.py` (new): `DRAFT_OUT`, `node()`, `wire()`, `dag()`, plus
  **`assert_moves(frames)`** (mean frame-to-frame delta + distinct-frame fraction) and
  `assert_not_black(frames)`. The `OUT` dict is currently redefined in **12 files** with
  drifting values.
- Wire `assert_moves` into: the **34 Playground demos** (`test_card_impact.py`),
  `test_render_e2e.py:50`, the generative cards (`test_gen_sim_cards.py`), and the video
  paths of `test_montage.py`. ⚠ `test_montage.py:194` currently *asserts staticness*
  (its fixture uses stills) — rename/comment so the intent is explicit.
- **Time-budget test** — none exists (`grep perf_counter` finds only job-wait loops):
  a segment render and the key routes under a generous ceiling. We want to catch
  order-of-magnitude regressions, not milliseconds.
- **A real end-to-end**: load a committed project fixture through the **real routes** and
  render a segment. Today `test_assets.py` monkeypatches storage away and
  `test_app_routes.py` only checks 400/404 shapes. Both of this week's bugs lived in
  exactly that untested seam.
- **Isolation**: one autouse fixture pointing **all** of `paths.*` at tmp, failing loudly
  on any write into the repo's real `data/`. Two conventions coexist today (patch
  `paths.X` vs patch `module.X`).
- **Strict-deps mode**: missing ffmpeg / torch / Postgres silently *skips* tests, so
  "487 green" is an unknown number of real tests. `--strict-deps` turns those skips into
  failures.

## Step 1 — Video preview: fix the root cause, then consolidate

**1a. Root cause.** `BoxPad.tsx:319-383` depends on the **object** `videoPreview`
(`[videoPreview]`, L383): any identity change tears down and rebuilds the whole playback
engine (listeners, watchdog, rAF loop). That is what made 20 `<video>` elements
re-request their files ~27× each. The two memos added around it
(`VideoNode.tsx:100-120`, `CompactPreview.tsx:107-113` — both with
`eslint-disable exhaustive-deps` and **different** dep lists) are external band-aids, and
the hole stays open: `AssetLayerCard.tsx:131` builds `box={{…}}` fresh every render, and
any future `<BoxPad videoPreview={build…()} />` caller silently reintroduces the bug with
no lint warning.
→ Depend on the **fields** (`src`, `fit`, `start`, `speed`, `loop`, `sync`, `segStart`,
crop), then **delete both external memos and both disables**.

**1b. Consolidate the display paths.** Five coexist: raw `/assets/…`, `/asset-proxy`
(full 360p), `<sha>-thumb.jpg`, `/asset-clip?start&dur` (excerpt), plus a client-side
duration probe.

- One `assetSrc(url, { mode: "thumb" | "clip" | "scrub", start })` over **one** path
  parse (the regex is written twice: `assetPreview.ts:14` and `:38`). `clip` (~57 KB) for
  anything that plays, `thumb` for anything static, `scrub` (seekable full proxy) only
  where scrubbing is real: `CropPad` and the in-point picker. `/asset-proxy` leaves the
  public API.
- Concrete misuses: `SlideshowNode.tsx:177` pulls a full proxy for a static grid
  thumbnail; `MontageNode.tsx:45` builds a proxy URL **only to read a duration**.
- **Delete `lib/videoDuration.ts`** (56 lines): duration belongs in the asset record from
  the server (`sources._video_meta` already exists). That probe is what re-opened the 20
  original files.
- **Barrier**: `data.assetUrl` must never reach a `src=` directly (today
  `VideoNode.tsx:179,201` hands the raw URL to components that re-proxy it themselves —
  every leak is a potential 1 GB request).
- One `_ffmpeg_atomic(args, dest, timeout)` for thumb / proxy / clip (three copies of the
  same tmp→run→`os.replace` dance in `routes/uploads.py`).
- Test: assert the **bytes** an N-card segment pulls, failing over a ceiling. That is the
  regression we hit three times.

## Step 2 — Split the large modules

- `routes/uploads.py` (740) → `routes/assets.py` (proxy/clip/thumb/upload/CRUD),
  `routes/imagegen.py`, `routes/uploads.py` (song + segmentation), `routes/jobs.py`.
  `/upload` and `/jobs` have nothing to do with the asset library.
- `graph_render.py` (2047) → `graph_dag.py` (the `Dag` class), `graph_cards_source.py`,
  `graph_cards_fx.py`, `graph_handlers.py` (the three dispatch tables), `graph_render.py`
  (entry points). The boundaries are already clean inside the file.
- `sources.py` (1376) → `sources/{text,gen,media}.py` — zero cross-group coupling, so this
  is the cheapest big win.
- Facades (`graph.py`, `graphModel.ts`) stay the import point. No behaviour change.

## Step 3 — Remove the double render path

~11 of the 20 `_X_video` / `_X_block` pairs are pure restatements:
`_X_video(dag, n) ≡ _X_block(dag, n)(0, nframes)` (verified line by line for backdrop,
image and the five sim cards).

- Derive the whole-clip handler from the block handler where they're identical; **leave
  combine / montage / echo / fluid alone** (genuine cross-block state).
- **The test that makes it safe**: a generic, table-driven check that `whole == streamed`
  for **every** card type — today that's hand-written per card across separate files. It
  is also the guard against "the export doesn't match the preview", the worst bug class
  here.
- Gain: ~120 lines, and a new card costs one handler instead of two.

## Step 4 — Remove hand-mirrored logic

- Move `_VIDEO_PRODUCERS` into `graph_common` (the leaf): kills the backend's **only**
  circular import (`graph_validate.py:13` imports `graph_render` inside a function) *and*
  the layer inversion (validation depending on the render dispatch table).
- **Codegen** the shared constants to the frontend, on the existing `gen_fluid_params.py`
  model: `SIGNAL_HASH_FIELDS`, `SLOT_CARDS`, `VIDEO_PRODUCERS`. They're hand-copied today
  and **drift is silent** (the digests differ on purpose, so nothing fails loudly).
- Cut the frontend validation mirror back to what avoids a round-trip (cycles, slot ids,
  renderability); the server stays authoritative for the rest (~190 Python lines vs ~230
  TS lines of the same rules).
- One graph-walk helper per language: `feedsMontage` / `_feeds_a_montage` / `contributing`
  are three near-identical BFS × two languages.

## Step 4b — Frontend drift, duplication, dead code

- **Live drift**: `VIDEO_TYPES` exists twice — 19 entries in `CompactPreview.tsx:36`,
  **6** in `SettingsVisual.tsx:28`. Montage, transform, stylize, echo, colorgrade, waves,
  fire… fall through `SettingsVisual`'s `default` and only work by accident. And
  `lib/graph/core.ts:71` `VIDEO_PRODUCERS` is a **third** copy of the same concept. The
  guard pattern already exists for help (`paramHelp.test.tsx` counts per-card badges) —
  apply it to this table.
- Merge duplicates: `colorCss`/`clamp01`/`hex2`/`constVal` copied **three times**
  (`CompactPreview`, `SettingsVisual`, `ColorNode`); `ResolvedPointsPreview` twice;
  `buildVideoPreview` / `buildCompactVideoPreview` ~80% identical; the YouTube import row
  written twice (`VideoNode.tsx:26-80`, `AssetLibrary.tsx:231-268`); `upstreamVideoCard`
  (`MontageNode.tsx:29`, with a magic `hops < 8` cap) vs `feedsMontage` (`core.ts:96`) —
  the same relation walked both ways, the FX-passthrough rule encoded twice.
- **Hidden cost**: `JSON.stringify([graph.nodes, graph.edges])` **on every render of every
  points card** as a dep key (`CompactPreview.tsx:62`, `SettingsVisual.tsx:50`).
- **~45 dead symbols** verified unreferenced, including the entirely dead
  `lib/modPreview.ts` and `api.renderGraph` (a stale endpoint client), plus unused types
  in `api.ts`, `types.ts`, `segments.ts`, `nodeInputs.ts`, `registry.ts`, and `lib/mel.ts`.
- **Splits**: `Docs.tsx` is **1484 lines**, **771 of them in the single `animation`
  section** → one file per section. `lib/graph/normalize.ts` (489) → move the ~8 version
  migrations into `graph/migrations.ts` so `normalize` is only coercion. `BoxPad.tsx`
  (453) → three modules (`useBoxEdit`, the lyrics canvas, the video transport engine).
  `AssetLibrary.tsx` (320) → `useAssetLibrary()` + `AssetGrid`. The `GRAPH_VERSION`
  changelog (28 entries in `factories.ts`) moves to a doc, like `RENDER_VERSION`'s.
- `useStreamRender.ts`: the slot pool is **module-global mutable state** (L10-45) with no
  test — extract and cover it.

## Step 5 — Config and housekeeping

- `backend/config.py` (exists, underused) becomes the one place for caps/timeouts/preview
  sizes. Priority: the **2 GB limit declared twice** (`app.py:37` vs
  `routes/uploads.py:59`, only one env-backed), duplicated `_MAX_JOBS` (`jobs.py` /
  `render_jobs.py`), hardcoded ffmpeg timeouts, and `_PROXY_HEIGHT` /
  `PREVIEW_EXCERPT_SECONDS` split across the language barrier.
- `graph.py`: prune the ~50 private re-exports (tests already import submodules directly);
  give `song_render.py:147` a public `Dag.seed()` instead of writing into `dag._video`;
  drop the `_Dag` alias.
- `cache_gc.py:83` imports `routes.export._EXPORT_DEFAULTS` — a backend module importing a
  route, on a private name. Move to config.
- `RENDER_VERSION` changelog → `docs/render-versions.md` (30 comment lines for one
  constant, and nothing before v9 has diagnostic value given the cache's 14-day TTL).
  Keep the last 3 entries inline.
- `make restart`: killing the backend currently kills the whole `make dev` process group.

## Step 6 — Playground and docs

- Re-arrange the live Playground, re-export the fixture cleanly (positions drift with
  use), and document the exact procedure (browser tab closed, ordering vs the
  `GRAPH_VERSION` bump).
- `ARCHITECTURE.md`: the module map after the splits, and fix the **12-version-stale
  `GRAPH_VERSION`** (the doc says 16, reality is 28). `DEVELOPMENT.md`: the "add a card"
  checklist (one handler instead of two).

---

## Working rules

1. **Step 0 first, no exceptions.**
2. **One step = one spec (`docs/cleanup/0N-<name>.md`) = a series of green commits.** The
   spec is written just before its step, not all upfront — they go stale.
3. **No behaviour change during a refactor.** Behaviour fixes (step 1) are isolated and
   tested separately.
4. Each step: `make test`, `make lint`, `npx tsc --noEmit`, `black` on touched files —
   never a repo-wide `make format`.
5. **Baseline measurements before starting**: bytes pulled and time-to-open for a
   20-card segment, and one segment render's duration. Without a starting number,
   "it's faster" is an impression — which is exactly how three fixes were wrongly
   declared done this week.
