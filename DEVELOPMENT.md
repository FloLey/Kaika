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

Node types are driven by two registries (frontend + backend), so adding one is a
component + two registrations — no edits to Palette / renderAnimNode / MinimizedCard
or the executor's dispatch.

1. **Types** (`lib/types.ts`): add the type to the `NodeType` union + a `<Type>Data`
   interface, and a member to the `GraphNode` discriminated union.
2. **Model** (`lib/graphModel.ts`): a `<type>Node(x, y)` factory; teach
   `normalizeGraph` its shape (bump `GRAPH_VERSION` if the persisted shape changes).
3. **Card** (`components/animation/nodes/<Type>Node.jsx`) + **register it** in
   `nodes/registry.ts` (`NODE_TYPES`): `Component`, `chrome` (title/accent/outFlow),
   and — if it's palette-addable — a `factory` + `palette` entry. That single entry
   wires the palette button, the canvas dispatch, and the minimized card.
4. **Executor** (`backend/graph.py`): a `_xxx_video` handler (and `_xxx_emitters` if
   it can feed a merge) registered in `_VIDEO_HANDLERS` / `_EMITTER_HANDLERS`.
   `_VIDEO_PRODUCERS` and the output-wiring check pick it up automatically. It's
   already covered by `output_hash`'s contributing-DAG walk (no edit needed).
5. **Tests**: `registry.test.jsx` and `test_graph_registry.py` already assert every
   registered type round-trips; add behaviour tests for the new card/handler.

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
- `src/lib/types.ts` — the core domain types: the **discriminated `GraphNode` union**
  (`SignalData`/`FluidData`/`CombineData`/`PointsData`/`OutputData`), `Graph`,
  `GraphEdge`, `Binding`, `OutputSettings`, `FluidParam`. Import these as files convert.

**Converted so far:** `lib/types.ts`, `lib/graphModel.ts` (the whole graph model),
`lib/output.ts`, `lib/useDragPad.ts`, `components/animation/nodes/registry.ts`,
`components/animation/useGraphEditor.ts`.

**To convert a file** (the established pattern):
1. Rename `foo.js` → `foo.ts` (or `.jsx` → `.tsx`); add types (import from `types.ts`).
2. Update its importers' specifiers from `"./foo.js"` to **`"./foo"`** (extensionless)
   — the production bundler (rollup) won't resolve a `.js` specifier to a `.ts` file,
   but resolves extensionless to `.ts`.
3. `npm run typecheck && npm run build && npm test` — all green before committing.

**Remaining tail (mechanical):** the `nodes/*` card components + the canvas/studio
shells convert `.jsx` → `.tsx` leaf-outward, typed against a shared `NodeProps`
(`registry.ts`) — at which point `NodeSpec.Component` tightens from `ComponentType<any>`
to `ComponentType<NodeProps>`. The `Studio`/`FluidLab` sub-component extractions land
here too (those files are rewritten anyway). Lower priority — the high-value typing
(the domain model + the registries) is done.

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

The frontend `eslint.config.js` lints **both** `.js/.jsx` and `.ts/.tsx` (via
`typescript-eslint`): recommended rules + the react-hooks checks, with
`@typescript-eslint/no-explicit-any` enforced as an error (justified boundaries —
the dynamic-JSON layers in `lib/api.ts` / `lib/segments.ts` — carry a commented
disable). `npm run lint` covers the whole TypeScript codebase.
