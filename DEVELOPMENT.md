# Development

A developer map of Kaika: the render pipeline, where things live, and the checklists
for the two changes that touch several files at once (adding a fluid param, adding a
node type). For the consolidation backlog see [`CODE_REVIEW.md`](CODE_REVIEW.md).

## Run it

```bash
make install         # python deps (.venv) + npm deps
make dev             # Postgres (Docker) + Flask :5000 + Vite :5173 (HMR)
```

Quality gates (mirror CI):

```bash
make test            # pytest + vitest
make lint            # ruff + eslint
make build           # vite production build
make coverage        # pytest --cov + vitest --coverage
make format          # Black (python) + Prettier (frontend) — see "Formatting"
make clean-cache     # drop rendered clips (data/fluid/*.mp4)
```

## Architecture

```
upload ──> separate (Demucs/MPS) ──> spectrograms (librosa) ──> Postgres project
  │
review ──> segment proposal (Whisper align + LLM structure) ──> segments
  │
studio ──> per-segment SIGNALS (stem+band+shaping -> 0..1 curve)
  │              │
  │        animation NODE GRAPH (signal | fluid | combine | points | output)
  │              │
  └──────> /animate ──> graph executor ──> fluid.simulate ──> mp4 (cached) ──> <video>
```

- **Backend** (`backend/`, Flask :5000, pure JSON API):
  - `app.py` — routes (`/upload`, `/segment`, `/extract`, `/fluid`, `/animate`, `/projects`, `/logs`).
  - `graph.py` — the graph executor: validate → per-output hash (cache key) → resolve
    the video DAG (`_Dag`) → `build_params` → `fluid.simulate`. Background applied at
    the terminal.
  - `fluid.py` — the stable-fluids sim (FFT Poisson solve), per-dye-layer advection
    (per-component wrap), tonemap, `render_mp4`.
  - `animation_params.py` — **the** fluid param spec (`FLUID_PARAM_SPEC`); `PARAMS`
    and the frontend `fluidParams.js` both derive from it.
  - `signals.py` — audio feature extraction + shaping (the 0..1 curves).
  - `segment.py` / `llm.py` — segmentation (beat grid, sections, lyrics).
  - `db.py` — Postgres persistence (project JSONB, `schema_version`).
  - `render_cache.py` — LRU/age eviction for `data/fluid/`.
  - `jobs.py` — background job registry (upload/segment).
  - `logbus.py` — in-memory ring of backend log records, served at `/logs` (see below).
- **Frontend** (`frontend/src/`, React + Vite :5173, proxies API to Flask):
  - `lib/graphModel.js` — node/edge factories, wiring, `validate`, `outputHash`
    (the render cache key), `normalizeGraph` (version migration).
  - `lib/fluidParams.js` — **generated** from the backend spec (do not hand-edit).
  - `components/animation/` — the node-graph editor (`GraphCanvas`, `nodes/*`,
    `renderAnimNode`).
  - `components/studio/`, `components/fluid/` — the studio shell and FluidLab.

## Checklist — add a fluid param

The param spec is the single source of truth; everything else derives or asserts.

1. Add an entry to `FLUID_PARAM_SPEC` in `backend/animation_params.py`
   (`sim_group`/`ui_group`/`label`/`min`/`max`/`step`/`default`/`fmt`).
2. `make gen-params` — regenerates `frontend/src/lib/fluidParams.js`. Commit it.
3. Make `fluid.simulate` read the new key (under `source.*` or `fluid.*`).
4. `make test` — `test_fluid_params_codegen.py` asserts the generated file matches.

## Checklist — add a node type

1. **Model** (`lib/graphModel.js`): a factory; teach `normalizeGraph` its shape
   (bump `GRAPH_VERSION` if the persisted shape changes); update `validate`/wiring.
2. **UI**: a `nodes/<Type>Node.jsx`; a `renderAnimNode` case; a Palette button.
3. **Executor** (`backend/graph.py`): a `_Dag.video`/`emitters` branch; fold it into
   `output_hash`'s contributing-DAG walk so its edits bust the cache.
4. **Tests**: graph model + executor coverage.

## The render cache

A clip is keyed by `output_hash` (backend) / `outputHash` (frontend): the
contributing sub-DAG of one output + referenced signal defs + segment bounds + the
project output settings + `RENDER_VERSION`. Editing anything that changes the
rendered output changes the key. Bump `RENDER_VERSION` (`backend/graph.py`) when
render *semantics* change so old clips invalidate. Clips live in `data/fluid/` and
are evicted by `render_cache` (LRU + age); `make clean-cache` drops them all.

## Logs panel

`logbus` keeps an in-memory ring (1000 entries) of backend log records and serves
incremental slices at `GET /logs?since=<seq>`. The frontend Logs panel polls it
(~2 s) and also captures browser console errors, so a user session can be debugged
without shell access. It is always on and has no persistence (records reset on
restart). The `/logs` route must never log (it would feed itself).

## TypeScript (incremental migration)

The frontend is mid-migration to TypeScript, set up to convert **one file at a time**
with a green build the whole way:

- `tsconfig.json` — `allowJs: true` + `checkJs: false`, so `.js`/`.jsx` coexist with
  `.ts`/`.tsx`; only the `.ts`/`.tsx` files are type-checked (`strict`).
- `npm run typecheck` (`tsc --noEmit`) — gated in CI.
- `src/lib/types.ts` — the core domain types (`Graph`, `GraphNode`, `Edge`,
  `Binding`, `OutputSettings`, `FluidParam`). Import these as files convert.

**Converted so far:** `lib/output.ts`, `lib/useDragPad.ts`.

**To convert a file** (the established pattern):
1. Rename `foo.js` → `foo.ts` (or `.jsx` → `.tsx`); add types (import from `types.ts`).
2. Update its importers' specifiers from `"./foo.js"` to **`"./foo"`** (extensionless)
   — the production bundler (rollup) won't resolve a `.js` specifier to a `.ts` file,
   but resolves extensionless to `.ts`.
3. `npm run typecheck && npm run build && npm test` — all green before committing.

**Remaining tail:** `graphModel.js` (the highest-value target) needs a *discriminated
union* for `GraphNode.data` (fluid ports/static vs points vs combine) to type its
`node.data.*` access well rather than with casts — design that first. Then the
`nodes/*` components and the canvas/studio shells convert leaf-outward (this is also
where the `Studio`/`FluidLab` sub-component extractions from B5.1 land, since those
files are being rewritten anyway).

## Formatting

Black (Python) + Prettier (frontend) are configured (`pyproject.toml`,
`.prettierrc.json`) but the one-time repo-wide reformat has **not** been applied yet
— it's best run after the TypeScript migration so it isn't thrown away. When ready:

```bash
make format          # Black + Prettier across the tree (land as its OWN commit)
```

Then add that commit's SHA to `.git-blame-ignore-revs` and enable the `format:check`
steps in CI / the pre-commit hook (`pre-commit install`).

## Lint config

`ruff.toml` is intentionally lenient (bug-catching rules only; `I`/`UP` excluded —
import-sort would break the `matplotlib.use("Agg")` ordering). Blind excepts are
flagged (`BLE`) and suppressed case-by-case with `# noqa: BLE001` where the fallback
is deliberate.
