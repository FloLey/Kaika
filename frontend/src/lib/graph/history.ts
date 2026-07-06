// Undo/redo history for the graph editor — session-only, per segment (the editor
// remounts keyed by segment.id). Snapshots are the PRE-EDIT graphs; they're safe to
// keep by reference because every mutation helper returns a fresh Graph without
// touching the previous one (the §3.3 helpers were made strictly immutable for
// exactly this). Pure functions so the coalescing/caps are unit-testable.

import type { Graph } from "../types";

export interface GraphHistory {
  past: Graph[]; // oldest .. newest pre-edit snapshots
  future: Graph[]; // redo stack (newest undo first pushed last)
  lastEdit: number; // epoch ms of the last recorded edit (coalescing window)
}

export const HISTORY_CAP = 50;
export const COALESCE_MS = 400;

export const emptyHistory = (): GraphHistory => ({ past: [], future: [], lastEdit: 0 });

// Record the pre-edit snapshot of a new edit. Edits within COALESCE_MS of the
// previous one are the SAME GESTURE (a slider drag commits dozens of graphs):
// keep the gesture's first snapshot so one Cmd+Z reverts the whole drag. Any new
// edit clears the redo stack.
export function recordEdit(
  h: GraphHistory,
  before: Graph,
  now: number,
  cap = HISTORY_CAP,
  coalesceMs = COALESCE_MS
): GraphHistory {
  if (now - h.lastEdit < coalesceMs && h.past.length) {
    return { past: h.past, future: [], lastEdit: now };
  }
  return { past: [...h.past, before].slice(-cap), future: [], lastEdit: now };
}

// Undo: pop the newest snapshot; the CURRENT graph moves to the redo stack.
export function undoStep(
  h: GraphHistory,
  current: Graph
): { history: GraphHistory; graph: Graph } | null {
  if (!h.past.length) return null;
  const graph = h.past[h.past.length - 1];
  return {
    graph,
    history: { past: h.past.slice(0, -1), future: [...h.future, current], lastEdit: 0 },
  };
}

// Redo: pop the newest undone state back; the current graph returns to the past.
export function redoStep(
  h: GraphHistory,
  current: Graph
): { history: GraphHistory; graph: Graph } | null {
  if (!h.future.length) return null;
  const graph = h.future[h.future.length - 1];
  return {
    graph,
    history: { past: [...h.past, current], future: h.future.slice(0, -1), lastEdit: 0 },
  };
}
