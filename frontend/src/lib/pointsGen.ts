// Parametric point layouts for the Pattern card. Pure + deterministic; the backend
// (graph.py `_pattern_points`) computes the SAME layouts for the render, so the card
// preview matches the result. All points are normalised 0..1 around centre (0.5, 0.5).

import type { PatternData } from "./types";

const TAU = Math.PI * 2;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function mulberry32(seed: number): () => number {
  let a = (seed | 0) || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function patternPoints(d: PatternData): [number, number][] {
  const count = Math.max(1, Math.min(64, Math.round(d.count)));
  const radius = clamp01(d.radius);
  const rot = ((d.rotation || 0) * Math.PI) / 180;
  const cx = 0.5 + (d.offsetX || 0);
  const cy = 0.5 + (d.offsetY || 0);
  const out: [number, number][] = [];

  if (d.layout === "grid") {
    const cols = Math.max(1, Math.round(Math.sqrt(count)));
    const rows = Math.ceil(count / cols);
    const ext = radius || 0.4;
    for (let i = 0; i < count; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const fx = cols > 1 ? c / (cols - 1) - 0.5 : 0;
      const fy = rows > 1 ? r / (rows - 1) - 0.5 : 0;
      out.push([clamp01(cx + fx * ext * 2), clamp01(cy + fy * ext * 2)]);
    }
  } else if (d.layout === "line") {
    const ext = radius || 0.4;
    for (let i = 0; i < count; i++) {
      const t = count > 1 ? i / (count - 1) - 0.5 : 0;
      out.push([clamp01(cx + Math.cos(rot) * t * ext * 2), clamp01(cy + Math.sin(rot) * t * ext * 2)]);
    }
  } else if (d.layout === "spiral") {
    const turns = 3;
    for (let i = 0; i < count; i++) {
      const t = count > 1 ? i / (count - 1) : 0;
      const ang = rot + t * turns * TAU;
      const rr = radius * t;
      out.push([clamp01(cx + Math.cos(ang) * rr), clamp01(cy + Math.sin(ang) * rr)]);
    }
  } else if (d.layout === "scatter") {
    const rng = mulberry32(d.seed || 1);
    for (let i = 0; i < count; i++) {
      const ang = rng() * TAU;
      const rr = Math.sqrt(rng()) * radius;
      out.push([clamp01(cx + Math.cos(ang) * rr), clamp01(cy + Math.sin(ang) * rr)]);
    }
  } else {
    // circle / ring — points evenly on a circle (ring = same here in v1)
    for (let i = 0; i < count; i++) {
      const ang = rot + (i / count) * TAU;
      out.push([clamp01(cx + Math.cos(ang) * radius), clamp01(cy + Math.sin(ang) * radius)]);
    }
  }
  return out;
}
