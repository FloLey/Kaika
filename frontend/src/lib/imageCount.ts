// Helpers for the Image gen card's gate-driven image count.
//
// A gate card emits a clean 0/1 square; the slideshow it feeds advances one image
// per rising edge of that trigger (starting on image 0), so the number of DISTINCT
// images it shows over a segment is `rises + 1`. The Image gen card resolves the
// wired gate's actual curve (via /resolve) and uses these to size its prompt list.

import { videoSource } from "./graph/core";
import type { Graph, GraphNode, ImagegenData, SlideshowData, SlideshowItem } from "./types";

// Video file extensions (mirrors backend `paths.ASSET_EXTS["video"]`). Anything not in
// this set is treated as an image. Used to infer a slideshow item's `kind` from its URL
// when the server didn't hand one back (legacy `assetUrls`, older library entries).
const VIDEO_EXTS = new Set(["mp4", "mov", "webm", "m4v"]);
export function slideshowKind(url: string): SlideshowItem["kind"] {
  const ext = url.split(".").pop()?.toLowerCase() || "";
  return VIDEO_EXTS.has(ext) ? "video" : "image";
}

// A slideshow's EFFECTIVE items: the card's OWN picks (images + videos, ordered) plus
// the IMAGE items that ride in through its `images` input (a wired Image gen card's
// generated list, capped to the gate-driven `activeCount`, empty rows dropped). ONE
// definition shared by the full card, the compact preview, and anything else that shows
// the count. Mirrors backend `_slideshow_items`.
export function slideshowItems(graph: Graph | null | undefined, node: GraphNode): SlideshowItem[] {
  const own = ((node.data as SlideshowData).items || []).filter((it) => it && it.url);
  if (!graph) return own;
  const genId = videoSource(graph, node.id, "images");
  const gen = genId ? graph.nodes.find((n) => n.id === genId) : null;
  if (!gen || gen.type !== "imagegen") return own;
  const d = gen.data as ImagegenData;
  const urls =
    d.activeCount != null
      ? (d.assetUrls || []).slice(0, Math.max(0, d.activeCount))
      : d.assetUrls || [];
  const gens: SlideshowItem[] = urls.filter(Boolean).map((url) => ({ url, kind: "image" }));
  return [...own, ...gens];
}

// URL-only view of the effective items — kept for the switch-count / compact preview,
// which only need the count and the urls.
export function slideshowUrls(graph: Graph | null | undefined, node: GraphNode): string[] {
  return slideshowItems(graph, node).map((it) => it.url);
}

// Frame index of each rising edge of a 0..1 `curve` — a 0→1 crossing of the
// threshold with a small dead band, matching the slideshow/montage's built-in
// hysteresis so the counts agree. A curve that STARTS high isn't a rise (frame 0
// already shows item/slot 0), mirroring `_slideshow_index` / `_montage_starts`
// (backend). The montage card uses the frame positions to show per-slot durations.
export function riseFrames(curve: number[], threshold = 0.5, hysteresis = 0.1): number[] {
  const hi = Math.min(1, threshold + hysteresis / 2);
  const lo = Math.max(0, threshold - hysteresis / 2);
  let state = 0;
  const rises: number[] = [];
  curve.forEach((v, i) => {
    if (state === 0 && v >= hi) {
      state = 1;
      if (i > 0) rises.push(i);
    } else if (state === 1 && v < lo) {
      state = 0;
    }
  });
  return rises;
}

// Count of rising edges (the Image gen / slideshow "switches N×" counter).
export function countRises(curve: number[], threshold = 0.5, hysteresis = 0.1): number {
  return riseFrames(curve, threshold, hysteresis).length;
}

// Non-destructively resize a prompt list to `needed` rows:
//  - grow by appending empty rows;
//  - shrink by removing only TRAILING EMPTY rows (never a typed prompt), so if you
//    have more typed prompts than the gate needs they're all kept.
// Always leaves at least one row.
export function fitPrompts(prompts: string[], needed: number): string[] {
  const p = prompts.length ? [...prompts] : [""];
  if (!Number.isFinite(needed) || needed <= 0) return p;
  while (p.length < needed) p.push("");
  while (p.length > needed && !p[p.length - 1].trim()) p.pop();
  return p.length ? p : [""];
}
