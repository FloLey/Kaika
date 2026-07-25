# Kaika — Architecture

The newcomer's map of the codebase: what the app does, how the pieces fit, and
the invariants that keep it working. For hands-on checklists (add a param, add a
node card) see [`DEVELOPMENT.md`](DEVELOPMENT.md); for the end-user view, open
the in-app guide (`?` in the header, or `/?doc=` — source:
[`frontend/src/components/Docs.tsx`](frontend/src/components/Docs.tsx)).

## What Kaika is

A local web app that turns a song into an audio-reactive video. It splits the
track into musical **segments**, extracts per-stem **signals** (0..1 curves that
follow the music), and lets you wire those signals into a per-segment **node
graph** — fluid simulations, lyrics, image/video layers — that renders to a
looping clip. A final **export** renders the whole song as one continuous HD
simulation.

```
        upload / YouTube (+ optional lyrics)
                       │  jobs.py (background, 1 worker)
        Demucs stem separation (MPS GPU) + librosa spectrograms
                       │
        review ── segment proposal: beat grid + Whisper lyric alignment
                       │             + vocal activity + LLM section labels
                       │             (segment.py / llm.py, cached in data/analysis/)
        ┌──────────────┴────────────────────────────────────────────┐
        │ STUDIO (one transport, two tabs, everything per segment)  │
        │                                                           │
        │  extract signals        create animation                  │
        │  stem+band+feature  ──► node graph: signal/lfo/noise/     │
        │  +shaping → 0..1        shaper/math → fluid/color/points  │
        │  (signals.py)           /lyrics/image/video/backdrop      │
        │                         → combine → transform → output    │
        │                              │                            │
        │                    /animate/stream (render_jobs.py)       │
        │                    block-streamed, cached, cancel-on-edit │
        └──────────────────────────────┬────────────────────────────┘
                                       │  mark one output per segment ★ final
        /export/segment — ONE segment at the export's settings (the
        Output card's HD button), audio slice muxed; shares the HD slot with:
        /export/stream — whole-song HD render (song_render.py):
        one continuous sim per layer carries across segment cuts,
        muxed with the original audio
```

Stack: **Flask** (pure JSON API, `:5000`) + numpy/scipy fluid sim + Demucs +
Whisper + Ollama (optional) on the backend; **React + Vite** (`:5173`, proxies
to Flask) on the frontend; **Postgres** (Docker) for editable state; the
filesystem (`data/`) for audio, frames and clips. The app itself runs natively —
Apple's MPS GPU is not reachable from a Linux container, so Docker runs *only*
Postgres.

## Repo layout

```
backend/            Flask API + the render engine
  routes/           ten blueprints (absolute URLs, no prefixes)
  graph.py          ← 66-line facade; the executor lives in graph_*.py
  fluid.py          the fluid simulation (+ fire mode) + encoders
  sources.py        facade over sources_{common,text,gen,media} — non-fluid layers
  procgen.py        the simulation kit (wave spectra, caustics, DBM, spectral ripple…)
  song_render.py    whole-song HD export
  *_cache.py, cache_gc.py, jobs.py, render_jobs.py, db.py, paths.py …
frontend/src/
  lib/              domain logic (graph model, api, params, segments)
  lib/graph/        ← the graph model package; graphModel.ts is its barrel
  components/       studio / animation (+ nodes/) / assets / export / review / upload
  styles/           one file per area, imported base-first by index.css
  styles/animation/  ← the editor's stylesheet, cut into ordered parts (01…09);
                       animation.css is its barrel — the NUMBERS are the cascade
tests/              pytest (backend); frontend/src/__tests__/ is vitest
specs/              design records per shipped wave (the why, not a roadmap)
docs/               only what is still live: open backlogs, changelogs, archive
data/               gitignored working data (uploads, stems, caches, assets)
```

## Backend

### Routes (`backend/routes/`)

`app.py` only creates the app, registers the blueprints, times slow requests, and
(as the dev server, not on import) kicks a startup cache sweep. Each blueprint keeps its historical absolute URLs:

| Blueprint | Routes |
|---|---|
| `uploads.py` | `/upload`, `/segment` — the song pipeline only |
| `assets.py` | `/upload-asset/<job>`, `GET/DELETE /assets/<job>[/<id>]`, `/asset-from-youtube/<job>`, and the DERIVED preview files: `/asset-proxy/…` (seekable 360p) and `/asset-clip/…?start&dur` (the seconds a preview plays) |
| `imagegen.py` | `/generate-image/<job>` |
| `stylize.py` | `/stylize/<job>` — the AI Stylize card's diffusion restyle |
| `jobs_routes.py` | `/jobs/<id>`, `/logs` |
| `animation.py` | `/extract`, `/resolve`, `/resolve-points`, `/fluid`, `/animate`, `/animate/stream` (+ status/cancel) |
| `export.py` | `/export/stream`, `/export/segment`, `/export/segment/cached` (+ shared status/cancel) |
| `projects.py` | `/projects`, `/projects/<id>` GET/PUT/DELETE, `/playground`, `/playground/export` |
| `settings.py` | `/settings` GET/PUT/POST, `/settings/test-remote` — remote-inference config |
| `serving.py` | `/`, `/fonts`, `/fluid/<name>`, `/fluid/stream/...`, `/audio/...`, `/assets/<job>/<name>`, `/spectrogram/...` |

### The graph executor (`graph_*.py`)

`graph.py` is a thin **facade** — routes and tests import from `backend.graph`,
the implementation lives in five modules:

- **`graph_common.py`** — shared constants + edge/node lookups + `composite`
  (the alpha-over stack) + `VIDEO_PRODUCERS` (which card types produce video).
  The leaf module; everything imports from here. The producer set lives here rather
  than in the render dispatch table so `graph_validate` needn't import `graph_render`
  — that was the backend's only circular import; `graph_render` asserts at import
  that its handler table matches this set.
- **`graph_validate.py`** — `validate(graph, output_id=None)`: raises `ValueError`
  → HTTP 400 on an unrenderable graph (missing output, malformed bindings, cycles,
  a stacked combine feeding a merge). `output_id` names the render **target**: when
  it's a producer previewed directly (not an output node), the output-node rules are
  skipped — a graph mid-build has no output yet, and an unrelated half-wired output
  must not 400 a card's preview.
- **`graph_hash.py`** — `output_hash(...)`: the per-output render-cache key (see
  Caching below) + `RENDER_VERSION` (history: [`docs/render-versions.md`](docs/render-versions.md)).
  A slot card's UNWIRED slots are stripped before hashing: the render skips them, so
  pressing `+ slot` must not re-render a byte-identical clip.
- **`graph_modulators.py`** — every node that produces a 0..1 **value curve**
  (signal / LFO / noise / shaper / math / scope), the colour-card resolver, the
  points pipelines (pattern / animate / merge), and `resolve_node_curve` (the
  Scope card's live view).
- **`graph_render.py`** — `build_params` (graph → `simulate()` params), the
  **`Dag`** resolver (memoized per-node video/emitter resolution), the per-type
  handler registries (`_VIDEO_HANDLERS` whole-clip, `_BLOCK_HANDLERS` streaming,
  `_EMITTER_HANDLERS` merge), and the entry points `render` / `render_stream`.
  Each block producer memoizes **one** block so a diamond consumer computes it
  once; `Dag.drop_stale_blocks(a)` (called by `stream_blocks` before every block)
  frees the ones the playhead has passed. That matters for producers not pulled
  every block — a montage extract after its cut — which otherwise each hold a full
  block of frames until `close()` (~33 MB/frame at 4K, per slot).
  Their `output_id` may be an **output node** (render the video wired into it) or
  **any video producer directly** (fluid/combine/transform — the per-card live
  previews); `_render_target` is the one shared resolver of that contract, so the
  sync and streaming paths can't drift, and it's what `validate` keys its
  output-node rules off. The frontend mirror is `nodeRenderable`
  (`lib/graph/validate.ts`) — cards only stream what the backend would accept.
  It also owns the FRAME SIZE rule (`_grid_dims`): normally the output's coarse
  simulation grid, but a graph with nothing to simulate renders at native
  resolution (short side capped at 540 — a full 1080p block stream would hold
  ~1 GB of frames in flight). `output["nativeShort"]` raises that cap and wins
  over `gridCells`, because pinning a sim-free graph to a 216-cell export grid
  would make "HD" look *worse* than the preview. Previews never send the key, so
  their sizes — and cache keys — are untouched. **Both HD paths send it**
  (`song_render.output_from_export`, the shared contract), so the two resolve a
  given segment to the same size; a test pins that. This used to be true of the
  single-segment render only — one ffmpeg spans the whole song and its rawvideo
  geometry is fixed at the first write, so the master was rendered on the sim grid
  and upscaled with nearest-neighbour while the segment HD render of the same bars
  was native. `song_render.build_plan` now sizes that encoder from the **largest
  grid in the plan** rather than a constant, and `iter_song_windows` upscales any
  smaller segment to match: an all-light song renders native end to end, an
  all-fluid song is byte-identical to before, and only a mixed song resamples
  anything (its fluid segments, which want nearest anyway).

A node graph has three edge flows: **value** (0..1 curves into modulatable
ports, each mapped through a per-port `[lo, hi]` range), **points** (emitter
position sets into a fluid's — or fire/lightning/rain's — `positions`, full
specs so animate-points paths/gates ride along), and **video** (frame streams
into combines/outputs, including the optional refracted input of waves/rain).
The **montage** card consumes no video edges: its children are **composition
extracts** — data references into the project's composition pool, each rendered
in a private recursive `Dag` over the extract's window (local frame 0 lands on
the cut) and cut on the live union of the trigger's gate rises and the manual
breakpoints, minus per-cut disables. Exclusivity holds by construction (each
extract owns its own child Dag), so the old slot-exclusivity validation rule is
gone; the pool-level rule is **acyclicity** (`validate_pool` — a composition
must not contain itself). Every modulatable port is either a `const` or a
`{nodeId, lo, hi}` binding — kept in lockstep with a matching edge (the
**binding↔edge invariant**, enforced by the frontend mutation helpers).

### The simulation & sources

- **`fluid.py`** — a Stam stable-fluids solver (FFT Poisson) with per-dye-layer
  advection and per-frame parameter injection. **`FluidClip`** is the resumable
  form: block streaming advances the same sim in ~5s chunks (block K+1's field
  *is* block K's — time can't be parallelised). Also owns the ffmpeg encoders
  (one-shot mp4 + a fragmented streaming encoder whose file is playable while it
  grows). Both go through `_encode_args`, which sets `-preset faster` (measured:
  1.46x `medium` at a marginally better SSIM) and a **CRF that differs by
  purpose** — `CRF_EXPORT` for renders, `CRF_DEFAULT` for previews. The export
  value rides in the **`output` settings dict** (`song_render.output_from_export`,
  the lockstep anchor for both HD paths), never read from `export` at the encoder:
  `output_hash` folds that dict in whole, so changing the quality re-keys every HD
  cache entry on its own — no `RENDER_VERSION` bump, no clip served at the old
  setting. **Fire mode** (`params["fire"]`): a normalised temperature field rides
  the same solver — heat emitters (max-blend splats), buoyancy along a rotatable
  "up" (the fire card's `direction`), analytic quartic cooling, T-weighted
  vorticity confinement, blackbody rendering — so the fire card inherits the
  whole emitter system (paths, gates, points, per-frame modulation), the frame
  cache, block streaming and the merge combine (fire merges with fire AND with
  dye fluids: dye + fire tonemaps screen-blend).
- **`sources.py`** — a facade; the non-fluid layers themselves are split by where
  their pixels come from: **`sources_text`** (lyrics + font/wrap/fit),
  **`sources_gen`** (backdrop + the simulation cards), **`sources_media`** (the
  file-backed image/video/slideshow cards + the box-placement helpers only they
  use), over a small **`sources_common`** (`SOURCE_PARAMS`, `_at`).
  Lyrics rasterise the aligned lines
  (font fit solved once per distinct line); image/video place an asset into a
  normalized box; **`VideoClip`** mirrors `FluidClip` — one persistent ffmpeg
  decoder read forward across blocks, reopened only on a backward seek. The
  **generative simulation cards** (waves / lightning / aurora / rain / clouds)
  live here too, on the `procgen` kit: each takes `layers` — one dict of
  full-length port arrays per merged card — so a merge combine genuinely shares
  ONE field (wave heights superpose, drops ripple one surface, bolts light one
  sky, densities shade under one sun; mixed kinds raise → use a stack). Waves
  and rain also take an optional `base` (the upstream `video` input they
  refract). Rain is the one **stateful** non-fluid producer: its spectral
  surface `(ĥ, ĥ⁻)` threads through contiguous blocks (the `_echo_block`
  closure pattern); everything else is a pure function of the absolute frame.
- **`procgen.py`** — the shared physics/rendering kit: 2-D value-noise fbm,
  directional wave spectra with deep-water dispersion + analytic Hessians,
  Jacobian caustic splatting, bilinear displacement, dielectric-breakdown
  (Laplacian-growth) bolt trees, the spectral capillary-wave propagator,
  the Planck blackbody ramp, palettes, and the capped internal sim grid
  (`sim_dims`/`upscale`).
- **`signals.py`** — audio features (energy/onset/flux/brightness/harmonic/
  chroma/beat/bar) + shaping into 0..1 curves; the STFT is LRU-cached.
- **`song_render.py`** — the whole-song export, on two paths chosen by
  `independent_segments`:
  - **Incremental** (no fluid field in more than one segment — montage/video/
    text projects): each segment renders to its own HD clip keyed by
    `output_hash` — the SAME cache entry the single-segment HD button writes —
    so a re-export after editing one segment re-renders that segment only and
    stream-copy CONCATs the rest (every clip shares encoder settings by
    construction); audio muxed once at the end.
  - **Continuous** (any potential cross-segment layer): one persistent
    `FluidSim` per layer number advances across the entire song; crossing a
    segment boundary only swaps the injected rules (emitters/medium/colours),
    so velocity and dye flow through the cut. Each segment's window is styled
    through its own DAG and streamed to a single encoder; audio muxed at the
    end. Full re-render on any edit — the price of continuity. The detection is
    deliberately coarse (field layers key continuity by `data.layer` OR
    discovery order, so any two field-bearing segments may couple); a false
    negative just takes this slower path.

### Jobs

Two deliberately separate in-memory managers (single-process, reset on restart —
fine for a local tool):

- **`jobs.py`** — ingestion (yt-dlp / Demucs / Whisper) **and local image
  generation** (`imagegen.py`, the Image gen card's ✨ — a local diffusion model
  on MPS, lazily loaded). **One worker**, so GPU work never overlaps (and
  matplotlib state stays single-threaded).

### Remote inference (optional)

Every diffusion entrypoint (`imagegen.generate` / `stylize_frames` / `depth_frames`)
consults `settings.remote_endpoint(op)` first: when the ⚙ settings
(`data/settings.json`, `backend/settings.py`, routes in `routes/settings.py`) enable
it for that operation, the call ships to a rented GPU running `backend/remote_app.py`
— a thin Flask wrapper around the SAME imagegen module (which picks cuda there via
`_pick_device`). Transport is compressed npz via `backend/remote_client.py`, stylize
in batches of 8 frames (progress per batch). Failures raise a clear RuntimeError on
the card — no silent local fallback. `remote_app` pins `KAIKA_FORCE_LOCAL` so the
GPU box can never bounce a request back out.
- **`render_jobs.py`** — streaming renders. Two workers, per-job cancel events;
  the UI cancels the previous render on every edit, so an abandoned render stops
  between blocks.

## Caching (three layers)

1. **Raw frames** — `fluid_cache.py`, `data/fluid_cache/*.npy`. Keyed by
   `fluid.params_hash(params)` — *physics only* — so a downstream-only edit
   (colour, layer opacity, lyrics tweak) reuses the expensive sim and re-runs
   only the cheap per-frame ops. Memory-mapped for cheap block slicing, with an
   incremental writer for streaming renders. The **montage** stores its extracts
   here too, under `comp-<hash>-<gh>x<gw>`: the key is `output_hash` over the
   CHILD composition rendered in its context window. A window-INsensitive child
   (no signal/lyrics node, no `sync:"song"` clip — `_window_sensitive`) keys on
   the HOST window, so appending an extract renders only the new one and
   retiming the trigger re-renders only extracts that grew past their cached
   run; a sensitive child keys on its true absolute window (same composition at
   two windows = two renders — the contextual time base, by design). Bounded by
   the same LRU + age caps; the reachability sweep never touches this directory.
2. **Encoded clips** — `render_cache.py`, `data/fluid/<hash>.mp4`. Keyed by
   `output_hash`; LRU + age caps as a **backstop**.
3. **The reachability sweep** — `cache_gc.py`, the *primary* cleaner. After each
   project save (and once at startup) it recomputes every clip hash and asset
   file the **current state of every saved project** points to, and deletes the
   rest (minus a 30-min recency window for the live editing session). It bails
   without deleting when the DB is unreachable — "can't tell what's reachable"
   must never read as "nothing is reachable". Whole-song HD exports
   (`song_<hash>.mp4`) are reachable too, via the stem **recorded at export time**
   in the analysis cache (`song_exports`) plus a best-effort recompute — the
   recorded stem is required because the export's HD image regeneration swaps
   imagegen assetUrls in memory only, so its hash can't be rebuilt from the saved
   row. Single-segment HD renders (`/export/segment`) record the same way under
   `segment_exports` (both the silent clip and its `hd-…` muxed sibling, last 10)
   — for those the record is the ONLY source: they render the client's graph,
   which may never have been saved.

**The `output_hash` contract**: the cache key covers one output's *contributing*
sub-DAG (nodes + edges upstream of that output), the referenced signal
definitions, segment bounds, job id, project output settings, and
`RENDER_VERSION` (`backend/graph_hash.py`). The frontend mirrors it
(`lib/graph/hash.ts`) to gate redundant render POSTs; the backend hash is
authoritative (it also names the cached file). Editing pipeline B never busts
pipeline A's cache; moving a card (x/y) changes nothing. **Bump
`RENDER_VERSION` whenever render semantics change** so stale clips invalidate.

## Frontend

### The graph model (`lib/graph/`, barrel: `lib/graphModel.ts`)

Framework-free domain logic, imported through the barrel:

- `core.ts` — id makers, the ports guard, video-producer sets.
- `factories.ts` — one factory per card + **`GRAPH_VERSION`** (the persisted
  graph schema version).
- `mutations.ts` — immutable edits that keep the binding↔edge invariant
  (`connect` writes both the port binding and the edge; `removeNode` resets any
  binding that pointed at the node).
- `normalize.ts` — `normalizeGraph`: migrates any older save to the current
  `GRAPH_VERSION` on load. Per-type field coercion is a **schema table**
  (`DATA_SCHEMAS`); genuinely special migrations (fluid ports, combine slots,
  the video `speed` static→port carry) are explicit branches. Idempotent —
  returns the same object when nothing changed.
- `validate.ts` / `hash.ts` — mirrors of the backend validate/hash (backend
  stays authoritative).

### Node cards (`components/animation/nodes/`)

Every card is one component registered in **`registry.ts`** (`NODE_TYPES`):
component + chrome (title/accent/out-flow) + palette entry + factory. The
canvas, palette, compact card and dispatch all read the registry — adding a
card touches no shared component. There is **one view**: every card renders
**compact** (header + live preview + one in/one out anchor; the body opens the
full card in a settings modal), except `output`, whose body IS the render
preview. The old "detailed" mode, its toolbar toggle, `graph.viewMode`,
`graph.viewOverrides` and the second coordinate set (`cx/cy`) were all removed
at GRAPH_VERSION 29 — see [`specs/remove-detailed-mode/`](specs/remove-detailed-mode/)
and `factories.ts` for the version log. `normalizeGraph` folds any of those
fields away on load, so `x/y` is the only position. `lib/graph/layout.ts` holds
`flowLayout` (layered columns along the data flow; dummy-node routing for long
wires + greedy barycenter/swap crossing reduction + y-alignment of wired cards)
behind the ✨ arrange button (positions are node-level, never hashed).
Shared plumbing: `NodeFrame` (chrome + ports),
`useNodeData` (the patch-`data` hook), `AssetLayerCard` (the image/video shell),
`BoxPad` (normalized placement box), `useAssetUpload` (upload/YouTube flow).

`lib/nodeParams.ts` is the modulatable-port registry every card and the wiring
read — its values come from the **generated** `lib/fluidParams.js` (see
Codegen).

### The editor & studio

- **`GraphCanvas`** is node-type-agnostic: pan/zoom, bezier edges between
  measured port centres, marquee/group selection. Dragging is **local** — the
  canvas moves wrappers with a live offset and commits the graph **once on
  pointer-up**; cards are memoized (`NodeCard`) so canvas ticks don't re-render
  card bodies.
- **`useGraphEditor`** owns graph state (normalized from the active
  composition's graph, passed in by Studio through the pool), selection,
  mutation handlers, and the memoized `ctx` handed to every card.
- **Studio** hosts the two tabs and the shared transport. The playhead lives in
  an external store (`useSyncExternalStore`) — only the `TransportClock`
  re-renders on timeupdate ticks. Each `OutputNode` owns its own streaming
  render (debounced on its `outputHash`, cancelled on edit, polled with
  backoff).

### UI proposals behind `?ui=next` (`lib/uiFlag.ts`)

A UI change big enough to argue about ships as **live code beside the current
UI** rather than as a mockup: `isNext()` reads `?ui=next` off the URL, so the
same project opens both ways, one URL apart, and nothing is deleted until one
version wins. (`main.tsx` already branches the whole root on `?doc=`; this is
the same idea one level down.) Read live, never cached — a test flips it with
`history.replaceState`, and it is only consulted on discrete gestures.

Live today:

- **The port drop menu.** Every card but `output` is compact, so its one
  consolidated input dot can't say WHICH port a dropped wire meant; the editor's
  answer was to park every drop as a gray loose wire and make you assign it in
  the settings window. `dropPlan.ts` (pure) decides instead: `resolveDropPort`
  first — the existing auto-assign heuristic, which compact-only had made
  unreachable — then the card's own flow-compatible inputs; a lone free one
  wires itself, several open `PortDropMenu` at the drop point, and a card that
  can't take the flow at all still parks. Parking stays as the last row of the
  menu. `useGraphEditor` holds the open menu (the decision is about the graph);
  `AnimationCanvas` places it. Both entry points — a drop on the input dot and a
  drop on the card body — route through one `compactDrop`, and every outcome
  goes through `mutations.wirePort`, the shared helper `assignEdge` also uses,
  so the binding↔edge invariant holds by construction.
- **⌘K** (`components/next/`). 35 card types behind seven unsearchable category
  dropdowns, and nothing that jumps to a card or a segment by name. One box does
  all three: `commandItems.ts` (pure) builds the reachable set — every addable
  type, the segment's signals listed individually, the current composition's
  cards, the other segments — and ranks a query in three tiers (label-prefix >
  word-start > anywhere in the terms) so `co` offers `color` before `echo`. An
  added card wires itself from the selection only when `planDrop` — the same
  planner the drop menu uses — calls the port unambiguous.

Styles for all of these live in **`styles/animation/10-next.css`**, imported
last by the `animation.css` barrel: they must land on top of the current UI's,
and one file means a proposal that loses is deleted by deleting a file.

### API layer

`lib/api.ts` — typed wrappers over `postJson`/`getJson`; stream + export share
one `RenderStatus` shape (a 404 maps to state `"gone"` = stop quietly).
**The Vite dev proxy (`frontend/vite.config.js`) must list every backend route
prefix** — a missing entry means the frontend 404s on that API.

## The codegen contract

`backend/animation_params.py` holds the **single source of truth** for every
modulatable port: `FLUID_PARAM_SPEC`, `COLOR_PARAM_SPEC`, `SOURCE_PARAM_SPEC`
(label/range/step/default/format). From it derive:

- the executor's compact views (`PARAMS`, `COLOR_PARAMS`,
  `sources.SOURCE_PARAMS`) — what the render maps `[lo, hi]` through, and
- the **generated** `frontend/src/lib/fluidParams.js` (`make gen-params`) — what
  the UI shows, consumed by `nodeParams.ts`.

So a UI slider's range can never drift from what the render maps.
`tests/test_fluid_params_codegen.py` fails if the committed file is stale.
**Never hand-edit `fluidParams.js`.**

## Persistence & data

- **Postgres** (`db.py`, docker-compose): one `projects` row per job — the whole
  editable tree as a JSONB `data` document with a `schema_version` (=2):
  `segments` (time ranges + signals + a `rootCompositionId` reference),
  **`compositions`** (the pool — every animation graph, keyed by a STABLE
  `comp-…` id; each entry `{id, name, graph, outputId?}` where `outputId` is
  the ★-final mark, defaulting to the sole output), output/export settings, and
  the asset library. The pool saves **in the autosave payload with the
  segments** (`save_segments`), not out-of-band like assets — it is client-owned
  editable state; assets are out-of-band only because the server appends them
  concurrently. Resolution helpers live in `backend/compositions.py`
  (`root_composition`, `final_output_id`) and `frontend/src/lib/compositions.ts`
  (which also owns hydration — ids are PRESERVED on load, unlike segment ids —
  and the pool-aware `splitAt`/`copyLayout` cloning). The v1→v2 migration is
  deliberately destructive: pre-pool `segment.graph` animations are dropped, so
  old projects open with empty animations instead of half-loading.
  `db.DBUnavailable` is the sentinel the cache GC respects.
- **`data/` tree** (`paths.py` — the one place directories are defined;
  **tests monkeypatch `backend.paths`**, consumers read the dirs late-bound):
  `uploads/`, `separated/`, `spectrograms/`, `analysis/` (cached Whisper/LLM
  results), `fluid/` (clips + `stream/` scratch), `fluid_cache/` (frames),
  `assets/<job>/<sha16>.<ext>` (content-addressed layer assets — identical
  uploads dedupe).
- **The Playground** — a real, seeded Postgres project (`POST /playground`,
  `card_demo.py`) with **one demo segment per card**, loaded from the committed
  `playground_pipelines.json` (exported from the live UI via
  `make export-playground` — never hand-edit). It doubles as the coverage
  harness, guarded from **both** sides:
  - `tests/test_card_impact.py` (backend) renders every pipeline and fails if a
    card has no working demo, if the clip is visually black, or if any node is
    **unreachable walking backwards from an output** (a demo carries no decorative
    cards — every node must contribute to the frame);
  - `__tests__/playgroundFixture.test.ts` (frontend) runs every pipeline through
    `normalizeGraph` and fails if it loses its card, and pins the layout (no two
    cards overlap under `layout.estimateCardSize`, positive whole-pixel coords).
    The backend never normalizes, so a **stale `version` stamp** on a fixture graph
    is invisible to pytest and silently drops a card the moment the UI loads it (a
    pre-v8 stamp renames the dye `color` card to `grade`; pre-v10 drops
    `transform`). **Keep each fixture graph stamped at the current
    `GRAPH_VERSION`.**

  Positions are safe to rewrite (`graph_hash._node_for_hash` strips `x/y`), so the
  fixture can be re-arranged with the app's own `lib/graph/layout.ts` `flowLayout`
  — it is pure and runs under bare `node` — then written to the Playground DB row
  and re-emitted with `make export-playground`. **Close the Playground browser tab
  first**: an open tab autosaves and will clobber the DB write.

## Invariants & gotchas

- **Every card needs a Playground pipeline** (`card_demo.CARD_LABELS` +
  `test_card_impact.py`). No exceptions — bundle a dummy asset if the card needs
  one.
- **The Vite proxy must list every backend route prefix**
  (`frontend/vite.config.js`), or the frontend 404s.
- **Generated / exported files are never hand-edited**: `lib/fluidParams.js`
  (run `make gen-params`) and `backend/playground_pipelines.json` (run
  `make export-playground`).
- **Binding↔edge invariant**: a wired port always has both a binding and an
  edge; use the `lib/graph/mutations.ts` helpers, never mutate edges/ports
  independently. **One documented exception**: a *loose* edge
  (`targetPort: "__in"`) is a wire parked on a card with NO binding — it draws
  gray, and both hashes/validators (frontend `lib/graph/{hash,validate}.ts`,
  backend `graph_hash`/`graph_validate`) filter it out, so it never affects a
  render. `assignEdge` promotes it to a real connection.
- **Version bumps**: `RENDER_VERSION` (`backend/graph_hash.py`) when render
  *semantics* change; `GRAPH_VERSION` (`lib/graph/factories.ts`) + a
  `normalizeGraph` migration when the persisted graph *shape* changes.
- **The composition pool is ACYCLIC**: a composition must never contain itself
  through montage extracts, directly or transitively — the reuse picker filters
  it at the source (`lib/compositions.wouldCycle`), `validate_pool` 400s it at
  the boundary. And the pool is pruned to what segments reach on save/load
  (`pruneOrphans`), never in the in-memory state.
- **Tests patch `backend.paths`** for data dirs — render code reads
  `paths.ANIM_DIR` etc. late-bound, so there is exactly one patch point.
- **`/logs` must never log** — it would feed the log stream it serves.
- **`graph.py` / `graphModel.ts` are facades** — import from them, implement in
  `graph_*.py` / `lib/graph/*`.
- The graph is guaranteed **acyclic** by validate, so node resolution is plain
  memoized recursion — no topological sort anywhere.

### Accepted trade-offs (audited, deliberately not "fixed")

Single-user local app — these are known and fine at this scale; revisit if the
deployment model changes:

- **200 MB JSON body cap** (`app.py`): big graphs parse whole into RAM per
  request.
- **Child-composition PREVIEW clips have uncomputable GC keys** — editing inside
  an extract streams the child over its context window, a hash the sweep can't
  recompute from the saved state (it doesn't know the breadcrumb's window).
  Those clips survive on recency alone and then age out; a wrongly-swept one
  rebuilds fast from the never-swept raw-frame cache. The clips the sweep DOES
  protect exactly are every root's (`_hashes_from` walks the pool closure).
  **Master trims** (`/export/trim` — `trim-<key>.mp4`, keyed on master+range,
  a state the DB never stores) live on the same recency terms and re-cut in
  seconds from the master.
- **`delete_project` leaves files until the next GC sweep** — reachability reaps
  them; deletion isn't immediate on disk.
- **Cross-job asset reads**: a graph may reference `/assets/<other-job>/…`; the
  GC then keeps that file alive under the referencing project.
- **`_gate_curve` is a per-frame Python loop** — O(frames) per gate node per
  export; profile before optimizing.
- **A sim inside a montage extract's child never commits its OWN raw-frame
  cache** — the extract's pulls stop at the extract window, so the child sim's
  writer discards its partial file. The montage caches each extract's finished
  frames itself instead (`comp-<hash>` entries, see Caching), so the
  re-simulation happens once rather than once per edit.

## Where to read more

- [`README.md`](README.md) — setup, run, API surface, storage.
- [`DEVELOPMENT.md`](DEVELOPMENT.md) — dev workflow + the add-a-param /
  add-a-node checklists.
- In-app user guide — every screen and control (`/?doc=`, source
  `frontend/src/components/Docs.tsx`).
The split is by **state, not by topic**: `specs/` is what shipped, `docs/` is what
is still moving.

- [`specs/`](specs/) — the design records for each feature wave
  (create-animation → hardening → improvement-batch → look-fx → polish →
  playground-cards → generative-cards → cleanup waves 1–2 → ai-stylize).
  **Historical**: they document *why* things are shaped this way, not what's next.
  Where a spec and the code disagree the code is right — a design record is the
  earlier intent, not a description of the product.
- [`specs/ai-stylize/`](specs/ai-stylize/) — the AI Stylize wave, and **the one
  exception to the rule above**: steps 0 and 2 shipped, 5 partly, and steps 1, 3
  and 4 were never built. Its README carries a per-step status table; the step
  files themselves are still written in the forward-looking voice they were
  drafted in.
- [`specs/cleanup/`](specs/cleanup/) — the code-quality series, **waves 1–4
  (`00`–`29`), all done**. Each step records what was deliberately NOT done and
  why, which is usually the more useful half. There is no open cleanup backlog;
  `docs/cleanup/` is gone because an empty one is not a living thing.
  ⚠ Read a step's own status header, not the README's summary table — wave 3's
  table claimed ten of thirteen steps were unbuilt when nearly all had landed,
  which is the finding [`29`](specs/cleanup/29-wave4-layout-and-the-unaudited-layer.md)
  opens on.
- [`docs/generative-cards/`](docs/generative-cards/) — 21 **unbuilt** card
  proposals (`07`–`27`). A backlog nobody has committed to; the six that were
  built moved to [`specs/generative-cards/`](specs/generative-cards/).
- [`docs/render-versions.md`](docs/render-versions.md) — the `RENDER_VERSION`
  changelog: what each bump changed and why it had to invalidate the cache.
- [`docs/history/`](docs/history/) — archived review backlog + old TODOs.
