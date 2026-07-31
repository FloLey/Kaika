# Dream — control-driven generation on a prompt schedule

> **Status: BUILT.** All six steps shipped, each ending green (pytest + vitest + lint +
> `tsc --noEmit`). Every step file carries its own status header recording what landed
> differently from the plan below and why — read those, not the forward-looking prose
> that follows them.
>
> **Amended after the fact (2026-07-31): the export regenerates Dream cards itself.** The
> six steps left generation entirely on the card's ✨ button, and the export just decoded
> whatever `assetUrl` the node carried. That was wrong in a way the plan never considered:
> the composition POOL gives each composition its own copy of a node, so a nine-composition
> song needed nine separate ✨ clicks before an export contained Dream imagery at all — and
> the eight that were missed shipped as raw control map, silently, because an ungenerated
> card passes its control through. `routes/export._regenerate_hd_dream` now generates every
> `dream` node from the graph, at the master's grid, keeping the card's model (decision 5b
> is exactly why it must not force Z-Image the way `_regenerate_hd_stylize` does).
>
> Two things worth knowing before reading further. **The fade needed a shape control**
> that this plan did not anticipate: step 01 measured the two models interpolating very
> differently, and the decision is recorded in step 01 and in decision 5b. And **the
> timeline's upper lane became a slot, not a shared prop shape** (step 05) — the montage's
> coverage bands and Dream's prompt parts have nothing in common but their geometry.

A new video card. You wire a **control** track into it (an Extract card's canny / soft /
depth output, or a video that already *is* a control map), a **trigger** signal splits the
window into parts the way the montage card's cut schedule does, and you write **one prompt
per part**. Every frame is then generated from scratch — pure txt2img + ControlNet, no
img2img, no anchor to any source pixels — following that frame's control image and the
prompt active at that frame. The output is a clip of continuously reinvented imagery that
traces the control's shapes and motion.

The distinction from the shipped **AI Stylize** card (`specs/ai-stylize/step-2`) is the
whole point, so state it plainly:

| | AI Stylize | Dream |
|---|---|---|
| Anchor | img2img from the upstream clip — even the Z-Image ControlNet path hand-rolls noised latents from the input, because a `ZImageControlNetPipeline` is txt2img-only | none; control is the only conditioning |
| Control | optional `control` edge | required, and the primary input |
| Prompt | one static string in `data.prompt` | one per part of a cut schedule, with per-prompt crossfades |
| Seed | one fixed seed for every frame, deliberately, for coherence | selectable: fixed / per-frame / gated |
| Regeneration | whole clip, every time | per-frame cache; nudging a cut re-diffuses only the frames whose prompt state changed |

## Decisions (locked with the user, 2026-07-29)

1. **Pure txt2img + control.** No img2img, no `strength` port — there is nothing to
   anchor to. The fluid's black background will *not* stay black; that is intended.
2. **Prompts come from the user, one per part** — not captioned, not LLM-generated. An
   earlier reading of the brief had a vision model writing prompts from the control map;
   that was wrong and is recorded here only so nobody re-proposes it. (It would also not
   have worked: captioners are trained on photographs and produce mush on line art.)
3. **The schedule is the montage's cut schedule, reused verbatim** — gate rises through
   the card's own hysteresis threshold, unioned with manual breakpoints, minus disabled
   cuts. Same data fields, same helpers, same composition-local seconds, same
   schedule-fps correction (`_montage_cut_frames`, renamed `_cut_frames` when it
   became shared). Parts are added and removed by clicking
   a timeline, exactly like montage breakpoints.
4. **Both entry and exit fades, per prompt.** Not one knob — see *The fade rule* below.
5. **Crossfade by embedding lerp**, not by blending two generated images. One diffusion
   call per frame; a true semantic morph rather than a dissolve.
5b. **A `fadeShape` control, default 1 (linear)** — added after step 01 measured the two
   models interpolating very differently. SD-Turbo morphs evenly across the whole sweep;
   Z-Image packs essentially all its change into `w ∈ [0.42, 0.62]`, so a linear HD fade
   reads as a soft cut. Shape > 1 flattens the ramp around the midpoint. A control, not a
   per-model constant: the band was measured on one prompt pair (see step 01).
6. **Seed is a mode, not a constant**: `fixed` / `frame` / `gate`, the last driven by an
   optional `reseed` port that falls back to the cut schedule when unwired.
7. **Per-frame incremental cache**, not whole-clip regeneration. Editing prompt 3 must not
   re-diffuse prompts 1, 2 and 4 — otherwise the timeline editor is unusable at one
   diffusion call per frame.
8. **`control_scale` is a modulatable port**, not a constant. Loosening control adherence
   on a beat and snapping it back is the good audio-reactive knob on this card.
9. Card name: **Dream**.

## Target data model

```ts
// One part of the schedule: the prompt that covers the k-th interval, and how it
// enters and leaves. `span` swallows N cuts (absent = 1). Fades in SECONDS, absent
// at 0 so untouched prompts hash identically — the MontageExtract convention.
interface DreamPrompt {
  id: string;
  text: string;
  fadeIn?: number;
  fadeOut?: number;
  span?: number;
}
interface DreamData {
  prompts: DreamPrompt[];
  manualBreakpoints: ManualBreakpoint[];  // reused type, composition-LOCAL seconds
  disabledCuts: number[];                 // reused semantics, local seconds
  threshold: number;
  hysteresis: number;
  seedMode: "fixed" | "frame" | "gate";
  seed: number;
  fadeShape?: number;                     // added in step 01 — see decision 5b
  model?: string;                         // "draft" | "hd", the StylizeNode convention
  assetUrl?: string;                      // the generated clip
  assetKey?: string;                      // what it was generated FOR (the stale badge)
  ports: { control_scale, trigger, reseed };
}
```

Everything that is *not* a prompt is lifted straight from `MontageData`. That is
deliberate: the two cards must agree about what a cut schedule is, and the cheapest way
to guarantee it is to share the code rather than the intent.

## The fade rule

Each prompt carries `fadeOut` (how it leaves) and `fadeIn` (how it arrives). For the cut
`c` between part *k* and part *k+1*, with `o = fadeOut(k)` and `i = fadeIn(k+1)`:

```
transition spans [c − o, c + i]
w(t) = 0                        t ≤ c − o
     = (t − (c − o)) / (o + i)  inside
     = 1                        t ≥ c + i
o + i == 0  →  hard cut: w = 0 before c, 1 at and after c
```

At the cut frame itself you are `o / (o + i)` of the way across. One rule gives every
case: both zero is a hard cut, in-only is a lead-in, out-only is a trailing fade, equal
is a symmetric dissolve, unequal weights the dissolve to whichever side you want.

**The clamp.** A part of duration `D` has its `fadeIn + fadeOut` capped at `D`, both
scaled down proportionally when they overflow. This is not arbitrary tidiness — it is
exactly the condition under which two adjacent transitions cannot overlap. Transition
*k−1*→*k* ends at `c_k + i_k`; transition *k*→*k+1* begins at `c_k + D_k − o_k`; they stay
disjoint iff `i_k + o_k ≤ D_k`. So the clamp is what guarantees **at most two prompts ever
blend at once**, which is what keeps both the embedding lerp and the cache key binary.

## Generation design

Generation is **never** run inside a render request — the AI Stylize rule, for the same
reason: a handler taking seconds per frame would freeze the render pool and every live
preview. An explicit ✨ button → a `jobs.py` job on the single GPU worker → a
content-addressed mp4 in `data/assets/` → a render handler that only *decodes* it, and
passes the control through unchanged when nothing has been generated yet.

`backend/routes/stylize.py` is the template end to end: `POST /dream/<job_id>`,
`jobs.submit`, per-frame progress via `jobs.set_step`, `_store_asset(..., kind="video")`,
and the server-side write-back so a reload mid-job cannot orphan a finished clip (that
helper was lifted out to `routes/_node_assets.py` and now serves both cards). `graph_render.stylize_source` is the template for pulling the upstream
clip out of the real render DAG rather than building a second pipeline.

There is **no negative prompt** anywhere in this card: both Turbo models run at
`guidance_scale=0`, where every one of these pipelines skips the CFG branch entirely,
so a negative prompt is inert (step 01).

Two model paths, the AI Stylize split:

- **HD (Z-Image-Turbo).** `ZImageControlNetPipeline` is *natively* txt2img + control.
  `imagegen.stylize_frames` currently goes out of its way to bolt an img2img anchor onto
  it (seeded latents, truncated sigma schedule); Dream simply does not, which makes this
  the *simpler* path of the two.
- **Draft (SD-Turbo).** Needs `StableDiffusionControlNetPipeline` added to
  `_load_stylize_pipe`, which today builds only the img2img and inpaint variants.

## Cache design

`backend/dream_cache.py`, mirroring `fluid_cache.py`'s shape (`load` / `store` / budget
env vars / `render_cache.evict` for the age-and-size sweep) but keyed **per frame**:

```
sha1(control_frame_hash, prompt_a, prompt_b, w_q, seed, model, H, W, scale_q)
```

- `w_q` and `scale_q` are rounded to 3 decimals so float noise cannot bust a key.
- **Hold frames canonicalize.** At `w == 0` the key drops `prompt_b` entirely; at `w == 1`
  it drops `prompt_a`. This is the property that makes the cache worth building: nudging a
  cut changes the weights of that transition's ramp frames only, so every hold frame in
  both neighbouring parts survives untouched. Without canonicalization each hold frame
  would key against its neighbour's prompt and a cut nudge would invalidate whole parts.
- The control frames are already in hand once the upstream clip renders, so hashing them
  costs nothing and buys robustness: an upstream edit that leaves a given frame unchanged
  keeps that frame's cache.
- A still control gives identical keys across time and dedupes for free.
- Stored as PNG, not `.npy`: lossless (so a cache hit is byte-identical to a miss, which
  is what makes the parity test meaningful) at roughly a third of the raw size.

## Open question the prototype must answer

**Does Z-Image's text encoder lerp cleanly?** `_encode_prompt` returns *ragged*
embeddings — it encodes padded to `max_length`, then trims each prompt to its true token
count (`prompt_embeds[i][prompt_masks[i]]`), so two prompts of different lengths come back
as different-shaped tensors. Step 01 works around this by encoding both prompts itself,
lerping the padded `hidden_states[-2]`, and trimming by the union of the two masks. But
the encoder looks *causal* (attention-masked, second-to-last hidden state), and
position-wise lerping between two different sentences is less principled on a causal
encoder than on SD's bidirectional CLIP. It will produce a morph; whether the midpoint is
a coherent image or mud is empirical. If it is mud, the thing that suffers is the fade
knob, not the card — every other part of this plan stands.

## Steps

| Step | What | Key surface |
|---|---|---|
| [`01`](01-inference-core.md) ✅ | Pure txt2img + control, and the embedding lerp | `imagegen.dream_frames` / `_dream_embeds` / `_stylize_pipe_key`, `scripts/dream_lerp_probe.py` |
| [`02`](02-frame-cache.md) ✅ | The per-frame generation cache | `backend/dream_cache.py`, `paths.DREAM_CACHE_DIR`, `render_cache.evict` reuse |
| [`03`](03-prompt-schedule.md) ✅ | The schedule → per-frame plan, both sides | `backend/cut_schedule.py`, `lib/cutSchedule.ts` (renamed from `montageCuts.ts`), the shared fixture |
| [`04`](04-card-end-to-end.md) ✅ | The card: types, ports, route, job, render handler, remote, Playground | `DreamData`, `/dream`, `dream_source`, `_dream_block`, `CARD_LABELS` |
| [`05`](05-prompt-timeline.md) ✅ | The prompt timeline editor | generalized `BreakpointTimeline` + `patchScheduled`, `useDreamSchedule`, fade handles |
| [`06`](06-docs-polish.md) ✅ | Docs & polish sweep | ARCHITECTURE, README, DEVELOPMENT, CLAUDE, guide, paramHelp |

**Tests added:** `test_dream.py` (17), `test_dream_cache.py` (20), `test_cut_schedule.py`
(31), `test_dream_card.py` (13) on the backend; `cutSchedule.test.ts` (28) and
`dreamTimeline.dom.test.tsx` (7) on the frontend, plus the shared fixture both schedule
suites read. No `GRAPH_VERSION` or `RENDER_VERSION` bump was needed — a new node type
changes no existing persisted shape and no existing graph's render output.

Steps 01–03 are backend-only and land green without the card existing. The card cannot be
*registered* before step 04, because the hard invariant "every card needs a Playground
pipeline" needs a card that can generate something for `test_card_impact` to see.

Cleanup mandate, inherited from the compositions wave: delete aggressively in the same
commit that makes code dead — no compat layers, no just-in-case code. Each step file
records what it removed, and what it deliberately did **not** do.
