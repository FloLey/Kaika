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
  routes/           five blueprints (absolute URLs, no prefixes)
  graph.py          ← 87-line facade; the executor lives in graph_*.py
  fluid.py          the fluid simulation (+ fire mode) + encoders
  sources.py        non-fluid video layers (lyrics/image/video/backdrop + sim cards)
  procgen.py        the simulation kit (wave spectra, caustics, DBM, spectral ripple…)
  song_render.py    whole-song HD export
  *_cache.py, cache_gc.py, jobs.py, render_jobs.py, db.py, paths.py …
frontend/src/
  lib/              domain logic (graph model, api, params, segments)
  lib/graph/        ← the graph model package; graphModel.ts is its barrel
  components/       studio / animation (+ nodes/) / assets / export / review / upload
tests/              pytest (backend); frontend/src/__tests__/ is vitest
specs/              completed design records (the why, not a roadmap)
docs/history/       archived review/backlog docs
data/               gitignored working data (uploads, stems, caches, assets)
```

## Backend

### Routes (`backend/routes/`)

`app.py` only creates the app, registers the five blueprints, and kicks a
startup cache sweep. Each blueprint keeps its historical absolute URLs:

| Blueprint | Routes |
|---|---|
| `uploads.py` | `/upload`, `/segment`, `/jobs/<id>`, `/logs`, `/upload-asset/<job>`, `/asset-from-youtube/<job>`, `GET/DELETE /assets/<job>[/<id>]` |
| `animation.py` | `/extract`, `/resolve`, `/fluid`, `/animate`, `/animate/stream` (+ status/cancel) |
| `export.py` | `/export/stream` (+ status/cancel) |
| `projects.py` | `/projects`, `/projects/<id>` GET/PUT/DELETE, `/playground` |
| `serving.py` | `/`, `/fonts`, `/fluid/<name>`, `/fluid/stream/...`, `/audio/...`, `/assets/<job>/<name>`, `/spectrogram/...` |

### The graph executor (`graph_*.py`)

`graph.py` is a thin **facade** — routes and tests import from `backend.graph`,
the implementation lives in five modules:

- **`graph_common.py`** — shared constants + edge/node lookups + `composite`
  (the alpha-over stack). The leaf module; everything imports from here.
- **`graph_validate.py`** — `validate(graph, output_id=None)`: raises `ValueError`
  → HTTP 400 on an unrenderable graph (missing output, malformed bindings, cycles,
  a stacked combine feeding a merge). `output_id` names the render **target**: when
  it's a producer previewed directly (not an output node), the output-node rules are
  skipped — a graph mid-build has no output yet, and an unrelated half-wired output
  must not 400 a card's preview.
- **`graph_hash.py`** — `output_hash(...)`: the per-output render-cache key (see
  Caching below) + `RENDER_VERSION`.
- **`graph_modulators.py`** — every node that produces a 0..1 **value curve**
  (signal / LFO / noise / shaper / math / scope), the colour-card resolver, the
  points pipelines (pattern / animate / merge), and `resolve_node_curve` (the
  Scope card's live view).
- **`graph_render.py`** — `build_params` (graph → `simulate()` params), the
  **`Dag`** resolver (memoized per-node video/emitter resolution), the per-type
  handler registries (`_VIDEO_HANDLERS` whole-clip, `_BLOCK_HANDLERS` streaming,
  `_EMITTER_HANDLERS` merge), and the entry points `render` / `render_stream`.
  Their `output_id` may be an **output node** (render the video wired into it) or
  **any video producer directly** (fluid/combine/transform — the per-card live
  previews); `_render_target` is the one shared resolver of that contract, so the
  sync and streaming paths can't drift, and it's what `validate` keys its
  output-node rules off. The frontend mirror is `nodeRenderable`
  (`lib/graph/validate.ts`) — cards only stream what the backend would accept.

A node graph has three edge flows: **value** (0..1 curves into modulatable
ports, each mapped through a per-port `[lo, hi]` range), **points** (emitter
position sets into a fluid's — or fire/lightning/rain's — `positions`, full
specs so animate-points paths/gates ride along), and **video** (frame streams
into combines/outputs, including the optional refracted input of waves/rain). Every modulatable port is either a `const` or a
`{nodeId, lo, hi}` binding — kept in lockstep with a matching edge (the
**binding↔edge invariant**, enforced by the frontend mutation helpers).

### The simulation & sources

- **`fluid.py`** — a Stam stable-fluids solver (FFT Poisson) with per-dye-layer
  advection and per-frame parameter injection. **`FluidClip`** is the resumable
  form: block streaming advances the same sim in ~5s chunks (block K+1's field
  *is* block K's — time can't be parallelised). Also owns the ffmpeg encoders
  (one-shot mp4 + a fragmented streaming encoder whose file is playable while it
  grows). **Fire mode** (`params["fire"]`): a normalised temperature field rides
  the same solver — heat emitters (max-blend splats), buoyancy along a rotatable
  "up" (the fire card's `direction`), analytic quartic cooling, T-weighted
  vorticity confinement, blackbody rendering — so the fire card inherits the
  whole emitter system (paths, gates, points, per-frame modulation), the frame
  cache, block streaming and the merge combine (fire merges with fire AND with
  dye fluids: dye + fire tonemaps screen-blend).
- **`sources.py`** — the non-fluid layers. Lyrics rasterise the aligned lines
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
- **`song_render.py`** — the whole-song export. Instead of stitching segment
  previews, it keeps **one persistent `FluidSim` per layer number** and advances
  it across the entire song; crossing a segment boundary only swaps the injected
  rules (emitters/medium/colours), so velocity and dye flow through the cut.
  Each segment's window is then styled through its own DAG (lyrics, layers,
  combines) and streamed to a single encoder; audio is muxed at the end.

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
   incremental writer for streaming renders.
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
   row.

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
card touches no shared component. The canvas has two **view modes** switched
from the toolbar — `graph.viewMode`: "detailed" (default, classic full cards) or
"compact" (header + live preview + one in/one out anchor; the body opens the
full card in a settings modal) — with `graph.viewOverrides` listing per-card
exceptions (GRAPH_VERSION 16; the earlier `expanded`/`minimized` sets are
stripped on load); `output` never compacts. Each view keeps its **own card
positions** (v20): `x/y` is the detailed position, optional `cx/cy` the compact
one — `useGraphEditor` hands the canvas a display graph and translates commits
back. `lib/graph/layout.ts` holds the layout passes: minimal-movement
de-overlap/tighten behind the mode switch, and `flowLayout` (layered columns
along the data flow; dummy-node routing for long wires + greedy barycenter/
swap crossing reduction + y-alignment of wired cards) behind the ✨ arrange
button (positions are node-level, never hashed).
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
- **`useGraphEditor`** owns graph state (normalized from `segment.graph`),
  selection, mutation handlers, and the memoized `ctx` handed to every card.
- **Studio** hosts the two tabs and the shared transport. The playhead lives in
  an external store (`useSyncExternalStore`) — only the `TransportClock`
  re-renders on timeupdate ticks. Each `OutputNode` owns its own streaming
  render (debounced on its `outputHash`, cancelled on edit, polled with
  backoff).

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
  editable tree (segments, signals, animation graphs, output/export settings,
  the asset library) as a JSONB `data` document with a `schema_version`.
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
- **`delete_project` leaves files until the next GC sweep** — reachability reaps
  them; deletion isn't immediate on disk.
- **Cross-job asset reads**: a graph may reference `/assets/<other-job>/…`; the
  GC then keeps that file alive under the referencing project.
- **`_gate_curve` is a per-frame Python loop** — O(frames) per gate node per
  export; profile before optimizing.

## Where to read more

- [`README.md`](README.md) — setup, run, API surface, storage.
- [`DEVELOPMENT.md`](DEVELOPMENT.md) — dev workflow + the add-a-param /
  add-a-node checklists.
- In-app user guide — every screen and control (`/?doc=`, source
  `frontend/src/components/Docs.tsx`).
- [`specs/`](specs/) — the design records for each feature wave
  (create-animation → hardening → polish → playground-cards). **Historical**:
  they document *why* things are shaped this way, not what's next.
- [`docs/history/`](docs/history/) — archived review backlog + old TODOs.
