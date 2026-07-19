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
  // preview + summary + slot rows + two statics + two param rows
  montage: { w: 230, h: 320 },
  // combine's body plus a mode select, a hint, two statics and four param rows
  transform: { w: 230, h: 300 },
  // preview + mode select + hint + two param rows
  echo: { w: 230, h: 290 },
  // preview + mode select + hint + tint row + mode statics + two param rows
  colorgrade: { w: 230, h: 330 },
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

// Reading order over a set of cards: columns left→right, then top→bottom inside each
// column. A card joins the current column while its left edge stays within half a card
// width of the PREVIOUS card's — chaining, so a hand-dragged stack tolerates drift
// across its whole height and still reads as one column. A real grid can't chain shut:
// its columns sit a card width plus FLOW_GAPS.x apart, far past the tolerance. Ids
// break exact ties, so the order is deterministic (two cards at the same spot must not
// swap between runs).
//
// Used by ✨ arrange to give a montage's slots the order you SEE (useGraphEditor).
export function readingOrder(items: LayoutRect[]): string[] {
  const byX = [...items].sort((a, b) => a.x - b.x || a.y - b.y || (a.id < b.id ? -1 : 1));
  const columns: LayoutRect[][] = [];
  let colX = -Infinity;
  for (const it of byX) {
    if (columns.length && it.x - colX <= it.w / 2) columns[columns.length - 1].push(it);
    else columns.push([it]);
    colX = it.x; // chain from the previous card, not the column's first
  }
  return columns.flatMap((c) =>
    [...c].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1)).map((r) => r.id)
  );
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
export function resolveOverlaps(
  rects: LayoutRect[],
  gap = 16
): Map<string, { x: number; y: number }> {
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

// ✨ arrange (v3): a layered flow layout — the standard Sugiyama recipe, greedy and
// deterministic. Columns follow the data flow left→right (longest-path depth over
// the wires; unwired cards sit in column 0). A wire spanning several columns is
// split through zero-size DUMMY nodes (one per intermediate column) so it occupies
// a slot everywhere it passes — real cards get ordered around it and every crossing
// becomes an adjacent-column inversion the counter actually sees. Row orders come
// from alternating barycenter sweeps (keeping the best-scoring ordering seen) plus
// a bounded adjacent-swap pass that only keeps swaps that drop the true crossing
// count. Y coordinates are then relaxed toward each card's wired neighbours (order
// and gaps preserved) so connected cards line up and wires run flat instead of
// slanting across each other. Re-centred on the OLD arrangement's bbox centre so
// the canvas doesn't jump (the caller re-fits the view anyway).
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

  // Split long wires through dummy nodes: `a --(span 3)--> d` becomes the chain
  // a→~1→~2→d with a zero-size dummy in each intermediate column, seeded on the
  // straight line between its endpoints (a sane initial row). After this EVERY
  // segment spans exactly one column.
  const meta = new Map<string, { w: number; h: number; y: number }>();
  for (const it of items) meta.set(it.id, { w: it.w, h: it.h, y: it.y });
  const segs: [string, string][] = [];
  for (const [s, t] of links) {
    const cs = col.get(s)!;
    const ct = col.get(t)!;
    if (ct - cs <= 1) {
      segs.push([s, t]);
      continue;
    }
    const sy = byId.get(s)!.y + byId.get(s)!.h / 2;
    const ty = byId.get(t)!.y + byId.get(t)!.h / 2;
    let prev = s;
    for (let c = cs + 1; c < ct; c++) {
      const id = `~${s}~${t}~${c}`;
      meta.set(id, { w: 0, h: 0, y: sy + ((ty - sy) * (c - cs)) / (ct - cs) });
      col.set(id, c);
      segs.push([prev, id]);
      prev = id;
    }
    segs.push([prev, t]);
  }

  // Group ids (cards + dummies) per column; the initial row order follows the
  // CURRENT y (keeps a whiff of the user's arrangement), id as the tiebreak.
  const nCols = Math.max(0, ...col.values()) + 1;
  const cols: string[][] = Array.from({ length: nCols }, () => []);
  for (const id of meta.keys()) cols[col.get(id)!].push(id);
  for (const c of cols) c.sort((a, b) => meta.get(a)!.y - meta.get(b)!.y || (a < b ? -1 : 1));

  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const [s, t] of segs) {
    (preds.get(t) ?? preds.set(t, []).get(t)!).push(s);
    (succs.get(s) ?? succs.set(s, []).get(s)!).push(t);
  }
  const rowOf = () => {
    const row = new Map<string, number>();
    for (const c of cols) c.forEach((id, i) => row.set(id, i));
    return row;
  };

  // The TRUE crossing count: with unit-span segments, two wires cross iff they run
  // between the same adjacent columns with inverted row orders. Summed over all
  // column pairs this now sees every crossing (long wires included, via dummies).
  const segsByCol: [string, string][][] = Array.from({ length: nCols }, () => []);
  for (const seg of segs) segsByCol[col.get(seg[0])!].push(seg);
  const countCrossings = () => {
    const row = rowOf();
    let n = 0;
    for (const bucket of segsByCol) {
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          const [s1, t1] = bucket[i];
          const [s2, t2] = bucket[j];
          if ((row.get(s1)! - row.get(s2)!) * (row.get(t1)! - row.get(t2)!) < 0) n++;
        }
      }
    }
    return n;
  };

  // Barycenter sweeps: L→R orders each column by its predecessors' rows, R→L by
  // its successors'. A card with no wired neighbours keeps its slot. Orderings can
  // oscillate, so snapshot the best-scoring one seen and restore it afterwards.
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
  let best = countCrossings();
  let bestCols = cols.map((c) => [...c]);
  for (let i = 0; i < 10 && best > 0; i++) {
    sweep(i % 2 === 0);
    const n = countCrossings();
    if (n < best) {
      best = n;
      bestCols = cols.map((c) => [...c]);
    }
  }
  cols.forEach((c, i) => c.splice(0, c.length, ...bestCols[i]));

  // Greedy polish: try swapping adjacent slots (dummies included — moving a wire's
  // corridor is as valid as moving a card); keep a swap only when the true count
  // drops. Segments are few, so the O(segs²) recount per trial is cheap.
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

  // Initial y: stack each column centred on a shared axis, gaps.y between rows.
  // Dummies are zero-height but still consume a gap — that's the corridor a long
  // wire runs through.
  const yPos = new Map<string, number>();
  for (const c of cols) {
    const totalH = c.reduce((sum, id) => sum + meta.get(id)!.h, 0) + gaps.y * (c.length - 1);
    let y = -totalH / 2;
    for (const id of c) {
      yPos.set(id, y);
      y += meta.get(id)!.h + gaps.y;
    }
  }

  // Y relaxation: pull every node toward the average centre of its wired
  // neighbours, then re-enforce the column's row order and gaps (down/up/down
  // clamps — the final down pass guarantees a valid stack). Connected cards line
  // up horizontally and long wires straighten through their dummy corridors.
  const nbrs = new Map<string, string[]>();
  for (const [s, t] of segs) {
    (nbrs.get(s) ?? nbrs.set(s, []).get(s)!).push(t);
    (nbrs.get(t) ?? nbrs.set(t, []).get(t)!).push(s);
  }
  const center = (id: string) => yPos.get(id)! + meta.get(id)!.h / 2;
  for (let pass = 0; pass < 4; pass++) {
    for (const c of cols) {
      for (const id of c) {
        const nb = nbrs.get(id);
        if (!nb?.length) continue;
        const want = nb.reduce((sum, n) => sum + center(n), 0) / nb.length;
        yPos.set(id, want - meta.get(id)!.h / 2);
      }
      const down = () => {
        for (let i = 1; i < c.length; i++) {
          const lo = yPos.get(c[i - 1])! + meta.get(c[i - 1])!.h + gaps.y;
          if (yPos.get(c[i])! < lo) yPos.set(c[i], lo);
        }
      };
      const up = () => {
        for (let i = c.length - 2; i >= 0; i--) {
          const hi = yPos.get(c[i + 1])! - meta.get(c[i])!.h - gaps.y;
          if (yPos.get(c[i])! > hi) yPos.set(c[i], hi);
        }
      };
      down();
      up();
      down();
    }
  }

  // X: columns run left→right with gaps.x between their widest cards, cards centred
  // within their column. A dummy-only column is zero-wide — just a wire corridor.
  const pos = new Map<string, { x: number; y: number }>();
  let x = 0;
  for (const c of cols) {
    if (!c.length) continue;
    const colW = Math.max(...c.map((id) => meta.get(id)!.w));
    for (const id of c) {
      if (!byId.has(id)) continue; // dummies guided the layout; only cards ship
      const it = byId.get(id)!;
      pos.set(id, { x: x + (colW - it.w) / 2, y: yPos.get(id)! });
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
