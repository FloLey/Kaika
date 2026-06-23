# Demucs Studio

Local web app to split a song into musical **segments** (intro / verse / chorus
…) and rework each one independently. Upload audio (or a YouTube URL) + optional
lyrics → it separates stems with [Demucs](https://github.com/adefossez/demucs)
(Apple-Silicon GPU via MPS), proposes a segmentation from the lyrics + vocal
activity, and opens a studio where each segment has its own per-stem
frequency-isolation edits. Work is saved to Postgres so you can **resume** later.

Backend: Flask + librosa + demucs + Whisper (mlx/faster-whisper) + yt-dlp.
Storage: Postgres (editable state) + filesystem (audio/stems/spectrograms).
Frontend: React + Vite (Web Audio API).

## Pipeline

1. **Upload** — drop a file / paste a YouTube URL, optionally add lyrics.
2. **Review** — listen and edit the proposed split: drag boundaries, add/remove
   cuts, merge, relabel.
3. **Studio** — pick a segment on the left; isolate frequency bands, mute,
   duplicate stems — **per segment**. Everything autosaves.

## Setup

Requires Python 3.12 (demucs/torch lack newer wheels), Node 18+, `ffmpeg` on
PATH, and Docker/OrbStack (for Postgres).

```sh
cd demucs_studio
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

- `POST /upload` — audio file **or** `youtube_url`, + optional lyrics → runs
  demucs, renders per-stem mel-spectrogram PNGs, creates a project. Returns
  `job_id`, `duration`, `title`, `stems` (audio/spectrogram URLs + `sr`).
- `POST /segment` — `{job_id}` → proposes segments (Whisper lyric alignment +
  vocal activity + timbre clustering); caches analysis; returns segments +
  vocal envelope.
- `GET /projects` · `GET|PUT|DELETE /projects/<job_id>` — list / load / autosave
  / delete a project (segments + per-segment isolation edits live in Postgres).
- `GET /audio/<job>/<stem>` (Range/seek) · `GET /spectrogram/<job>/<stem>`.

## Storage

- **Postgres** `projects` table: editable tree (segments, labels, boundaries,
  per-segment stem edits) as JSONB + listing columns.
- **Filesystem** under `data/` (gitignored): `uploads/`, `separated/`,
  `spectrograms/` per `job_id`, plus `analysis/<job>.json` (vocal envelope +
  aligned lyrics, so resume is instant and Whisper doesn't re-run).
