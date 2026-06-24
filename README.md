# Demucs Studio

Local web app to split a song into musical **segments** (intro / verse / chorus
…) and rework each one independently. Upload audio (or a YouTube URL) + optional
lyrics → it separates stems with [Demucs](https://github.com/adefossez/demucs)
(Apple-Silicon GPU via MPS), proposes a **segmentation** (lyric alignment + vocal
activity + timbre clustering, labelled by a local LLM with a heuristic fallback),
and opens a **studio** where each segment turns a stem + frequency band into a
shaped 0–1 **signal**. A separate **Fluid Lab** renders a visual companion. Work
is saved to Postgres so you can **resume** later.

Backend: Flask + librosa + demucs + Whisper (mlx/faster-whisper) + Ollama (LLM
section labelling) + yt-dlp.
Storage: Postgres (editable state) + filesystem (audio/stems/spectrograms).
Frontend: React + Vite (Web Audio API).

> **New to the app? A full user guide ships in-app.** Click the **?** in the
> top-right of the header (it opens the guide at the section for the screen
> you're on), or click any small **?** next to a control to jump straight to that
> control's explanation. The guide is a React view
> ([`frontend/src/components/Docs.jsx`](frontend/src/components/Docs.jsx)) opened
> at `/?doc=<section>` — it walks through every screen, feature, and control.

## Pipeline

1. **Upload** — drop a file / paste a YouTube URL, optionally add lyrics; Demucs
   separates 5 stems (original / vocals / drums / bass / other).
2. **Review** — listen and edit the proposed split: drag boundaries, add/remove
   cuts, merge, relabel.
3. **Studio** — pick a segment on the left; for each stem, isolate a frequency
   band and extract a signal — choose a **feature** (energy, onset, flux,
   brightness, harmonic, chroma, beat/bar phase) and shape it (attack, release,
   gamma, threshold, gain, offset, invert) — **per segment**. Everything
   autosaves.

## Documentation

The end-user **user guide** is part of the app — a React view
([`frontend/src/components/Docs.jsx`](frontend/src/components/Docs.jsx))
explaining every screen and control (upload, segmentation, the Studio
features/shaping knobs, and the Fluid Lab). It opens in a new tab at
`/?doc=<section>`; `main.jsx` renders it instead of the app when the `doc` query
param is present. Every **?** in the UI does double duty: hover for a one-line
tooltip, click to open the guide at the matching section (`Info.jsx` takes a
`section` prop matching an id in `Docs.jsx`). Edit `Docs.jsx` to update the docs.

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
alignment downloads a Whisper model.

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

The slow stages run in the **background** (`jobs.py`): `/upload` and `/segment`
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
- `GET /audio/<job>/<stem>` (Range/seek) · `GET /spectrogram/<job>/<stem>`.

## Tests & linting

```sh
.venv/bin/python -m pip install -r requirements-dev.txt   # ruff + pytest
ruff check .                 # backend lint (bug-catching rules)
python -m pytest             # backend unit tests (signal shaping)
cd frontend && npm run lint  # eslint (react-hooks + jsx)
cd frontend && npm run test  # vitest (segments persistence contract)
```

## Storage

- **Postgres** `projects` table: editable tree (segments, labels, boundaries,
  per-segment stem edits) as JSONB + listing columns.
- **Filesystem** under `data/` (gitignored): `uploads/`, `separated/`,
  `spectrograms/` per `job_id`, plus `analysis/<job>.json` (vocal envelope +
  aligned lyrics, so resume is instant and Whisper doesn't re-run).
