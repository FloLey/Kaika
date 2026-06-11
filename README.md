# Kaika 開花

Turn a piece of music into a video clip. A fluid simulation is *danced* by audio
analysis, then metamorphosed into living forms by a video diffusion model — all
driven from a local web app launched with a single command.

Specifications: [`docs/SPEC.md`](docs/SPEC.md) (v0.2, the pipeline) and
[`docs/SPEC_V2.md`](docs/SPEC_V2.md) (v2 — recipe-driven simulation, live
studio, chat copilot — implemented).

```
SON ──▶ FLUIDE ──▶ FLORAISON
   du son, un fluide ; du fluide, une fleur
```

## Quickstart

```bash
uv venv && . .venv/bin/activate
uv pip install -e ".[dev]"

pytest                                   # the whole suite (no GPU needed)
kaika run path/to/track.wav --recipe eclosion --seconds 4   # render a 4s extract
kaika serve                              # launch the local app (http://localhost:8400)
kaika                                    # bare command = serve + open browser
```

### Docker

```bash
docker build -t kaika .
docker run -p 8400:8400 -v "$(pwd)/data:/data" kaika
# or: docker compose up
```

Open <http://localhost:8400>. Runs, uploads and settings persist under
`./data` (`data/runs`, `data/.kaika`).

### GPU acceleration (optional, NVIDIA)

The solver can run its field math on CUDA via CuPy — worthwhile at high
resolutions (the CPU path is already real-time at draft sizes):

```bash
pip install cupy-cuda12x        # match your CUDA version (cupy-cuda11x for 11)
KAIKA_GPU=1 kaika serve
```

Falls back to CPU automatically (with a visible warning in the run manifest)
when CuPy/CUDA is unavailable. GPU output is deterministic per machine but not
bit-identical to the CPU path. In Docker, run with `--gpus all` and add
`cupy-cuda12x` to the image.

### What you still need to configure

Everything works out of the box **except** two optional integrations:

1. **Chat copilot (LLM)** — open **Settings (⚙ top right)**, pick a provider
   (**Anthropic Claude** or **Google Gemini**), paste the matching API key and
   optionally a model name. Keys are stored server-side
   (`data/.kaika/settings.json` in Docker, `.kaika/settings.json` locally) and
   never sent to the browser. Without a key, everything except the chat panel
   works.
2. **GPU diffusion (E4 `comfyui` backend)** — the default `diffusion.backend:
   local` renders the final clip with a GPU-free stylizer. For the real
   figurative metamorphosis, point the recipe at a running ComfyUI/Wan
   endpoint (see `src/kaika/core/diffuse/`); that needs a rented NVIDIA GPU
   and is not exercised in CI.

## The studio (v2)

Three panes: **hear it, see it, turn a knob.**

- **Live preview** — a looping window (~6 s) around the playhead, re-rendered
  at draft quality after every edit (debounced; checkpoints make previews
  anywhere on the timeline cheap). “HQ window” renders the same window at full
  resolution; “Preview full track” / “Generate” run the full pipeline.
- **Waveform + lanes** — beats, onsets and editable sections, plus signal
  lanes (RMS/flux, band split) and draggable timeline pins.
- **Schema-driven inspector** — every recipe field is reachable in generated
  forms (primary fields on the card face, the rest behind *More settings*);
  the YAML tab is the same document with total control. Any numeric field can
  be **pinned** to a per-project session-controls strip. Fields driven by a
  modulator show a `~` badge.
- **Chat copilot** — “at 2 seconds, I want 3 sources aligned horizontally in
  the center” → the assistant edits the project through validated tools,
  queues a preview, and every turn is one undoable revision.

## The recipe (v2)

A recipe **fully** describes the render — no behavior lives only in code:

| Block | What it controls |
| --- | --- |
| `canvas` | output width/height/fps + sim resolution (rectangular, FFT-friendly grids — 9:16, 16:9, 1:1, anything) |
| `analysis` | band split edges, onset detection strictness |
| `field` / `render` | solver + tone-mapping, every former hardcoded constant exposed with its old value as default |
| `palettes` | named color lists |
| `emitters` | the sources: trigger (onset low/mid/high · beat every N · continuous · lookahead · manual) × placement (fixed/random/wander/line/circle/grid/signal-driven) × direction × color (palette, cycle, chroma→hue, chroma→palette, centroid ramp…) × body physics |
| `modulators` | any audio signal (rms, flux, chroma, beat phase, band energies, …) → any numeric parameter, `absolute`/`add`/`scale` |
| `timeline` | authored directives: `spawn`/`set`/`mute`/`unmute` at seconds or musical anchors (`section:drop+4`, `beat:32`) |
| `diffusion` / `post` / `prompts` | unchanged from v1 |

v1 recipes load transparently (upgraded in memory, same behavior).
Determinism: same seed → identical video; window previews replay the exact
spawn schedule of the full run (stateless per-event RNG).

## The pipeline

Five stages in a chain, each with files on disk, each independently testable.

| Stage | Module | In → Out |
| --- | --- | --- |
| **E1** analyze   | `kaika.core.analyze`  | audio → `score.json` (frame-aligned partition: rms, bands, chroma, flux, beat/bar phase, onsets, beats, sections) |
| **E2** simulate  | `kaika.core.simulate` | score + recipe/project → `fluid/*.png`, `velocity/*.npy`, checkpoints |
| **E3** control   | `kaika.core.control`  | fluid → `control/{depth,canny,flow}/` |
| **E4** diffuse   | `kaika.core.diffuse`  | fluid + control → `styled/*.png` |
| **E5** post      | `kaika.core.post`     | styled + audio → `kaika_final.mp4` |

`runs/<id>/` holds the frozen recipe + project + score + every intermediate +
manifest (including warnings, e.g. unbound timeline anchors) + a revision log.

## Developing the frontend

The built frontend is committed under `src/kaika/webapp_dist/`. To change it:

```bash
cd webapp
npm install
npm run dev      # http://localhost:5173, proxies /api + /ws to :8400 (run `kaika serve` too)
npm run build    # re-emits into ../src/kaika/webapp_dist
```

## Layout

```
kaika/
├── recipes/                 # YAML visual identities (eclosion, encre) — v2
├── src/kaika/
│   ├── core/                # the library (UI and CLI both call this)
│   │   ├── analyze.py  simulate.py  control.py  post.py  pipeline.py
│   │   ├── recipe.py  score.py  project.py  timeline.py  schema.py
│   │   ├── chat.py          # copilot: tools + Anthropic/Gemini backends
│   │   └── diffuse/         # E4: base, local, comfy, provision, workflows/
│   ├── server/              # FastAPI app, job queue, SQLite
│   ├── webapp_dist/         # built frontend (embedded)
│   └── cli.py               # `kaika` (serve) · `kaika run …` (scripting)
├── webapp/                  # React/Vite/TS sources (three-pane studio)
├── tests/                   # pytest — engine, migration, chat, API, e2e
├── Dockerfile  docker-compose.yml
└── runs/                    # one dir per render (gitignored)
```

## Sandbox honesty

Everything in this repo runs and is tested with **no GPU** (`pytest` is green
end-to-end, including the chat tool layer via a fake provider). The figurative
flower metamorphosis requires the `comfyui` backend on a rented NVIDIA GPU;
that code path is structured and unit-tested offline but not exercised here.
Checkpoint-resumed window previews are *visually* equivalent to the full run
(identical spawns/colors/state), not bit-identical — NumPy's vectorized math
rounds 1 ULP differently across heap states and the solver is chaotic; final
renders never use checkpoints.
