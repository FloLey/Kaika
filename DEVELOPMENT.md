# Development

A developer map of Kaika: the render pipeline, where things live, and the checklists
for the two changes that touch several files at once (adding a param, adding a node
type). For the full newcomer walkthrough see [`ARCHITECTURE.md`](ARCHITECTURE.md);
completed design records live in [`specs/`](specs/) and
[`docs/history/`](docs/history/); open backlogs live in [`docs/`](docs/).

## Run it

```bash
make install         # python deps (.venv) + npm deps
make dev             # Postgres (Docker) + Flask :5000 + Vite :5173 (HMR)
```

Quality gates (mirror CI):

```bash
make test            # pytest + vitest
make test-strict     # what CI runs: --strict-deps, so a missing dep FAILS instead of skipping
make lint            # ruff + black --check + eslint + tsc + prettier --check
make typecheck       # tsc --noEmit only (fast inner loop while editing .tsx)
make build           # vite production build
make coverage        # pytest --cov + vitest --coverage
make format          # Black (python) + Prettier (frontend) — see "Formatting"
make clean-cache     # drop rendered clips + raw-frame cache
make gc-cache        # reachability sweep (what saved projects no longer use)
make gen-params      # regenerate the frontend's generated files from the backend specs
```

## Architecture

```
upload ──> separate (Demucs/MPS) ──> spectrograms (librosa) ──> Postgres project
  │
review ──> segment proposal (Whisper align + LLM structure) ──> segments
  │
studio ──> per-segment SIGNALS (stem+band+shaping -> 0..1 curve)
  │              │
  │        animation NODE GRAPH (signal · modulators · fluid · color · points/
  │              │               pattern/animate · lyrics/image/video/backdrop ·
  │              │               combine · transform · output)
  │              │
  └──> /animate/stream ──> graph executor ──> fluid.simulate (block-streamed,
        cached) ──> growing mp4 ──> <video>;  /export/stream ──> whole-song HD
```

- **Backend** (`backend/`, Flask :5000, pure JSON API):
  - `app.py` — creates the app + registers the ten blueprints in `backend/routes/`
    (`uploads`, `assets`, `imagegen`, `stylize`, `jobs_routes`, `animation`,
    `export`, `projects`, `settings`, `serving` — absolute URLs, no prefixes) and
    kicks the startup cache GC.
  - `graph.py` — a thin **facade** over the graph package: `graph_common.py`
    (shared lookups + `composite`), `graph_validate.py` (`validate` → HTTP 400),
    `graph_hash.py` (`output_hash`, `RENDER_VERSION`), `graph_modulators.py`
    (value curves, colour cards, points pipelines), `graph_render.py`
    (`build_params`, the `Dag` resolver + handler registries, `render` /
    `render_stream`). Import from `backend.graph`; implement in the submodules.
  - `fluid.py` — the stable-fluids sim (FFT Poisson solve), per-dye-layer advection
    (per-component wrap), tonemap, the mp4 encoders, resumable `FluidClip`.
  - `sources.py` — a facade over `sources_text` (lyrics + font fit), `sources_gen`
    (backdrop + the generative simulations: waves / lightning / aurora / rain /
    clouds), `sources_media` (image, slideshow, video + the persistent `VideoClip`
    block decoder) and `sources_common` (`SOURCE_PARAMS`, `_at`). Import from
    `backend.sources`; implement in the submodules.
  - `animation_params.py` — **the** param specs (`FLUID_PARAM_SPEC`,
    `COLOR_PARAM_SPEC`, `SOURCE_PARAM_SPEC`); the executor views and the generated
    frontend `fluidParams.js` all derive from them.
  - `signals.py` — audio feature extraction + shaping (the 0..1 curves).
  - `segment.py` / `llm.py` — segmentation (beat grid, sections, lyrics).
  - `song_render.py` — the whole-song HD export (continuous per-layer fields).
  - `db.py` — Postgres persistence (project JSONB, `schema_version`).
  - `fluid_cache.py` / `render_cache.py` / `cache_gc.py` — raw-frame cache,
    encoded-clip LRU backstop, and the reachability sweep (the primary cleaner).
  - `jobs.py` (ingestion, 1 worker) / `render_jobs.py` (renders, cancel-on-edit).
  - `logbus.py` — in-memory ring of backend log records, served at `/logs` (see below).
- **Frontend** (`frontend/src/`, React + Vite :5173, proxies API to Flask —
  every backend route prefix **must** be listed in `vite.config.js`):
  - `lib/graphModel.ts` — a **barrel** over `lib/graph/*`: `core` (ids, producer
    sets), `factories` (+ `GRAPH_VERSION`), `mutations` (binding↔edge invariant),
    `normalize` (schema-driven migration), `validate`, `hash` (`outputHash`).
  - `lib/fluidParams.js` — **generated** from the backend specs (do not hand-edit);
    `lib/nodeParams.ts` is the registry every card reads.
  - `components/animation/` — the node-graph editor (`GraphCanvas`, `nodes/*` —
    33 cards behind `nodes/registry.ts` — `renderAnimNode`, `useGraphEditor`).
  - `components/studio/` — the studio shell, signal cards, transport.
  - `components/assets/`, `components/export/` — asset library, final export.

## Checklist — add a param

The backend param specs are the single source of truth; everything else derives
or asserts. Three spec families live in `backend/animation_params.py`:
`FLUID_PARAM_SPEC` (the fluid card), `COLOR_PARAM_SPEC` (the dye card), and
`SOURCE_PARAM_SPEC` (per card, 17 of them: the source cards lyrics / text / image /
slideshow / video / montage / backdrop, the six generative sims waves /
lightning / fire / aurora / rain / clouds, and the FX cards transform / echo /
colorgrade / stylize).

1. Add an entry to the right spec in `backend/animation_params.py`
   (`label`/`min`/`max`/`step`/`default`/`fmt`; fluid rows also carry
   `sim_group`/`ui_group`).
2. `make gen-params` — regenerates `frontend/src/lib/fluidParams.js`. Commit it.
   (`lib/nodeParams.ts` picks it up automatically.)
3. Make the consumer read the new key: `fluid.simulate` for a fluid param
   (`source.*` / `fluid.*`), the matching `sources.py` function for a source-card
   param.
4. Add a one-line help entry in `frontend/src/lib/paramHelp.ts` — its test fails
   if a port has no "?" help.
5. `make test` — `test_fluid_params_codegen.py` asserts the generated file matches.

## Checklist — add a node type

Node types are driven by two registries (frontend + backend), so adding one is a
component + two registrations — no edits to Palette / renderAnimNode / CompactCard
or the executor's dispatch.

1. **Types** (`lib/types.ts`): add the type to the `NodeType` union + a `<Type>Data`
   interface, and a member to the `GraphNode` discriminated union.
2. **Model** (`lib/graph/factories.ts`): a `<type>Node(x, y)` factory; teach
   `normalizeGraph` its shape — for a flat field bag that's one row in the
   `DATA_SCHEMAS` table in `lib/graph/normalize.ts` (bump `GRAPH_VERSION` if the
   persisted shape changes). Re-export the factory from the `graphModel.ts` barrel.
3. **Card** (`components/animation/nodes/<Type>Node.tsx`) + **register it** in
   `nodes/registry.ts` (`NODE_TYPES`): `Component`, `chrome` (title/accent/outFlow),
   and — if it's palette-addable — a `factory` + `palette` entry. That single entry
   wires the palette button, the canvas dispatch, and the minimized card.
4. **Executor** (`backend/graph_render.py`): normally just a **`_xxx_block`**
   streaming handler in `_BLOCK_HANDLERS`, with the whole-clip entry registered as
   `_whole_from_block("xxx")` in `_VIDEO_HANDLERS` — one handler per card, not two.
   Write a separate `_xxx_video` **only** when the block handler carries cross-block
   state (fluid, combine, montage, fire). Add `_xxx_emitters` to
   `_EMITTER_HANDLERS` if the card can feed a merge combine.
   Then add the type to **`VIDEO_PRODUCERS` in `backend/graph_common.py` by hand** —
   it does *not* register itself, and an import-time assert in `graph_render.py`
   fails loudly if you forget. `output_hash`'s contributing-DAG walk needs no edit.
   `test_card_impact` asserts whole == streamed for every card, so the two paths
   cannot drift.
5. **Playground pipeline** — every card must have a working demo segment: add its
   label to `backend/card_demo.py` `CARD_LABELS`, build the pipeline in the live
   Playground, then capture it into `playground_pipelines.json` with either the
   **💾 save fixture** button (top of the Playground's CARDS rail) or
   `make export-playground` (never hand-edit that file). A demo whose graph
   references child compositions (the montage's extracts) carries its reachable
   slice in a per-entry `compositions` key — the export writes it, the seed
   merges it back under stable `comp-demo-…` ids. `test_card_impact.py`
   renders every pipeline (with its slice as the pool) and fails on a
   missing/blank one. Once the fixture has
   the demo, LIVE playgrounds pick it up additively on their next open
   (`ensure_playground` appends segments for cards the rail lacks, by label —
   no destructive `make seed-playground` needed; that stays the force-rebuild).
6. **Tests**: `registry.test.tsx` and `test_graph_registry.py` already assert every
   registered type round-trips; add behaviour tests for the new card/handler.

## The render cache

A clip is keyed by `output_hash` (backend) / `outputHash` (frontend): the
contributing sub-DAG of one output + referenced signal defs + segment bounds + the
project output settings + `RENDER_VERSION`. Editing anything that changes the
rendered output changes the key. Bump `RENDER_VERSION` (`backend/graph_hash.py`)
when render *semantics* change so old clips invalidate.

Three layers cooperate (full story in [`ARCHITECTURE.md`](ARCHITECTURE.md)):
raw sim frames in `data/fluid_cache/*.npy` (keyed by physics params only, so a
colour/FX tweak reuses the sim), encoded clips in `data/fluid/*.mp4`, and the
`cache_gc` **reachability sweep** (the primary cleaner — keeps what saved
projects still point to; runs on save/startup). `render_cache`'s LRU + age caps
are the backstop; `make clean-cache` drops everything, `make gc-cache` sweeps.

## Logs panel

`logbus` keeps an in-memory ring (1000 entries) of backend log records and serves
incremental slices at `GET /logs?since=<seq>`. The frontend Logs panel polls it
(~2 s) and also captures browser console errors, so a user session can be debugged
without shell access. It is always on and has no persistence (records reset on
restart). The `/logs` route must never log (it would feed itself).

## TypeScript

The frontend is fully TypeScript (`strict`; `npm run typecheck` = `tsc --noEmit`,
gated in CI). `src/lib/types.ts` holds the core domain types — the discriminated
`GraphNode` union, `Graph`, `GraphEdge`, `Binding`, `OutputSettings`,
`FluidParam` — import from there rather than redeclaring shapes. The one
deliberate exception is the **generated** `lib/fluidParams.js` (plain JS by
design); `lib/graph/core.ts` and `lib/nodeParams.ts` pin its shapes at the import
boundary.

## Formatting

Black (Python) + Prettier (frontend) are configured (`pyproject.toml`,
`.prettierrc.json`) and the one-time repo-wide reformat **has been applied** (its SHA
is in `.git-blame-ignore-revs`). CI now gates formatting: `black --check backend tests`
and `npm run format:check` must pass. Keep the tree formatted as you go:

```bash
make format          # Black + Prettier across the tree
```

Enable `git blame` to skip the reformat commit (once per clone):

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

To catch formatting before it reaches CI, install the pre-commit hooks (ruff + black
+ prettier, pinned in `.pre-commit-config.yaml`):

```bash
pip install pre-commit && pre-commit install
```

## Lint config

`ruff.toml` is intentionally lenient (bug-catching rules only; `I`/`UP` excluded —
import-sort would break the `matplotlib.use("Agg")` ordering). Blind excepts are
flagged (`BLE`) and suppressed case-by-case with `# noqa: BLE001` where the fallback
is deliberate.

The frontend `eslint.config.js` lints the whole tree via `typescript-eslint`:
recommended rules + the react-hooks checks, with
`@typescript-eslint/no-explicit-any` enforced as an error (justified boundaries —
the dynamic-JSON layers in `lib/api.ts` / `lib/segments.ts` — carry a commented
disable). `npm run lint` covers the whole TypeScript codebase.
