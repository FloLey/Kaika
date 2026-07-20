# CLAUDE.md

Kaika — a local web app that turns a song into an audio-reactive video: Demucs
stem separation → segment proposal → per-segment signal extraction → a node-graph
animation (fluid sims + lyric/image/video layers) → streaming renders and a
whole-song HD export. Flask JSON API (`:5000`) + React/Vite (`:5173`) + Postgres
(Docker) — the app runs natively for the MPS GPU.

## Documentation map

| Doc | What it's for |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | **Start here** — pipeline, module layout, caches, codegen contract, invariants |
| [`DEVELOPMENT.md`](DEVELOPMENT.md) | Dev workflow + checklists: add a param, add a node card |
| [`README.md`](README.md) | Setup, run, API surface, storage |
| `frontend/src/components/docs/` | The in-app **user guide** (`/?doc=<section>`), one file per section behind a thin `Docs.tsx`; every "?" in the UI deep-links into it — update it when user-facing behavior changes (a test guards its anchors) |
| [`specs/`](specs/) | Design records per feature wave — the *why* of work that SHIPPED, not a roadmap. One folder per wave |
| [`specs/generative-cards/`](specs/generative-cards/) | The six shipped generative cards (waves…clouds). The code diverged from these specs — the README says how |
| [`specs/cleanup/`](specs/cleanup/) | The code-quality series, waves 1–2 (`00`–`15`), done |
| [`specs/ai-stylize/`](specs/ai-stylize/) | The AI Stylize wave — **the one exception in `specs/`: only half of it was built.** Its README carries the per-step status; trust that, not the step prose |
| [`docs/`](docs/) | Only LIVING things: open backlogs, changelogs, archives. Nothing finished belongs here |
| [`docs/cleanup/`](docs/cleanup/) | The code-quality backlog, wave 3 (`16`–`28`) — **open**. Each step records what was deliberately **not** done and why |
| [`docs/generative-cards/`](docs/generative-cards/) | 21 UNBUILT card proposals (`07`–`27`) — a backlog nobody has committed to |
| [`docs/render-versions.md`](docs/render-versions.md) | The `RENDER_VERSION` changelog — why each bump invalidated the cache |
| [`docs/history/`](docs/history/) | Archived review backlog + old TODOs |

## Commands

```bash
make dev                 # Postgres (Docker) + Flask :5000 + Vite :5173 (HMR)
make test                # pytest + vitest   (test-backend / test-frontend for one side)
make lint                # everything CI gates on: ruff + black + eslint + tsc + prettier
make typecheck           # tsc --noEmit only, for the fast inner loop
make gen-params          # regenerate frontend/src/lib/fluidParams.js from backend specs
make seed-playground     # rebuild the Playground project in the DB
make export-playground   # capture the live Playground into playground_pipelines.json
make clean-cache         # drop rendered clips + raw-frame cache
make gc-cache            # reachability sweep of the caches
```

Backend tests run as `.venv/bin/python -m pytest -q`; frontend as
`cd frontend && npm run test`.

## Hard invariants

- **Every card needs a Playground pipeline** (`backend/card_demo.py`
  `CARD_LABELS`; `tests/test_card_impact.py` enforces it). Bundle a dummy asset
  if the card needs one — never exclude a card.
- **Every backend route prefix must be in the Vite proxy**
  (`frontend/vite.config.js`) or the frontend 404s on it.
- **Never hand-edit generated/exported files**: `frontend/src/lib/fluidParams.js`
  and `frontend/src/lib/graph/generated.ts` (both `make gen-params`), and
  `backend/playground_pipelines.json` (`make export-playground`).
- **Backend param specs are the source of truth** (`backend/animation_params.py`:
  `FLUID_/COLOR_/SOURCE_PARAM_SPEC`); the frontend tables derive via codegen,
  guarded by `tests/test_fluid_params_codegen.py`.
- **Binding↔edge invariant**: wire/unwire ports only through the
  `frontend/src/lib/graph/mutations.ts` helpers. Exception: *loose* edges
  (`targetPort: "__in"`, no binding) are parked wires — every hash/validate on
  both sides must keep filtering them out.
- **Version bumps**: `RENDER_VERSION` (`backend/graph_hash.py`) when render
  semantics change; `GRAPH_VERSION` (`frontend/src/lib/graph/factories.ts`) + a
  `normalizeGraph` migration when the persisted graph shape changes.
- **`graph.py` / `graphModel.ts` are facades** — import from them, implement in
  `backend/graph_*.py` / `frontend/src/lib/graph/*`.
- **Tests patch `backend.paths`** for data directories (render code reads them
  late-bound); don't reintroduce per-module dir constants.
- **`/logs` must never log** (it would feed itself).
- **Docs stay updated with every change.** These files are part of the
  deliverable, not an afterthought:
  - **Every new user-facing control gets a "?"** that deep-links into the guide:
    a modulatable port gets a `lib/paramHelp.ts` entry (its test FAILS on a port
    without help); other controls use `ui/Info.tsx` (or `ArgInfo`) with a
    `section` that exists in `Docs.tsx` `DOC_SECTION_IDS`.
  - **New/changed user-facing behavior** gets prose in `Docs.tsx` (add the
    section id to `DOC_SECTION_IDS`; the anchor-guard test keeps links honest).
  - **Structural changes** (modules, routes, caches, invariants) update
    `ARCHITECTURE.md` and, if a checklist/command changed, `DEVELOPMENT.md`;
    new API routes/setup steps update `README.md`.

## Conventions

- Commit **directly to `main`**; every commit ends green (pytest + vitest + lint
  + `tsc --noEmit`).
- Match the existing style: dense explanatory comments that give the *why*,
  immutable frontend updates, small focused modules.
- Python is Black-formatted, frontend Prettier-formatted (`make format`);
  ruff is lenient by design — `# noqa: BLE001` marks deliberate broad excepts.
- Whole-clip and block-streaming render paths must stay in lockstep. A new video
  card normally needs only a `_xxx_block` handler: register the whole-clip entry
  as `_whole_from_block("xxx")` (`backend/graph_render.py`). Write a separate
  `_xxx_video` only when the block handler carries cross-block state — today that
  is exactly `fluid`, `output`, `combine`, `montage` and `fire`; every other card
  in `_VIDEO_HANDLERS` derives. (`echo` used to be on this list: its accumulator
  is carried across blocks, but a single `produce(0, n)` call *is* the whole scan,
  so it derives too.) `test_card_impact` asserts whole == streamed for every card,
  so the two paths cannot drift.
