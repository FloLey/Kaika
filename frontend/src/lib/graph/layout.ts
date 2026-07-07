// Card layout passes for the two canvas view modes (per-view positions). Pure
// geometry over axis-aligned boxes — no DOM, no React — so the passes are unit-
// testable and shared by the mode-switch derivation (size ESTIMATES, the target
// mode isn't rendered yet) and the ✨ arrange button (MEASURED wrapper sizes).
//
// The contract that matters to the user: `resolveOverlaps` is a strict NO-OP on a
// layout that's already clean — cards only move when they'd overlap, and then as
// little as possible (pairwise separation along one axis, not a re-layout). That's
// what keeps "switch to detailed" from scrambling an arrangement someone hand-tuned.

export interface LayoutRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CardSize {
  w: number;
  h: number;
}

// Rough per-type footprints, used only when the target mode isn't rendered (a mode
// switch derives the other view's positions before its cards exist in the DOM).
// Widths come from the CSS (.anim-node 230px, .anim-node-fluid 320px, compact caps
// at 230px); heights are eyeballed medians — the ✨ arrange button re-runs the same
// pass with exact measured sizes, so a few px of error here is harmless.
const COMPACT_SIZE: CardSize = { w: 200, h: 80 };
const DETAILED_SIZES: Record<string, CardSize> = {
  fluid: { w: 320, h: 520 },
  lyrics: { w: 230, h: 380 },
  image: { w: 230, h: 320 },
  video: { w: 230, h: 340 },
  slideshow: { w: 230, h: 340 },
  imagegen: { w: 230, h: 360 },
  backdrop: { w: 230, h: 180 },
  combine: { w: 230, h: 260 },
  output: { w: 230, h: 300 },
  points: { w: 230, h: 280 },
  color: { w: 230, h: 260 },
  scope: { w: 230, h: 200 },
};
const DETAILED_DEFAULT: CardSize = { w: 230, h: 220 };

export function estimateCardSize(type: string, mode: "detailed" | "compact"): CardSize {
  if (mode === "compact" && type !== "output") return COMPACT_SIZE; // output never compacts
  return DETAILED_SIZES[type] || DETAILED_DEFAULT;
}

// Edge-to-edge overlap of two rects along one axis, in px (negative = separated by
// that many px). "Too close" means the edge distance is under `gap` on BOTH axes.
const penX = (a: LayoutRect, b: LayoutRect) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
const penY = (a: LayoutRect, b: LayoutRect) => Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);

// De-overlap by minimal displacement: for every pair closer than `gap` on both axes,
// push the two apart along the axis needing the SMALLER shift, split evenly, keeping
// their relative order (left card goes further left, etc.). Iterating pair sweeps
// converges fast for canvas-sized graphs (n is tens, not thousands). Returns a
// position for every id; inputs that never collided keep their exact coordinates.
export function resolveOverlaps(rects: LayoutRect[], gap = 16): Map<string, { x: number; y: number }> {
  const pos = rects.map((r) => ({ ...r }));
  for (let iter = 0; iter < 80; iter++) {
    let any = false;
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const a = pos[i];
        const b = pos[j];
        const px = penX(a, b) + gap;
        const py = penY(a, b) + gap;
        if (px <= 0 || py <= 0) continue;
        any = true;
        // Push along the cheaper axis; +0.5 guarantees progress on exact ties.
        if (px <= py) {
          const dir = a.x + a.w / 2 <= b.x + b.w / 2 ? 1 : -1;
          const shift = px / 2 + 0.5;
          a.x -= dir * shift;
          b.x += dir * shift;
        } else {
          const dir = a.y + a.h / 2 <= b.y + b.h / 2 ? 1 : -1;
          const shift = py / 2 + 0.5;
          a.y -= dir * shift;
          b.y += dir * shift;
        }
      }
    }
    if (!any) break;
  }
  return new Map(pos.map((r) => [r.id, { x: r.x, y: r.y }]));
}

// Pack cards closer (the compact-view ✨ arrange): scale every card's CENTER toward
// the arrangement's bbox center — relative order and rough shape survive — then
// de-overlap so nothing ends up closer than `gap`. With small compact cards the net
// effect is "same picture, much tighter".
export function tighten(
  rects: LayoutRect[],
  gap = 16,
  factor = 0.5
): Map<string, { x: number; y: number }> {
  if (rects.length < 2) return new Map(rects.map((r) => [r.id, { x: r.x, y: r.y }]));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x + r.w / 2);
    minY = Math.min(minY, r.y + r.h / 2);
    maxX = Math.max(maxX, r.x + r.w / 2);
    maxY = Math.max(maxY, r.y + r.h / 2);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const scaled = rects.map((r) => ({
    ...r,
    x: cx + (r.x + r.w / 2 - cx) * factor - r.w / 2,
    y: cy + (r.y + r.h / 2 - cy) * factor - r.h / 2,
  }));
  return resolveOverlaps(scaled, gap);
}
