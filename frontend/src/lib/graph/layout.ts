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

// The ✨ arrange gaps, per view: visibly more air than the switch-time passes'
// 16px de-overlap margin; compact stays the tight one.
export interface FlowGaps {
  x: number;
  y: number;
}
export const FLOW_GAPS: Record<"detailed" | "compact", FlowGaps> = {
  detailed: { x: 100, y: 60 },
  compact: { x: 56, y: 32 },
};

interface FlowEdge {
  source: string;
  target: string;
}

// ✨ arrange (v2): a layered flow layout — Sugiyama-lite. Columns follow the data
// flow left→right (longest-path depth over the wires; unwired cards sit in column
// 0), and the row order inside each column is chosen to reduce wire CROSSINGS:
// a few alternating barycenter sweeps (place each card at the average row of its
// wired neighbours — the classic greedy heuristic) plus a bounded adjacent-swap
// pass that keeps a swap only when the counted crossings actually drop. Greedy and
// deterministic, not optimal — per the spec, it just has to help as much as it can.
// The result is re-centred on the OLD arrangement's bbox centre so the canvas
// doesn't jump (the caller re-fits the view anyway).
export function flowLayout(
  items: LayoutRect[],
  edges: FlowEdge[],
  gaps: FlowGaps
): Map<string, { x: number; y: number }> {
  const byId = new Map(items.map((i) => [i.id, i]));
  if (items.length < 2) return new Map(items.map((r) => [r.id, { x: r.x, y: r.y }]));

  // Dedupe the wires and drop self/unknown endpoints. ALL wires count — video,
  // param and loose "__in" edges alike: each draws a line that can cross.
  const seen = new Set<string>();
  const links: [string, string][] = [];
  for (const e of edges || []) {
    if (!byId.has(e.source) || !byId.has(e.target) || e.source === e.target) continue;
    const k = `${e.source} ${e.target}`;
    if (!seen.has(k)) {
      seen.add(k);
      links.push([e.source, e.target]);
    }
  }

  // Column = longest-path depth. Relaxation capped at n passes as a cycle guard —
  // graphs are DAGs in practice; on a cycle the leftovers just keep their depth.
  const col = new Map(items.map((i) => [i.id, 0]));
  for (let pass = 0; pass < items.length; pass++) {
    let changed = false;
    for (const [s, t] of links) {
      const want = col.get(s)! + 1;
      if (col.get(t)! < want) {
        col.set(t, want);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Group ids per column; the initial row order follows the CURRENT y (keeps a
  // whiff of the user's arrangement), id as the deterministic tiebreak.
  const nCols = Math.max(0, ...col.values()) + 1;
  const cols: string[][] = Array.from({ length: nCols }, () => []);
  for (const it of items) cols[col.get(it.id)!].push(it.id);
  for (const c of cols) c.sort((a, b) => byId.get(a)!.y - byId.get(b)!.y || (a < b ? -1 : 1));

  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const [s, t] of links) {
    (preds.get(t) ?? preds.set(t, []).get(t)!).push(s);
    (succs.get(s) ?? succs.set(s, []).get(s)!).push(t);
  }
  const rowOf = () => {
    const row = new Map<string, number>();
    for (const c of cols) c.forEach((id, i) => row.set(id, i));
    return row;
  };

  // Barycenter sweeps: L→R orders each column by its predecessors' rows, R→L by
  // its successors'. A card with no wired neighbours keeps its slot.
  const sweep = (usePreds: boolean) => {
    const row = rowOf();
    for (const c of usePreds ? cols : [...cols].reverse()) {
      const scored = c.map((id) => {
        const nb = (usePreds ? preds : succs).get(id) || [];
        const bary = nb.length
          ? nb.reduce((sum, n) => sum + row.get(n)!, 0) / nb.length
          : row.get(id)!;
        return { id, bary };
      });
      scored.sort((a, b) => a.bary - b.bary || (a.id < b.id ? -1 : 1));
      c.splice(0, c.length, ...scored.map((s) => s.id));
      c.forEach((id, i) => row.set(id, i)); // later columns in this sweep see fresh rows
    }
  };
  for (let i = 0; i < 4; i++) sweep(i % 2 === 0);

  // Greedy polish: two wires between the same column pair cross iff their row
  // orders invert. Try swapping adjacent cards; keep a swap only when the global
  // count drops (links are few, the O(links²) count is cheap).
  const countCrossings = () => {
    const row = rowOf();
    let n = 0;
    for (let i = 0; i < links.length; i++) {
      for (let j = i + 1; j < links.length; j++) {
        const [s1, t1] = links[i];
        const [s2, t2] = links[j];
        if (col.get(s1) !== col.get(s2) || col.get(t1) !== col.get(t2)) continue;
        if ((row.get(s1)! - row.get(s2)!) * (row.get(t1)! - row.get(t2)!) < 0) n++;
      }
    }
    return n;
  };
  let best = countCrossings();
  for (let pass = 0; pass < 3 && best > 0; pass++) {
    let improved = false;
    for (const c of cols) {
      for (let i = 0; i + 1 < c.length; i++) {
        [c[i], c[i + 1]] = [c[i + 1], c[i]];
        const n = countCrossings();
        if (n < best) {
          best = n;
          improved = true;
        } else {
          [c[i], c[i + 1]] = [c[i + 1], c[i]];
        }
      }
    }
    if (!improved) break;
  }

  // Coordinates: columns run left→right with gaps.x between their widest cards
  // (cards centred within their column), each column's stack centred on a shared
  // horizontal axis with gaps.y between rows.
  const pos = new Map<string, { x: number; y: number }>();
  let x = 0;
  for (const c of cols) {
    if (!c.length) continue;
    const colW = Math.max(...c.map((id) => byId.get(id)!.w));
    const totalH =
      c.reduce((sum, id) => sum + byId.get(id)!.h, 0) + gaps.y * (c.length - 1);
    let y = -totalH / 2;
    for (const id of c) {
      const it = byId.get(id)!;
      pos.set(id, { x: x + (colW - it.w) / 2, y });
      y += it.h + gaps.y;
    }
    x += colW + gaps.x;
  }

  // Re-centre on the old arrangement (bbox centre over card boxes).
  const bbox = (get: (r: LayoutRect) => { x: number; y: number }) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const r of items) {
      const p = get(r);
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + r.w);
      maxY = Math.max(maxY, p.y + r.h);
    }
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  };
  const before = bbox((r) => r);
  const after = bbox((r) => pos.get(r.id)!);
  const dx = before.cx - after.cx;
  const dy = before.cy - after.cy;
  for (const [id, p] of pos) pos.set(id, { x: p.x + dx, y: p.y + dy });
  return pos;
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
