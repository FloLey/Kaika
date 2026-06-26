# 02 — `useStudioPlayback` + `PathEditor` extractions

> Two oversized, interaction-heavy shells remain: `Studio` (~290 LOC: audio engine +
> transport + signal edits + tabs) and `FluidLab` (params + path editor + double-
> buffered video). The B5.1 refactor extracted `FluidNode`'s rows and lifted
> `AnimationCanvas`'s brain into `useGraphEditor`; this finishes that pattern for the
> last two. **Done while these files convert to `.tsx` in spec 01 step 4** — so the
> extracted pieces are typed from the start, not churned twice. No behaviour change.

## Locked decisions

1. **Fold into the `.tsx` conversion, not a separate pass.** `Studio`/`FluidLab` are
   rewritten in `01`-step-4; extract there. (Building this standalone would rewrite
   the same files twice.)
2. **Pure moves, behaviour-preserving.** State + effects move into a hook / a
   subcomponent that returns the identical API; the parent wires UI to it. Same
   precedent as `useGraphEditor.ts`.
3. **Reuse `useDragPad`.** `PathEditor`'s marker drag is already the `useDragPad`
   hook (`FluidLab` and `PointsNode` both use it) — no new pointer math.

## Architecture this builds on

- `useGraphEditor.ts` is the precedent: a `.ts` hook holding state + memoized
  handlers, returning a bundle the view spreads; the stale-closure-safe `graphRef`
  pattern lives there.
- `lib/useDragPad.ts`: `{ norm, startDrag }` — the normalized-pointer + window
  pointermove/up plumbing `FluidLab`'s path editor uses today.
- `FluidLab` already double-buffers two `<video>` elements and debounces `runFluid`;
  the path overlay (`.fluid-overlay`, `.fluid-marker`, the SVG polyline/polygon) is a
  self-contained block over the stage.
- `Studio` owns `refAudio` (the shared segment clock other components slave to),
  per-stem `<audio>` elements, `playAll`/`seek`/`handleSolo`, `clockT`,
  `allPlaying`, loop + volume, plus segment/signal/graph edits and the tab bar.

---

## Step 1 — `useStudioPlayback` (from `Studio`)

**Goal.** Lift the audio engine + transport into a typed hook; `Studio` keeps segment/
signal/graph orchestration + the tab UI.

**Files.** New `components/studio/useStudioPlayback.ts`; `Studio.tsx` (slimmed,
from `01`-step-4).

**Design.**
- `useStudioPlayback({ stems, activeSeg, loop, volume }) -> { refAudio, audioEls,
  playAll, pause, seek, handleSolo, clockT, allPlaying }`. Move the per-stem `<audio>`
  refs/registry, the play/pause/seek/solo logic, the shared-clock `refAudio`, and the
  `clockT`/`allPlaying` state + their effects into it.
- `Studio` calls the hook and passes `refAudio`/`clockT`/`allPlaying` down to
  `SegmentRail`, `PulsePad`, and `AnimationCanvas` (as `groupClock`/`groupPlaying`)
  exactly as today. The `<audio>` elements render where `Studio` chooses (the hook
  exposes the refs; the JSX stays in `Studio`, or the hook returns the element array).
- Type the audio refs as `RefObject<HTMLAudioElement>`; events with DOM media types.

**Reuse.** `useGraphEditor.ts` pattern (memoized handlers, refs). The existing
`refAudio` wiring contract to `OutputNode`/`PulsePad` (`ctx.groupClock`).

**Acceptance.** Playback identical: play/pause, scrub, per-stem solo/mute, loop, the
shared clock driving Output videos + pulse pads. `Studio` materially shorter.

**Verification (two-audience).**
- *Agent:* `tsc` + build green; a jsdom test mounting `Studio` (or the hook via
  `renderHook`) asserting play→`allPlaying` flips and `seek` moves `refAudio`.
- *User:* `make dev` → studio: play a segment, scrub, solo a stem, toggle loop; the
  Output video + signal pulse pads stay in lock-step with the audio.

**Risks.** The shared `refAudio` is read by other components via `ctx.groupClock` —
keep its identity/shape. Browser autoplay/visibility quirks already handled in
`OutputNode`/`FluidLab`; don't regress the resume logic.

---

## Step 2 — `PathEditor` (from `FluidLab`)

**Goal.** Extract the path overlay + markers into a reusable typed subcomponent;
`FluidLab` keeps params + the video stage.

**Files.** New `components/fluid/PathEditor.tsx`; `FluidLab.tsx` (slimmed).

**Design.**
- `PathEditor({ points, pathClosed, onAdd, onMove, onToggleClose, onRemove })` renders
  the `.fluid-overlay` stage + the SVG polyline/polygon + the `.fluid-marker`s, using
  `useDragPad(stageRef)` for add/drag and the first-point click-to-close behaviour
  (currently inline in `FluidLab`). Props are the path state + callbacks; `FluidLab`
  owns the `points` state (`setP`) and passes handlers.
- `FluidLab` renders `<PathEditor … />` inside the stage overlay; the double-buffered
  video + param controls are untouched.

**Reuse.** `lib/useDragPad.ts` (the exact drag the editor already uses); the
`.fluid-overlay`/`.fluid-marker` styles.

**Acceptance.** The FluidLab path editor behaves identically (add on stage click,
drag markers, right-click/remove, click first point to close the loop); `FluidLab`
shorter.

**Verification (two-audience).**
- *Agent:* `tsc` + build green; a jsdom test of `PathEditor` (add a point → `onAdd`;
  drag a marker → `onMove`).
- *User:* `make dev` → FluidLab: scatter points, drag them, close the loop, remove a
  point — the sim updates as before.

**Risks.** Keep the close-loop-on-first-point-click logic (needs ≥3 points); keep
markers `.no-drag` so dragging a marker doesn't pan the card. Coords normalize via
`useDragPad`'s `norm`.

---

## v1 boundary & extension points

**This spec:** `Studio`/`FluidLab` are split into a playback hook + a path-editor
component, both typed. **Deferred (designed-for):** `PathEditor` is now reusable —
the animation `PointsNode` card could adopt it for a richer editor; `useStudioPlayback`
isolates the transport so a future multi-segment / scrub-preview feature has one place
to grow. Keeping both as pure behaviour-preserving moves makes those cheap later.
