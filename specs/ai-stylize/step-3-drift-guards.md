# Step 3 — Drift guards + audio-reactive generation

**Goal:** make long clips hold together (fight the closed-loop drift the brief §11 describes) and
deliver the feature no off-the-shelf tool has — **diffusion parameters driven by the song's
signals**. Most of the mechanism already exists after Step 2; this step promotes it to real card
options and proves the audio-reactive path end-to-end.

## Prerequisites

Step 2 shipped (the card generates and caches clips).

## A. Drift guards (brief §11)

A loop feeding on its own output saturates colors and collapses into an attractor pattern. Add
these as `stylize_clip` behaviors, exposed as card controls:

1. **LAB color match to the anchor** (the brief's `match_colors_lab`, the most effective remedy).
   Every N generated keyframes, recolor the output to the frame-0 anchor's LAB statistics. Card
   control: `anchorEvery` (frames, default 10; 0 = off). Cheap OpenCV, already prototyped in Step 0.
2. **Periodic re-anchor.** Every X frames, run one higher-denoise generation to reset the style
   before it decays. Card control: `reanchorEvery` (default off). Uses the same pipe, higher
   strength for that single frame.
3. **Noise injection.** Add a little noise to the warped start frame to reopen model freedom — the
   `noiseInject` port already added in Step 2; wire it into the loop here (add ×`noiseInject`
   Gaussian to `warped` before img2img).
4. **Fixed-noise-per-segment** (from Step 0 findings) — keep it on by default; it both reduces
   flicker and bounds drift.

Keep defaults conservative so a fresh card "just works"; these are power-user dials with "?" help.

## B. Audio-reactive parameters (the differentiator)

The ports `denoise`, `controlStrength`, `noiseInject` are already modulatable (Step 2 registered
them in `SOURCE_PARAM_SPEC`, so `connect`/`resolve_port` handle binding a signal for free). This
step makes the loop actually *consume* the per-frame curves rather than a scalar:

- In the `/stylize` route, resolve each modulatable port to a **length-nframes curve** (the
  `Dag._fx_params` / `graph_common.resolve_port` machinery already does this for render; reuse the
  same resolver so the values match what the graph shows).
- `stylize_clip` samples the curve **at each generated keyframe** (not every output frame — only
  keyframes are generated). So `denoise[t]` varies per keyframe: calm passages → low denoise
  (stable texture), onsets/drops → high denoise (re-invention bursts). This is the brief's
  "strength_schedule" (§10), driven by Kaika's segment signals instead of a hand-authored curve.
- **Cache-key consequence:** the content-addressed clip key (Step 2) already includes the
  `denoise_curve`; a bound signal changing the curve changes the key, so the clip correctly
  re-generates. Verify this: binding an onset signal must produce a *new* `clipKey`.

## Optional stretch: prompt A→B crossfade

Interpolate between two prompt embeddings across the segment (encode both, lerp
`prompt_embeds` per keyframe). Bigger change (touches the pipe call to accept `prompt_embeds`);
mark as stretch — land the numeric ports first.

## Risks

- **Over-reactive denoise** looks like strobing on loud sections — clamp the port's upper bound
  (0.7) and document the trade-off in `paramHelp`.
- **Curve vs keyframe sampling mismatch** — if you sample the curve at output fps but only
  generate at keyframe fps, the "reactivity" won't align to the beat. Sample at keyframe times and
  document it.
- **Re-anchor visible pop** — a single high-denoise frame can flash. Blend it in (LAB-match the
  re-anchored frame back toward its neighbors) or keep `reanchorEvery` off by default.

## Exit gate

Bind an onset/energy signal to `denoise` on a real segment, Generate, and confirm: (a) the
`clipKey` changed (re-generated, not served stale), and (b) the output visibly reacts — stable in
quiet passages, re-inventing on hits. LAB-match on a 30-s clip visibly holds the palette vs off.

## Verification

- pytest: `resolve_port` produces the expected per-keyframe denoise curve for a bound signal; the
  stylized-clip key changes when the bound signal changes; LAB-match is deterministic.
- Manual/`/verify`: the onset→denoise reaction; LAB on/off palette-hold comparison.
- `make test`, `make lint`, `tsc --noEmit`.
