# 05 — The prompt timeline editor

> **Status: BUILT.** `patchScheduled` + the four breakpoint mutations on a neutral
> `nodeId`, `BreakpointTimeline` generalized (`PART_COLORS`/`partColor`/`useLivePart`,
> and the upper lane + legend as SLOTS), `useDreamSchedule.ts`, the band/ramp/handle UI in
> `DreamNode.tsx`, `styles/animation/11-dream.css`, and
> `frontend/src/__tests__/dreamTimeline.dom.test.tsx` (7). The montage suites pass with
> no change to their expectations — only the renames.
>
> **The lane became a slot, not a prop shape.** The plan said "lift it to props"; in
> practice the montage's coverage bands and Dream's prompt parts share nothing but their
> geometry, so a common prop shape would have been a union pretending to be an
> abstraction. `BreakpointTimeline` now takes `lane` and `legend` as `ReactNode`, keeps
> the rail/marks/drag/playhead, and each card renders its own upper lane — which also
> preserves the reason the lane exists at all: click-to-select and click-to-place-a-cut
> live in separate lanes so the two gestures cannot collide.
>
> **Fade handles drag in the direction the fade extends** — a fade-out grows leftwards
> (back into the part before the cut), a fade-in rightwards. Dragging the wrong way
> shrinks it, and a zero fade is stored ABSENT, so an untouched prompt keeps its exact
> shape. The DOM test pins both directions and the shrink-to-absent case.

**Goal:** the card's real editing surface — a timeline where a signal splits the window
into coloured parts, you add and remove splits by clicking, and each part carries its
prompt. Step 04's stack of rows is replaced.

**Prerequisites:** step 04.

## Generalizing the montage's editor

Three things are montage-shaped only by name, and Dream needs all three.

**The mutations.** `addManualBreakpoint` / `moveManualBreakpoint` /
`removeManualBreakpoint` / `toggleAutoCut` all route through
`patchMontage(graph, id, fn)`, whose only montage-specific act is the
`n.type === "montage"` guard (`mutations.ts:156`). Introduce a `ScheduledData` interface —
`manualBreakpoints`, `disabledCuts`, `threshold`, `hysteresis` — that both `MontageData`
and `DreamData` extend, and a `patchScheduled` typed on it that accepts either node type.
The four mutations then serve both cards unchanged, including the subtleties that took a
version to get right: adding a manual breakpoint clears a stale disable at the same time,
disabling a gate cut sweeps same-frame manuals so a click cannot resurrect the cut it just
silenced, and every match is by half-a-frame tolerance so a toggle round-trips through
float noise.

**The colours and the playhead.** `EXTRACT_COLORS` / `extractColor` / `useLiveExtract` in
`BreakpointTimeline.tsx` become `PART_COLORS` / `partColor` / `useLivePart`. `useLivePart`
already takes `(clock, starts, total, fps, segStart)` and knows nothing about extracts —
only its name does. It commits state only when the part *index* changes, which is what
keeps a per-frame rAF loop down to a handful of re-renders; keep that.

**The timeline component.** `BreakpointTimeline` currently reaches into montage data
directly. Lift it to props: `cuts`, `starts`, `partCount`, the four mutation callbacks,
and a render prop for what a part's band shows. Montage passes its extract name; Dream
passes the prompt's first words.

The binding↔edge invariant is untouched throughout — none of these mutations touch edges,
because breakpoints and prompts are pure data (the montage comment at `mutations.ts:152`
says exactly this, and it still holds).

## What Dream adds

- **Fade ramps drawn on the timeline.** Each transition's `[c − o, c + i]` span renders as
  a gradient between the two parts' colours, so the schedule *looks* like what the render
  does. The band edges are drag handles: dragging the left edge sets the outgoing prompt's
  `fadeOut`, the right edge the incoming prompt's `fadeIn`.
- **The clamp must be visible.** A 5-second fade on a 1-second part is silently scaled
  down by `dream_plan`; if the timeline drew the requested value the user would be looking
  at a lie. Draw the *clamped* ramp, and mark a clamped part so it is clear the number in
  the field is not the number in effect.
- **Prompt cards under the timeline**, in part order, colour-matched to their band.
  Clicking a band focuses its prompt; the live part highlights during playback.
- **Hold-last and surplus.** More cuts than prompts means the last prompt holds to the
  window end — draw it holding. More prompts than cuts means the surplus never plays —
  badge them, do not delete them (a user mid-edit with a trigger not yet wired has every
  prompt in surplus, and eating their typing would be unforgivable).

## Gesture conflicts

Cut drag, fade-edge drag and part selection now share one strip. Resolve by zone rather
than by modifier: cut markers own a few pixels around themselves, fade edges own the ramp
boundary, the rest of a band selects. Modifier-keyed gestures are undiscoverable and this
card's whole pitch is that you can see what you are doing.

## Deliberately not done

- **No per-part preview thumbnails.** Showing what each prompt actually generates would
  mean a diffusion call per part on every edit. The card has a full clip preview already;
  that is the honest place to look.
- **No drag-to-reorder prompts.** Order *is* the schedule; add, remove and edit cover it.
  Reordering is a rename of every part's text, which is what selecting and typing does.
- **No fade curve editor.** `w` ramps linearly (step 03) and the reason stands here: the
  ramp drives an embedding lerp whose perceptual behaviour is itself unmeasured.

## Risks

- **Generalizing a shipped component.** Montage is built and in use; every change here can
  break it. The montage dom suites and `montageCuts`/`cutSchedule` tests must stay green
  with no edits to their *expectations* — if a montage test needs changing, the
  generalization went wrong.
- **Timeline ↔ render drift**, again. The timeline draws from `dreamPlan`; the render
  generates from `dream_plan`; the shared fixture from step 03 is what holds them
  together. Nothing here should recompute a schedule by hand.

## Exit gate

Build a Dream card with four prompts against a wired trigger. Click to add a split, click
a gate cut to disable it, drag a fade edge, watch the ramps redraw. Regenerate and confirm
the render matches the timeline frame for frame at every boundary — including one part
short enough to trigger the clamp.

## Verification

- vitest: the generalized timeline against both card types; fade-edge drag writes
  `fadeIn`/`fadeOut` on the right prompt; clamped parts render clamped; surplus and
  hold-last states; `patchScheduled` refuses a node of a third type; the montage suites
  pass unmodified.
- pytest: unchanged from step 03 — this step adds no backend surface.
- `make lint`, `npx tsc --noEmit`.
