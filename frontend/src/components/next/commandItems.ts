// What ⌘K can reach, and how a query narrows it. Pure, so the ranking is testable
// without a keyboard.
//
// The problem it answers: 35 card types live behind seven category dropdowns with no
// search, so a card is found by remembering which of "Sources / Modulators / Points /
// Generators / Montage / Compositing / Output" its author filed it under. And nothing
// anywhere jumps you to a segment or to a card by name.

import { paletteSpecs, chromeFor } from "../animation/nodes/registry";
import { signalNode } from "../../lib/graphModel";
import { fmtTime } from "../../lib/mel";
import type { Graph, GraphNode, Segment, Signal } from "../../lib/types";

export type CommandItem =
  | {
      kind: "add";
      id: string;
      label: string;
      hint: string;
      terms: string;
      factory: (x: number, y: number) => GraphNode;
    }
  | { kind: "card"; id: string; label: string; hint: string; terms: string; nodeId: string }
  | { kind: "segment"; id: string; label: string; hint: string; terms: string; segmentId: string };

export interface CommandSources {
  graph: Graph;
  segments?: Segment[];
  activeSegmentId?: string;
  signals?: Signal[];
}

// Everything the palette can act on, in the order it shows with an empty query:
// add first (the common case — you opened it to build something), then the cards on
// screen, then the other segments.
export function buildCommandItems({
  graph,
  segments,
  activeSegmentId,
  signals,
}: CommandSources): CommandItem[] {
  const items: CommandItem[] = [];

  // One entry per addable card type. `signal` has no generic factory (the toolbar
  // opens a picker for it); listing the segment's signals individually is strictly
  // better here — "bass pulse" is what you were going to look for anyway.
  for (const spec of paletteSpecs()) {
    const p = spec.palette!;
    items.push({
      kind: "add",
      id: `add:${spec.type}`,
      label: p.title || p.label,
      hint: spec.chrome.outFlow,
      terms: `${p.label} ${p.title || ""} ${spec.type} ${p.help || ""}`,
      factory: spec.factory!,
    });
  }
  for (const sig of signals || []) {
    items.push({
      kind: "add",
      id: `add:signal:${sig.id}`,
      label: sig.name || `${sig.stemKey} ${sig.feature}`,
      hint: `signal · ${sig.stemKey}`,
      terms: `signal ${sig.name || ""} ${sig.stemKey} ${sig.feature}`,
      factory: (x, y) => signalNode(sig, x, y),
    });
  }

  for (const n of graph.nodes || []) {
    const title = chromeFor(n.type).title;
    items.push({
      kind: "card",
      id: `card:${n.id}`,
      label: n.name ?? title,
      hint: title,
      terms: `${n.name || ""} ${title} ${n.type}`,
      nodeId: n.id,
    });
  }

  for (const s of segments || []) {
    if (s.id === activeSegmentId) continue; // jumping to where you already are is a no-op
    items.push({
      kind: "segment",
      id: `seg:${s.id}`,
      label: s.label,
      hint: `${fmtTime(s.start)}–${fmtTime(s.end)}`,
      terms: `${s.label} segment`,
      segmentId: s.id,
    });
  }

  return items;
}

// How well `item` matches `needle` — higher is better, 0 = no match. Three tiers, so
// typing "co" offers `color` before `echo`: the label starting with it beats a word
// inside it beats a hit anywhere in the searchable terms.
export function scoreCommand(item: CommandItem, needle: string): number {
  const label = item.label.toLowerCase();
  const terms = item.terms.toLowerCase();
  if (label.startsWith(needle)) return 300 - label.length;
  if (new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(label)) {
    return 200 - label.length;
  }
  if (terms.includes(needle)) return 100 - label.length;
  return 0;
}

// The visible list: unfiltered keeps the natural order (add / cards / segments); a
// query re-ranks by score, ties broken by the natural order so the list never jitters.
export function filterCommands(items: CommandItem[], query: string): CommandItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items
    .map((item, i) => ({ item, i, score: scoreCommand(item, needle) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.item);
}
