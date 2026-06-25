# 08 — Styling (`styles/animation.css`)

> Dress the canvas, node cards, ports, edges, palette, and bottom bar in the Kaika
> light "blooming" theme using the existing design tokens. No new look invented —
> this is the same paper/petal/teal language as the rest of the app.

## Goal

A dedicated stylesheet that makes the animation editor feel native to Kaika:
editorial serif labels, paper surfaces, petal/teal accents, soft shadows, and
legible-on-light contrast.

## Files

- **Create** `frontend/src/styles/animation.css`
- **Modify** `frontend/src/styles/index.css` — `@import "./animation.css";`
- *(Possibly tiny additions to `studio.css` for the bottom bar if it lives in the
  studio frame.)*

## Design detail

Use the tokens from `base.css` (`--papier/--bg/--panel/--panel-2/--line/--text/
--muted/--petale/--petale-soft/--courant/--petal-grad/--shadow/--mono`). Map by
element:

- **`.anim-wrap`** — fills the studio main pane; `position: relative` (anchors the
  palette + actions overlays).
- **`.gc-root` / `.gc-stage`** — the canvas. Backdrop: a faint paper grid (subtle
  dotted/loose-grid via `background-image` of `--line` dots on `--panel-2`) so pan
  is legible without shouting. `.gc-stage` carries the `translate()/scale()`.
- **Node cards (`NodeFrame`)** — white `--panel`, `border: 1px solid --line`,
  `border-radius: 12px`, `box-shadow: var(--shadow)`. Title bar: uppercase
  letter-spaced label (serif), a hairline under it, `cursor: grab` (`:active`
  grabbing). `--accent` per node type tints the title + selected ring. Selected:
  `outline: 2px solid var(--accent)` or a petal glow (`box-shadow` bloom) consistent
  with the reskin's "bloom behind active control" motif.
- **Ports (`.gc-port`)** — small circles (~11px), `border: 2px solid var(--accent)`
  on `--panel`; hover/eligible-target enlarges + fills petal; `out` vs `in` can
  differ subtly (filled vs ringed). A connectable target during a drag pulses.
- **Edges** — SVG `stroke: var(--courant)` (teal current = flow), ~2px, slightly
  translucent; selected edge → `--petale`, thicker. The live "connecting" wire
  dashed. Keep within the existing palette (teal reads as signal flow, petal as
  selection/action — matches `fluid.css` markers retinted in the reskin).
- **Range control (wired param row)** — a compact dual-handle bar tinted petal,
  echoing `Ctl` slider styling; `lo/hi` numbers in `--mono`.
- **`.mode-bar`** (bottom bar) — full-width, `--panel` with a top hairline, two
  pill buttons; active pill uses `--petal-grad` (matches `.btn.on` from the reskin).
  Sticky at the bottom of the studio frame.
- **`.anim-actions`** — the Render button uses the primary petal-gradient button;
  `.anim-err` in a readable warning tint (reuse the `.save-warn` color treatment).
- **OutputNode video** — framed dark "well" (`fluid.css` `.fluid-stage` treatment:
  `#0c0d12` bg, inner shadow, rounded) since video is dark media — consistent with
  how the reskin frames the fluid lab as an intentional dark well on light paper.

Reuse class/value conventions already established:
- Per-card `--accent` inline tinting (as `SignalCard`/segment chips do).
- `.btn` / `.btn.on` / primary button styles from `base.css`.
- Mono for numeric readouts (`--mono`), serif for labels.

## Reuse

- All tokens + button/`.btn.on` styles — `frontend/src/styles/base.css`.
- Dark-well video framing — `frontend/src/styles/fluid.css`.
- Control row layout — `.ctl` styles (so node sliders match Studio).

## Acceptance criteria

- [ ] The editor visually belongs to Kaika: paper canvas, white cards, petal/teal
      accents, serif labels, mono numbers — no stray dark-terminal or off-palette
      colors.
- [ ] Ports/edges are clearly visible on the light canvas; selection and
      connectable-target states are obvious.
- [ ] The bottom bar's active tab matches the app's `.btn.on` petal-gradient.
- [ ] Text/handles meet the readability bar set in the reskin (WCAG AA for text).
- [ ] OutputNode video reads as an intentional dark well, not a broken panel.

## Verification (two-audience)

**Agent check:** `cd frontend && npm run build && npm run lint`. Grep the new CSS
for hardcoded hex outside the token set; prefer `var(--…)`.

**User check:** in `make dev`, open the animation tab and eyeball it against the
Studio and Fluid Lab screens — it should look like the same product. Check pan/zoom
keeps the grid legible, wires are easy to follow, and the active bottom-bar pill
blooms petal.

## Risks & open questions

- **Grid backdrop intensity** — keep very faint; a loud grid fights the editorial
  paper feel. Tune against the reskinned screens.
- **Selected-state glow vs. shadow** — match whatever the reskin settled on for
  active controls so the language stays unified.
