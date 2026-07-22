# 06 — The breakpoints timeline

`BreakpointTimeline.tsx`, mounted in the montage editor between the strip and the
live view: one strip over the composition's window where BOTH cut sources stay
visible with their provenance.

- **Gate cuts** (cyan): recomputed live from the wired trigger. Clicking one
  stores/clears a `disabledCuts` exception at that time (the mutation takes the
  same half-frame tolerance the render matches with — one definition, so a
  toggle round-trips through float noise and a cut that MOVES under a threshold
  edit re-enables itself). Disabled, the mark stays visible — greyed, dashed —
  because provenance must never disappear; it just no longer cuts.
- **Manual cuts** (amber): click empty rail to place one at that time; drag to
  move (live-follow without a graph commit per pointermove; committed on
  pointer-up); a click without movement deletes.
- The marks come from `useMontageShortfall`'s schedule (`cuts.marks`, i.e.
  `lib/montageCuts.cutMarks` — the mirror of backend `_effective_cuts`), so the
  strip's extract boundaries above redraw live off the same numbers the render
  will use.
- Help: `ARG_HELP.montage.breakpoints` + the legend's "?" (anchor tests green).

Tests (`breakpointTimeline.dom.test.tsx`): gate toggle round-trip (exception at
the cut's time, mark stays visible greyed, schedule drops to 0×, second click
re-enables); manual place → delete via the no-move gesture (native pointer
events — jsdom drops clientX on synthetic ones, the canvas drag test's
workaround).
