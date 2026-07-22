// The composition pool — a project-level dict of compositions (graph ending in an
// `output` card) addressed by STABLE id, referenced from segments
// (`rootCompositionId`) and, from the extracts wave on, from montage extracts.
// See specs/compositions/README.md for the model.
//
// Pool records are JSON-shaped (they round-trip the autosave), so hydration is
// intentionally tolerant like the segment/signal hydrators in segments.ts.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { normalizeGraph } from "./graph/normalize";
import { referencedCompositionIds } from "./graph/core";
import { connectVideo, emptyGraph, outputNode, videoNode } from "./graphModel";
import { cloneSignals, mkSegId, mkSigId, rid } from "./segments";
import type { Asset, Composition, CompositionPool, Graph, Segment } from "./types";

export function mkCompId() {
  return rid("comp");
}

// The persisted pool shape (looser than Composition — see RawSegment).
export type RawCompositionPool = Record<string, any> | null | undefined;

// Rebuild the pool from a saved project. Ids are PRESERVED (the hydrateSignals
// precedent, NOT hydrateSegments' fresh-mint): segments and — later — montage
// extracts reference compositions by id, so regenerating ids here would orphan
// every reference. Minting only happens on a defensively-detected duplicate,
// where the entry is unreachable garbage either way. Every graph runs through
// normalizeGraph so an older save upgrades exactly like segment graphs used to.
export function hydrateCompositions(raw: RawCompositionPool): CompositionPool {
  const pool: CompositionPool = {};
  for (const [key, c] of Object.entries(raw || {})) {
    if (!c || typeof c !== "object" || !c.graph) continue;
    const id = typeof c.id === "string" && c.id && !pool[c.id] ? c.id : key;
    if (pool[id]) continue; // duplicate id — unreachable garbage, drop it
    pool[id] = {
      id,
      name: typeof c.name === "string" && c.name ? c.name : "composition",
      graph: normalizeGraph(c.graph as Graph),
      ...(typeof c.outputId === "string" && c.outputId ? { outputId: c.outputId } : {}),
    };
  }
  return pool;
}

export function createComposition(name: string, graph: Graph): Composition {
  return { id: mkCompId(), name, graph };
}

// The LEAF composition — the minimal one: video card → output. "Pick a video" in the
// montage strip is a shortcut that creates exactly this; opening it shows just the
// video card. The video card is created on the SEGMENT clock (sync:"segment"): a
// leaf plays from its in-point at the cut, and staying off the song clock is what
// keeps the composition window-INsensitive — retiming the trigger reuses its cached
// frames (backend `_window_sensitive`).
export function leafComposition(asset: Pick<Asset, "url" | "name" | "kind">): Composition {
  const video = videoNode(80, 40);
  video.data = { ...video.data, assetUrl: asset.url, sync: "segment" };
  const out = outputNode(420, 40);
  const graph = connectVideo(
    { ...emptyGraph(), nodes: [video, out] },
    video.id,
    "out",
    out.id,
    "video"
  );
  return { id: mkCompId(), name: asset.name || "clip", graph };
}

// The output node a composition's product renders from: its explicit `outputId`
// when it names a live output card, else the SOLE output in its graph — with
// several outputs and no mark it is genuinely ambiguous. Mirrors backend
// `compositions.final_output_id`, which gates the whole-song export.
export function finalOutputIdOf(comp: Composition | null | undefined): string | undefined {
  if (!comp) return undefined;
  const outs = (comp.graph.nodes || []).filter((n) => n.type === "output").map((n) => n.id);
  if (comp.outputId && outs.includes(comp.outputId)) return comp.outputId;
  return outs.length === 1 ? outs[0] : undefined;
}

// The slice of the pool a graph can reach through its montage extracts
// (recursively) — what a render POST ships as `compositions`, so a preview body
// never carries the whole project's pool. `undefined` when the graph references
// nothing (the common case: no request-size cost, and the backend hash stays
// byte-identical to the pool-less form).
export function reachableSlice(
  graph: Graph | null | undefined,
  pool: CompositionPool
): CompositionPool | undefined {
  const seen = new Set<string>();
  const stack = [...referencedCompositionIds(graph)];
  if (!stack.length) return undefined;
  const out: CompositionPool = {};
  while (stack.length) {
    const cid = stack.pop()!;
    if (seen.has(cid)) continue;
    seen.add(cid);
    const comp = pool[cid];
    if (!comp) continue; // dangling — the hash still notices via the reference itself
    out[cid] = comp;
    stack.push(...referencedCompositionIds(comp.graph));
  }
  return out;
}

// A segment's root composition, or null while it has no animation.
export function rootCompositionOf(
  seg: Pick<Segment, "rootCompositionId"> | null | undefined,
  pool: CompositionPool
): Composition | null {
  return (seg?.rootCompositionId && pool[seg.rootCompositionId]) || null;
}

// Deep-copy a pure-JSON graph (structuredClone with a JSON-roundtrip fallback
// for envs that lack it — graphs are pure JSON).
export function cloneGraph(graph: Graph): Graph {
  return typeof structuredClone === "function"
    ? structuredClone(graph)
    : (JSON.parse(JSON.stringify(graph)) as Graph);
}

// Rewrite a graph's signal-node references through an id map; deep-copy so the
// clone and the original never share one object. Unknown ids pass through (they
// will read as "missing" later — the executor treats them as a flat 0).
function remapGraphSignals(graph: Graph, idMap: Record<string, string>): Graph {
  const g = cloneGraph(graph);
  for (const n of g.nodes) {
    if (n.type === "signal" && idMap[n.data.signalId]) {
      n.data.signalId = idMap[n.data.signalId];
    }
  }
  return g;
}

// Clone a segment's root composition onto fresh signal ids -> a NEW pool entry
// (or null when the segment has no animation). The shared core of split/copy.
function cloneRootFor(
  seg: Segment,
  pool: CompositionPool,
  idMap: Record<string, string>
): Composition | null {
  const comp = seg.rootCompositionId ? pool[seg.rootCompositionId] : undefined;
  if (!comp || !comp.graph.nodes?.length) return null;
  return {
    ...comp,
    id: mkCompId(),
    graph: remapGraphSignals(comp.graph, idMap),
    // outputId carries over: the deep copy preserves node ids.
  };
}

// Split the segment that contains `t` into two at `t` (no-op near an edge). The
// second half gets fresh signal ids (independent) and its OWN composition — a
// clone of the root remapped onto them; the first half keeps its composition
// (there is no share-mutation hazard: the two halves reference distinct pool
// entries). Returns the new segments and the (possibly grown) pool.
export function splitAt(
  segments: Segment[],
  pool: CompositionPool,
  t: number
): { segments: Segment[]; pool: CompositionPool } {
  const out: Segment[] = [];
  let nextPool = pool;
  for (const s of segments) {
    if (t > s.start + 0.5 && t < s.end - 0.5) {
      out.push({ ...s, end: t });
      const { signals, idMap } = cloneSignals(s.signals);
      const clone = cloneRootFor(s, pool, idMap);
      if (clone) nextPool = { ...nextPool, [clone.id]: clone };
      out.push({
        ...s,
        id: mkSegId(),
        start: t,
        signals,
        rootCompositionId: clone?.id,
      });
    } else {
      out.push(s);
    }
  }
  return { segments: out, pool: nextPool };
}

// Copy a source segment's whole card layout (its root composition) onto `target`,
// returning the updated target + pool. The clone's `signal` cards are rewired to
// the TARGET's signals: each referenced band is matched to an existing target
// signal (same stem + frequency range + feature) or, if absent, cloned onto the
// target — so the copied pipeline drives THIS segment instead of pointing back at
// the source's signals. The ★final mark (composition.outputId) carries over with
// the preserved node ids.
export function copyLayout(
  source: Segment,
  target: Segment,
  pool: CompositionPool
): { target: Segment; pool: CompositionPool } {
  const srcComp = source.rootCompositionId ? pool[source.rootCompositionId] : undefined;
  if (!srcComp || !srcComp.graph.nodes?.length) return { target, pool };
  const key = (s: { stemKey: string; minHz: number; maxHz: number; feature: string }) =>
    `${s.stemKey}|${s.minHz}|${s.maxHz}|${s.feature}`;
  const srcById = new Map(source.signals.map((s) => [s.id, s]));
  const byKey = new Map(target.signals.map((s) => [key(s), s]));
  const idMap: Record<string, string> = {};
  const added: Segment["signals"] = [];
  for (const n of srcComp.graph.nodes) {
    if (n.type !== "signal") continue;
    const sig = srcById.get(n.data.signalId);
    if (!sig) continue; // dangling reference — leave it (reads as silent)
    const match = byKey.get(key(sig));
    if (match) {
      idMap[sig.id] = match.id;
    } else {
      const clone = { ...sig, id: mkSigId() };
      added.push(clone);
      byKey.set(key(sig), clone);
      idMap[sig.id] = clone.id;
    }
  }
  const comp: Composition = {
    ...srcComp,
    id: mkCompId(),
    graph: remapGraphSignals(srcComp.graph, idMap),
  };
  return {
    target: {
      ...target,
      signals: added.length ? [...target.signals, ...added] : target.signals,
      rootCompositionId: comp.id,
    },
    pool: { ...pool, [comp.id]: comp },
  };
}
