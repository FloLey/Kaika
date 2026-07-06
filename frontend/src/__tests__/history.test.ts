import { describe, it, expect } from "vitest";
import { emptyHistory, recordEdit, undoStep, redoStep } from "../lib/graph/history";
import type { Graph } from "../lib/types";

// Undo/redo history for the graph editor: record pre-edit snapshots, coalesce a
// gesture's rapid commits, cap the stack, and round-trip undo -> redo.

const g = (tag: number): Graph => ({ version: tag, nodes: [], edges: [] });

describe("graph history", () => {
  it("undo returns the pre-edit snapshot; redo returns forward", () => {
    let h = emptyHistory();
    h = recordEdit(h, g(1), 1000); // edit: 1 -> 2
    h = recordEdit(h, g(2), 2000); // edit: 2 -> 3
    const u1 = undoStep(h, g(3))!;
    expect(u1.graph.version).toBe(2);
    const u2 = undoStep(u1.history, u1.graph)!;
    expect(u2.graph.version).toBe(1);
    expect(undoStep(u2.history, u2.graph)).toBeNull(); // bottom of the stack
    const r1 = redoStep(u2.history, u2.graph)!;
    expect(r1.graph.version).toBe(2);
    const r2 = redoStep(r1.history, r1.graph)!;
    expect(r2.graph.version).toBe(3);
    expect(redoStep(r2.history, r2.graph)).toBeNull();
  });

  it("rapid commits coalesce into one undo step (a slider drag)", () => {
    let h = emptyHistory();
    h = recordEdit(h, g(1), 1000); // gesture starts: keep this snapshot
    h = recordEdit(h, g(2), 1100); // same gesture — skipped
    h = recordEdit(h, g(3), 1200); // same gesture — skipped
    expect(h.past).toHaveLength(1);
    expect(undoStep(h, g(4))!.graph.version).toBe(1); // one Cmd+Z reverts the drag
    h = recordEdit(h, g(4), 5000); // a NEW gesture after the window
    expect(h.past).toHaveLength(2);
  });

  it("a new edit clears the redo stack", () => {
    let h = emptyHistory();
    h = recordEdit(h, g(1), 1000);
    const u = undoStep(h, g(2))!;
    expect(u.history.future).toHaveLength(1);
    const after = recordEdit(u.history, u.graph, 9000);
    expect(after.future).toHaveLength(0);
  });

  it("caps the stack at the limit (oldest dropped)", () => {
    let h = emptyHistory();
    for (let i = 0; i < 60; i++) h = recordEdit(h, g(i), i * 1000);
    expect(h.past).toHaveLength(50);
    expect(h.past[0].version).toBe(10); // the 10 oldest fell off
  });
});
