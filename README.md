# Kaika

Local web app to split a song into musical **segments** (intro / verse / chorus
…) and rework each one independently. Upload audio (or a YouTube URL) + optional
lyrics → it separates stems with [Demucs](https://github.com/adefossez/demucs)
(Apple-Silicon GPU via MPS), proposes a **segmentation** (lyric alignment + vocal
activity + timbre clustering, labelled by a local LLM with a heuristic fallback),
and opens a **studio** where each segment turns a stem + frequency band into a
shaped 0–1 **signal** — and a second tab where you wire those signals into a
node-graph **animation** (fluid simulations, lyrics, image/video layers,
backdrops) that renders to a looping video reacting to the music. A final
**export** stage renders the whole track in HD as one continuous simulation. A
seeded **Playground** project demos every card. Work is saved to Postgres so you
can **resume** later.

Backend: Flask + librosa + demucs + Whisper (mlx/faster-whisper) + Ollama (LLM
section labelling) + yt-dlp.
Storage: Postgres (editable state) + filesystem (audio/stems/spectrograms).
Frontend: React + Vite (Web Audio API).

> **New to the app? A full user guide ships in-app.** Click the **?** in the
> top-right of the header (it opens the guide at the section for the screen
> you're on), or click any small **?** next to a control to jump straight to that
> control's explanation. The guide is a React view
> ([`frontend/src/components/Docs.tsx`](frontend/src/components/Docs.tsx)) opened
> at `/?doc=<section>` — it walks through every screen, feature, and control.
>
> **New to the code?** Start with [`ARCHITECTURE.md`](ARCHITECTURE.md) — the
> newcomer map of the whole system — then [`DEVELOPMENT.md`](DEVELOPMENT.md) for
> the how-to checklists.

## Pipeline

1. **Upload** — drop a file / paste a YouTube URL, optionally add lyrics; Demucs
   separates 5 stems (original / vocals / drums / bass / other).
2. **Review** — listen and edit the proposed split: drag boundaries, add/remove
   cuts, merge, relabel.
3. **Studio** — pick a segment on the left; a bottom bar switches between two
   tabs, both sharing one transport (play / scrub / volume / loop):
   - **Extract signals by track** — for each stem, isolate a frequency band and
     extract a signal: choose a **feature** (energy, onset, flux, brightness,
     harmonic, chroma, beat/bar phase) and shape it (attack, release, gamma,
     threshold, gain, offset, invert).
   - **Create animation** — a drag-and-drop **node graph**: wire *signal* cards
     (plus *lfo / noise / shaper / math* modulators) into a *fluid* simulation
     card — every parameter is a modulatable input port with a `[lo, hi]` range —
     and on to a *video output* card. A *color* card drives the dye; *points /
     pattern / animate* cards place and move emitters; *lyrics*, *image*, *video*
     (uploads, a per-project **📚 asset library**, or YouTube import) and
     *backdrop* cards synthesise non-fluid layers; a *combine* card composes it
     all — **merge** (sources share one simulation and interact) or **layered**
     (stacked with per-input transparency). It **auto-renders** in streaming
     blocks (a long segment previews in ~5s chunks, cancelled on every edit) at
     the project's output size / quality / fps.
4. **Export** — mark one output per segment as **★ final**, then render the whole
   track in HD: one **continuous** simulation carries each layer across segment
   boundaries (only the wiring rules swap at a cut), streamed progressively and
   muxed with the original audio — or the vocals-removed **instrumental** (for
   covers / karaoke), mixed lazily from the separated stems.

   Everything is **per segment** and autosaves.

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the newcomer map: pipeline, module
  layout, the caches, the codegen contract, and the invariants.
- [`DEVELOPMENT.md`](DEVELOPMENT.md) — how-to checklists (add a param, add a
  node card) and dev workflow.
- **In-app user guide** — a React view
  ([`frontend/src/components/Docs.tsx`](frontend/src/components/Docs.tsx))
  explaining every screen and control (upload, segmentation, the Studio
  features/shaping knobs, the animation node-graph editor, assets, export, and
  the Playground). It opens in a new tab at `/?doc=<section>`; `main.tsx` renders
  it instead of the app when the `doc` query param is present. Every **?** in the
  UI does double duty: hover for a one-line tooltip, click to open the guide at
  the matching section (`ui/Info.tsx` takes a `section` prop matching an id in
  `Docs.tsx`). Edit `Docs.tsx` to update the docs — a test guards that every
  linked section exists.
- [`specs/`](specs/) and [`docs/history/`](docs/history/) — completed design
  records (the *why* behind features), not a roadmap.

## Setup

Requires Python 3.12 (demucs/torch lack newer wheels), Node 18+, `ffmpeg` on
PATH, and Docker/OrbStack (for Postgres).

```sh
cd <project-dir>          # the repo you just cloned
python3.12 -m venv .venv
.venv/bin/python -m pip install --upgrade pip -r requirements.txt
cd frontend && npm install && cd ..
```

The first separation downloads the `htdemucs` weights (~80 MB); the first lyric
alignment downloads a Whisper model; the first ✨ image generation downloads the
image model — the default `Tongyi-MAI/Z-Image-Turbo` is **~33 GB** (high quality,
minutes per image on MPS); set `IMAGEGEN_MODEL=stabilityai/sd-turbo` for a light
~2 GB near-instant alternative.

## Run (dev)

Postgres runs in Docker; the app runs natively so it can use the GPU (MPS) and
hot-reload. One command starts everything:

```sh
make dev      # Postgres (Docker) + Flask :5000 + Vite :5173, both hot-reloading
```

Open **http://localhost:5173** — the Vite dev server is the UI (with HMR) and
proxies API calls to Flask on `:5000`, which is a pure JSON API. `make db-up` /
`make db-down` manage just the database.

> Apple's Metal/MPS GPU is **not** reachable from a Linux container, so the app
> stays native for speed; Docker only runs Postgres.

## Configuration

Env vars (see `.env.example`): `DATABASE_URL` (default
`postgresql://demucs:demucs@localhost:5432/demucs`), `HOST`, `PORT`,
`FLASK_DEBUG`.

## API

The slow stages run in the **background** (`backend/jobs.py`): `/upload` and `/segment`
return a `job_id` immediately and the UI polls `/jobs/<id>`. A finished job's
`result` is the payload that stage used to return inline.

- `POST /upload` — audio file **or** `youtube_url`, + optional lyrics → kicks off
  demucs + spectrograms in the background. Returns `{job_id}`. The finished job's
  `result` is `duration`, `title`, `stems` (audio/spectrogram URLs + `sr`).
- `POST /segment` — `{job_id}` → runs Whisper lyric alignment + vocal activity +
  timbre clustering + LLM labelling in the background. Returns `{job_id}`; the
  finished job's `result` is segments + vocal envelope (analysis is cached).
- `GET /jobs/<job_id>` — poll a background job: `{state: running|done|error, step,
  error, result}`.
- `GET /projects` · `GET|PUT|DELETE /projects/<job_id>` — list / load / autosave
  / delete a project (segments + per-segment isolation edits live in Postgres).
  `POST /playground` ensures the seeded demo project exists.
- `GET /audio/<job>/<stem>` (Range/seek) · `GET /spectrogram/<job>/<stem>`.
- `POST /upload-asset/<job>` · `POST /asset-from-youtube/<job>` ·
  `GET /assets/<job>` · `DELETE /assets/<job>/<id>` — the per-project image/video
  **asset library** (content-addressed files served from `/assets/<job>/<name>`).
- `POST /extract` — one signal's curve for a (stem + band + segment) shaped by the
  knobs above → `{curve, times}` (the Studio calls this, debounced). `POST
  /resolve` returns one value node's curve (the Scope card's live view).
- `POST /animate/stream` — `{job_id, segment:{start,end,signals,lyric_lines},
  graph, output, output_id}` → resolves that output's node graph and renders it
  in **streaming blocks** (a growing, playable preview after ~one block). Returns
  `{render_id}`; poll `GET /animate/stream/<id>`, stop with `POST
  /animate/stream/<id>/cancel` (the UI cancels on every edit). `POST /animate` is
  the one-shot synchronous variant; `POST /export/stream` (+ status/cancel) is
  the whole-song HD export (its `export.audioMode` picks the muxed audio:
  the original mix or the vocals-removed **instrumental**, mixed lazily from the
  separated stems). Clips serve from `/fluid/<name>.mp4` (Range/seek).

## Tests & linting

```sh
.venv/bin/python -m pip install -r requirements-dev.txt   # ruff + pytest + tools
make test     # pytest + vitest          make lint      # ruff + eslint
make build    # vite production build     make coverage  # pytest --cov + vitest --coverage
make format   # Black + Prettier (run once, as its own commit)
```

CI (`.github/workflows/ci.yml`) runs lint + tests + build + the param-spec no-diff
check on every push/PR. For the architecture map and the add-a-param / add-a-node
checklists, see [`DEVELOPMENT.md`](DEVELOPMENT.md).

A **Logs panel** (right-side drawer) shows the live backend + browser log stream for
the session — handy for debugging a render. It's always on and not persisted (resets
on restart).

## Storage

- **Postgres** `projects` table: editable tree (segments, labels, boundaries,
  per-segment stem edits **and animation graph**, plus project-wide **output**
  settings) as JSONB + listing columns.
- **Filesystem** under `data/` (gitignored): `uploads/`, `separated/`,
  `spectrograms/` per `job_id`, `assets/<job>/` (image/video layer assets,
  content-addressed), plus `analysis/<job>.json` (vocal envelope + aligned
  lyrics, so resume is instant and Whisper doesn't re-run).
- **Caches** (see [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full story):
  `data/fluid/<hash>.mp4` — encoded clips keyed by the output's
  contributing-subgraph hash; `data/fluid_cache/*.npy` — raw simulation frames
  keyed by physics params, so downstream-only edits skip the sim. The primary
  cleaner is a **reachability sweep** (`cache_gc`, runs on save/startup) that
  keeps only what saved projects still point to; LRU + age caps are the backstop
  (`FLUID_CACHE_*` / `FLUID_FRAME_CACHE_*`); `make clean-cache` drops everything.

The project JSONB carries a `schema_version`; graphs carry a `version`, migrated
forward on load (`normalizeGraph`).
