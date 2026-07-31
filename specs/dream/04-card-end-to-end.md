# 04 — The card, end to end (minimal UI)

> **Status: BUILT.** `DreamData`/`DreamPrompt`/`DreamNode`, `dreamNode` factory + the
> `dreamPrompts` coercer, `DreamNode.tsx` + registry/palette/nodeInputs/CompactPreview,
> `SOURCE_PARAM_SPEC["dream"]` + `make gen-params`, `graph_render.dream_source` +
> `_dream_block` + `_whole_from_block("dream")`, `backend/routes/dream.py`, the `/dream`
> Vite proxy entry, `routes/_node_assets.py` (lifted out of `stylize.py`), the remote
> pair (`remote_client.dream_remote` + `remote_app./dream` + a `dream` ops toggle), the
> Playground demo, and `tests/test_dream_card.py` (13). No `GRAPH_VERSION` or
> `RENDER_VERSION` bump, as planned.
>
> **Two bugs the tests caught, both worth recording.** `_cut_frames` hard-coded the
> `trigger` port when re-resolving at export fps, so Dream's `reseed` gate would have
> silently re-resolved the *trigger* on any HD export whose fps differs — it takes a
> `port` argument now. And "is `reseed` wired?" was first written as "does the port have
> a binding", which is true of every port from the moment a card is created (they all
> carry a `const` binding): it has to be `binding.kind == "node"`, or the
> fall-back-to-the-cut-schedule default could never fire.
>
> **One design change.** `VIDEO_FX` became a `Map` of type → input port name. It was a
> `Set` whose members were all assumed to take their stream on a port called `video`;
> Dream's arrives on `control`, so the assumption would have marked every Dream card
> permanently unrenderable.

**Goal:** a droppable `Dream` card that generates. Types, ports, route, job, render
handler, Playground pipeline. The prompt list is a plain stack of rows in this step; the
timeline editor is step 05.

**Prerequisites:** steps 01–03.

This step follows `DEVELOPMENT.md` *Checklist — add a node type* exactly; what follows is
only the Dream-specific content of each item.

## 1–2. Types and model

`lib/types.ts`: `"dream"` in `NodeType`, the `DreamPrompt` / `DreamData` interfaces from
the README, a `DreamNode` member of `GraphNode`. `lib/graph/factories.ts`:
`dreamNode(x, y)` seeding `prompts: [one empty prompt]`, `threshold: 0.5`,
`hysteresis: 0.1`, `seedMode: "gate"`, `seed: 1`, `ports: coercePorts("dream", undefined)`;
re-export from the `graphModel.ts` barrel.

`lib/graph/normalize.ts` needs one new coercer, `dreamPrompts`; `manualBreakpoints`
(sorted) and `numberList` already exist from the compositions wave and are reused as-is.
`fadeIn` / `fadeOut` / `span` stay **absent at their defaults**, the `MontageExtract`
convention, so an untouched prompt hashes identically.

**No `GRAPH_VERSION` bump and no migration.** A new node type adds a shape; it does not
change any persisted one, and no existing graph contains a `dream` node to migrate.
**No `RENDER_VERSION` bump** either — no existing graph's render output moves. Both are
worth stating because both are reflexes on this codebase, and an unnecessary bump costs
everyone their render cache.

## 3. Card + registry

`components/animation/nodes/DreamNode.tsx` on `NodeFrame`, registered in
`nodes/registry.ts` `NODE_TYPES` with `chrome{outFlow:"video"}`, a `factory` and a
`palette` entry. Minimal contents:

- prompt rows: text area, `fadeIn` / `fadeOut` number fields, `×span`, ✕, and **+ prompt**
- `threshold` / `hysteresis`, the montage card's two fields with the same meaning
- `seedMode` select + `seed` number
- `model` select (draft / hd), the `StylizeNode` convention (`d.model === "hd"`)
- ✨ **generate** / ↻ **regenerate** with the job progress state machine copied from
  `StylizeNode.tsx` — `stylizeClip` → `dreamClip` in `lib/api.ts`, `pollJob`,
  `useUnmountAbort`, `set({ assetUrl })` on success
- a **stale** badge (see *Staleness* below)

`components/animation/nodeInputs.ts`: the `{portId:"control", flow:"video", kind:"edge"}`
input — the `stylize` card's `control` row is the template — plus the modulatable param
inputs for `control_scale`, and the `trigger` / `reseed` gate ports.

`problemsFor`: "no control wired", "no prompts", and — unlike montage — **not** "never
cuts". A Dream card with one prompt and no trigger is completely valid: it is one prompt
over the whole window, which is the simplest useful configuration and probably how most
people will start.

## Ports (`backend/animation_params.py` `SOURCE_PARAM_SPEC`)

```python
"dream": [
    _p("control_scale", 0, 1, 0.7, label="control"),
],
```

then `make gen-params` (never hand-edit `fluidParams.js`;
`test_fluid_params_codegen.py` guards it). `trigger` and `reseed` are gate ports declared
the montage way; `threshold` / `hysteresis` stay static `data` fields.

**The per-model control-scale defaults do not carry over.** `stylize_frames` picks 0.65
for the Z-Image Union and 0.8 for SD when the caller passes none — but a *port* always
resolves to a value, so there is no "none" for Dream. 0.7 is the single default, and the
user turns the knob. Recorded because the asymmetry between the two cards will otherwise
read as an oversight.

## 4. Backend: source, route, job, handler

**`graph_render.dream_source(job_id, segment, graph, node_id, stem_audio_path, output)`** —
the twin of `stylize_source`, and like it, built on the real render `Dag` so there is no
second pipeline. It renders the `control` input (via `_video_source(graph, node_id,
"control")`, flattening a 4-channel layer onto black exactly as `stylize_source._clip`
does), resolves the `control_scale` curve through `_fx_params`, computes cut frames via
`_cut_frames` (step 03 — the schedule-fps-corrected wrapper) and reseed frames the same
way, and returns `(control, plan, fps)` with the plan from `dream_plan`. A missing control
input raises; there is no useful degenerate behaviour.

**`backend/routes/dream.py`** — `POST /dream/<job_id>`, `backend/routes/stylize.py`
copied structurally: validate, find the node, `jobs.submit(gen_job, "dreaming", …)`,
return `{job_id}`, card polls `/jobs/<id>`. The worker calls `dream_source`,
`imagegen.dream_frames`, `fluid.render_mp4` at the diffusion aspect (the `VideoClip`
re-fits to the grid at decode), `_store_asset(job_id, data, f"dream-{label}.mp4",
kind="video")`, then persists the URL server-side.

**Add `/dream` to the `frontend/vite.config.js` proxy** — hard invariant; without it the
frontend 404s on the route.

`_persist_asset_url` currently lives inside `routes/stylize.py` and hard-codes
`n.get("type") == "stylize"`. Lift it to a leaf helper (`backend/routes/_node_assets.py`)
parameterized on node type, imported by both route modules. It exists because an HD run
takes tens of minutes and a browser that closed mid-job used to orphan the finished asset;
Dream has exactly the same exposure, and duplicating the function would mean two places to
get the "read the CURRENT graph, not the job's snapshot" subtlety right.

**`_dream_block`** in `_BLOCK_HANDLERS`, whole-clip entry `_whole_from_block("dream")` in
`_VIDEO_HANDLERS` — no cross-block state, so one handler, and `test_card_impact`'s
whole == streamed assertion holds by construction. Body is `_stylize_block`'s: if
`data.assetUrl` resolves, decode it through a persistent `sources.VideoClip` registered on
`dag._closers`; otherwise pass the **control** input through unchanged, so an ungenerated
card is as cheap as `transform` and never blocks a preview or an export on the GPU. Add
`"dream"` to `VIDEO_PRODUCERS` in `backend/graph_common.py` **by hand** (the import-time
assert in `graph_render.py` fails loudly otherwise) and to `_HEAVY_TYPES`.

## Staleness

Store `assetKey` alongside `assetUrl` — the hash of everything `dream_source` feeds the
plan — and compare it on the card. On mismatch the card shows a **stale** badge.

The render handler **still decodes the stale clip**. This differs from what
`specs/ai-stylize/step-2` proposed (passthrough on stale) and is a deliberate reversal:
that spec's mitigation was written for a card whose whole input is a prompt string, where
a stale clip is simply wrong. Dream's schedule is edited constantly, an HD clip costs
tens of minutes, and silently replacing it with the raw control map in every preview and
export the moment a fade is nudged would destroy work the user can see. Showing the old
clip with a loud badge is the lesser harm. The shipped AI Stylize card behaves this way
too (`_stylize_block` decodes whenever `assetUrl` is present, with no key check at all) —
this step makes the behaviour *deliberate and visible* rather than accidental and silent.

## Remote inference

`remote_client.dream_remote` + a `/dream` route on `backend/remote_app.py`, mirroring the
`stylize` pair: npz-packed control frames plus the plan as JSON params, frames back.
`dream_frames` checks `app_settings.remote_endpoint("dream")` once its defaults are
resolved and hands the whole call over, the `stylize_frames` shape.

This is in scope, not deferred: one diffusion call per frame is the card's dominant cost,
and the rented-GPU path is the only thing that makes a full-song HD export practical. The
frame cache stays **local** — keys are computed locally from local control frames, so
lookups happen before the remote call and stores after it, and a remote run still leaves a
warm local cache.

## 5. Playground (hard invariant — never exclude a card)

`"dream": "Dream"` in `backend/card_demo.py` `CARD_LABELS`, a demo pipeline built in the
live Playground — a small video → `extract` (canny) → `dream` → `output`, two short
prompts with a fade between them, draft model, **pre-generated so `assetUrl` exists** —
then `make export-playground` to capture it (never hand-edit
`playground_pipelines.json`). `test_card_impact` renders it and fails if the card does not
contribute or the clip is black. Pre-generating is not optional: the demo's whole job is
to prove the card changes the picture, and an ungenerated Dream card passes its control
through unchanged, which is by definition no impact.

## Risks

- **Job ↔ render race.** Generation runs on `jobs.py` (one worker), renders on
  `render_jobs.py` (four). The shared `imagegen._infer_lock` protects the GPU and the
  render handler never generates, so they cannot fight — the AI Stylize argument,
  unchanged.
- **Preview cost.** Every on-screen card triggers a preview stream (2-slot cap in
  `useStreamRender.ts`). Passthrough-when-ungenerated keeps that cheap; decoding a
  generated clip is a `VideoClip` read.
- **Forgetting `VIDEO_PRODUCERS`.** The assert catches it at import, loudly. Listed anyway
  because it is the one registry that does not self-register.

## Exit gate

In the app: video → Extract (canny) → Dream → output; two prompts; wire a signal to
`trigger`; press ✨; watch per-frame progress; see the generated clip in the card preview
and in the segment render; run a **segment export** and watch it reuse the clip rather
than regenerate. Then nudge one cut, regenerate, and watch only the ramp re-diffuse
(step 02's cache, now visible end to end).

## Verification

- pytest: `_dream_block` decode-when-present / passthrough-when-absent; whole == streamed
  via `test_card_impact`; `dream_source` raises without a control input and returns a plan
  of the right length; route validation (bad job id, wrong node type, missing node); the
  job lifecycle submit → poll → `{assets:[…]}`; `_persist_asset_url` writes onto a `dream`
  node and no-ops on a deleted one; `test_graph_registry`; `test_fluid_params_codegen`
  after `make gen-params`.
- vitest: `registry.test.tsx` round-trip; `playgroundFixture.test.ts`; the card's generate
  state machine; `nodeInputs` and `paramHelp` coverage tests.
- `make lint`, `npx tsc --noEmit`.
