// Copy/paste of card GROUPS — including across segments/compositions. The clipboard
// is module state: it survives the editor remounting when the user navigates to
// another segment (the whole point: build a look once, paste it everywhere), and
// dies with the tab (no persistence — a graph fragment references project-local
// assets and signals, so a cross-project paste would dangle).
//
// What travels: the selected NODES (deep-cloned, so later edits never reach back
// into the clipboard) and the non-loose edges BETWEEN them. Port bindings that
// reference a node outside the selection are dropped at copy time — the edge they
// mirror isn't coming along, and the binding↔edge invariant must hold inside the
// clipboard too. Loose (parked) edges stay behind: they're unassigned UI state.
//
// What paste re-mints: node ids, edge ids, and every montage extract/breakpoint id
// (they key UI rows). What paste KEEPS: extract `compositionId` references — the
// pool is project-level, so a pasted montage SHARES its children (that's the DAG,
// refCounts go up; editing the child updates both segments). Signal cards re-point
// by SIGNATURE: the target segment's default signals have different UUIDs but the
// same {stemKey, band, feature} — the same match `SignalData.ref` gives the render.

import { isLooseEdge, mkEdgeId, mkNodeId, mkSlotId } from "./core";
import type { Graph, GraphEdge, GraphNode, MontageData, Signal, SignalData } from "../types";

export interface GraphClipboard {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// A binding that names a node: {kind:"node", nodeId}. Walk a node's ports and drop
// (for outside references) or remap (paste) the nodeId — the matching edge is
// handled by the same inside/outside split, so binding↔edge stays consistent.
function mapPortBindings(node: GraphNode, map: (nodeId: string) => string | null): GraphNode {
  type Port = { binding?: { kind?: string; nodeId?: string } };
  const data = node.data as { ports?: Record<string, Port> };
  if (!data.ports) return node;
  let changed = false;
  const ports: Record<string, Port> = {};
  for (const [k, p] of Object.entries(data.ports)) {
    const b = p?.binding;
    if (b?.kind === "node" && b.nodeId) {
      const to = map(b.nodeId);
      if (to === null) {
        changed = true;
        ports[k] = { ...p, binding: undefined };
        continue;
      }
      if (to !== b.nodeId) {
        changed = true;
        ports[k] = { ...p, binding: { ...b, nodeId: to } };
        continue;
      }
    }
    ports[k] = p;
  }
  return changed ? ({ ...node, data: { ...node.data, ports } } as GraphNode) : node;
}

// Snapshot the selected nodes + the edges among them. Returns null when the
// selection holds no nodes (edge-only selections aren't a copyable group).
export function copySelection(graph: Graph, ids: ReadonlySet<string>): GraphClipboard | null {
  const inSel = new Set(graph.nodes.filter((n) => ids.has(n.id)).map((n) => n.id));
  if (!inSel.size) return null;
  const nodes = graph.nodes
    .filter((n) => inSel.has(n.id))
    .map((n) => mapPortBindings(n, (id) => (inSel.has(id) ? id : null)))
    .map((n) => structuredClone(n));
  const edges = graph.edges
    .filter((e) => !isLooseEdge(e) && inSel.has(e.source) && inSel.has(e.target))
    .map((e) => structuredClone(e));
  return { nodes, edges };
}

// Fresh ids for a montage's inner rows (extracts, manual breakpoints) — they key
// UI lists and must not collide with the original's when both live in one project.
// `compositionId` is deliberately KEPT: the pasted montage shares its children.
function remintMontageRows(data: MontageData): MontageData {
  return {
    ...data,
    extracts: (data.extracts || []).map((x) => ({ ...x, id: mkSlotId() })),
    manualBreakpoints: (data.manualBreakpoints || []).map((bp) => ({ ...bp, id: mkSlotId() })),
  };
}

// Re-point a signal card at the TARGET segment's signals: exact id if it exists
// there, else the signature match (same stem/band/feature — the render's own
// fallback, resolve_signal). No match leaves the card as-is: it renders through
// its `ref` fallback and shows "missing" in the UI, both honest.
function repointSignal(data: SignalData, signals: Signal[] | undefined): SignalData {
  if (!signals?.length || signals.some((s) => s.id === data.signalId)) return data;
  const r = data.ref;
  const match = r
    ? signals.find(
        (s) =>
          s.stemKey === r.stemKey &&
          s.minHz === r.minHz &&
          s.maxHz === r.maxHz &&
          s.feature === r.feature
      )
    : undefined;
  return match ? { ...data, signalId: match.id, label: match.name ?? data.label } : data;
}

export interface PasteResult {
  graph: Graph;
  ids: string[]; // the new node ids — the caller selects them so the group drags as one
}

// Materialize the clipboard into `graph`: fresh node/edge ids, bindings and edges
// remapped onto them, positions offset so a paste-in-place doesn't hide the
// original, signal cards re-pointed at `signals` (the target segment's).
export function pasteClipboard(
  graph: Graph,
  clip: GraphClipboard,
  opts: { offset?: { x: number; y: number }; signals?: Signal[] } = {}
): PasteResult {
  const off = opts.offset ?? { x: 28, y: 28 };
  const idMap = new Map(clip.nodes.map((n) => [n.id, mkNodeId()]));
  const nodes = clip.nodes.map((orig) => {
    let n: GraphNode = {
      ...structuredClone(orig),
      id: idMap.get(orig.id)!,
      x: orig.x + off.x,
      y: orig.y + off.y,
    };
    n = mapPortBindings(n, (id) => idMap.get(id) ?? null);
    if (n.type === "montage") n = { ...n, data: remintMontageRows(n.data as MontageData) };
    if (n.type === "signal") n = { ...n, data: repointSignal(n.data as SignalData, opts.signals) };
    return n;
  });
  const edges = clip.edges.map((e) => ({
    ...structuredClone(e),
    id: mkEdgeId(),
    source: idMap.get(e.source)!,
    target: idMap.get(e.target)!,
  }));
  return {
    graph: { ...graph, nodes: [...graph.nodes, ...nodes], edges: [...graph.edges, ...edges] },
    ids: [...idMap.values()],
  };
}

// ---- the clipboard itself (module state — outlives editor remounts) ----------

let clipboard: GraphClipboard | null = null;
let pastes = 0; // consecutive pastes stagger so copies don't stack pixel-perfect

export function writeClipboard(clip: GraphClipboard | null): void {
  clipboard = clip;
  pastes = 0;
}
export function readClipboard(): GraphClipboard | null {
  return clipboard;
}
// The offset for the NEXT paste of the current clipboard (28px per paste so far).
export function nextPasteOffset(): { x: number; y: number } {
  pastes += 1;
  return { x: 28 * pastes, y: 28 * pastes };
}
