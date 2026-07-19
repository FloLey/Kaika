import { describe, it, expect } from "vitest";

import { portKey, edgePath, canConnect, connectIssue } from "../components/animation/ports";
import type { PortSide } from "../components/animation/ports";

// `canConnect` / `connectIssue` decide which wires are LEGAL — every edge the user can
// draw passes through them — and neither had a test. The file's own comment says the two
// are "kept in lockstep so the highlight and the toast can never disagree", which is
// precisely the kind of invariant that rots silently: the canvas highlights a port using
// canConnect and explains a refusal using connectIssue, so if they drift you get a port
// that lights up green and then refuses the drop (or worse, the reverse).
//
// The table below asserts BOTH functions on every case, so lockstep is checked rather
// than hoped for.

const out = (nodeId: string, flow: string): PortSide => ({ kind: "out", nodeId, flow });
const inp = (nodeId: string, flow: string): PortSide => ({ kind: "in", nodeId, flow });

describe("connect legality", () => {
  const legal: [string, PortSide, PortSide][] = [
    ["value -> value", out("a", "value"), inp("b", "value")],
    ["video -> video", out("a", "video"), inp("b", "video")],
    ["points -> points", out("a", "points"), inp("b", "points")],
    ["color -> color", out("a", "color"), inp("b", "color")],
  ];

  it.each(legal)("allows %s between different nodes", (_label, source, target) => {
    expect(canConnect(source, target)).toBe(true);
    expect(connectIssue(source, target)).toBeNull();
  });

  const rejected: [string, PortSide, PortSide, RegExp][] = [
    ["a drop onto another OUTPUT", out("a", "value"), out("b", "value"), /input port/i],
    ["a node wired to itself", out("a", "value"), inp("a", "value"), /itself/i],
    ["a value output into a video input", out("a", "value"), inp("b", "video"), /mismatch/i],
    ["a video output into a value input", out("a", "video"), inp("b", "value"), /mismatch/i],
    ["a points output into a color input", out("a", "points"), inp("b", "color"), /mismatch/i],
  ];

  it.each(rejected)("rejects %s, and explains why", (_label, source, target, why) => {
    expect(canConnect(source, target)).toBe(false);
    expect(connectIssue(source, target)).toMatch(why);
  });

  it("names both flows in a type-mismatch message", () => {
    // The message is user-facing; it has to say which way round the mismatch is.
    expect(connectIssue(out("a", "value"), inp("b", "video"))).toBe(
      "Type mismatch: a value output can't feed a video input."
    );
  });

  it("self-connection beats type-mismatch when both apply", () => {
    // Ordering matters for the toast: "can't connect to itself" is the useful message.
    expect(connectIssue(out("a", "value"), inp("a", "video"))).toMatch(/itself/i);
  });

  it("refuses to start from an INPUT port", () => {
    // canConnect owns this rule alone — connectIssue has nothing to say about a drag that
    // began in the wrong place, so it stays null. Pinned so the asymmetry is deliberate.
    expect(canConnect(inp("a", "value"), inp("b", "value"))).toBe(false);
    expect(connectIssue(inp("a", "value"), inp("b", "value"))).toBeNull();
  });

  it("treats an in-progress drag over empty space as 'no issue yet', not an error", () => {
    // The canvas calls this on every pointermove; a message here would flash a toast
    // while the user is still dragging.
    expect(connectIssue(out("a", "value"), null)).toBeNull();
    expect(connectIssue(null, inp("b", "value"))).toBeNull();
    expect(connectIssue(undefined, undefined)).toBeNull();
    expect(canConnect(out("a", "value"), null)).toBe(false);
  });

  it("never reports a connection as legal without also having no issue", () => {
    // The lockstep invariant, stated directly over the whole cross product.
    const flows = ["value", "video", "points", "color"];
    const sides: PortSide[] = [];
    for (const flow of flows) {
      for (const node of ["a", "b"]) {
        sides.push(out(node, flow), inp(node, flow));
      }
    }
    for (const s of sides) {
      for (const t of sides) {
        if (canConnect(s, t)) {
          expect(connectIssue(s, t), `${s.kind}/${s.flow} -> ${t.kind}/${t.flow}`).toBeNull();
        }
      }
    }
  });
});

describe("port geometry", () => {
  it("keys a port by node and port id", () => {
    expect(portKey("n1", "video")).toBe("n1::video");
  });

  it("is AMBIGUOUS if an id ever contains the separator (latent, not currently reachable)", () => {
    // `${nodeId}::${portId}` is not injective: ("n1", "a::b") and ("n1::a", "b") produce
    // the same key, so one port's DOM rect would overwrite the other's in the registry
    // and an edge would be drawn to the wrong place.
    //
    // Not a live bug: node ids are `n-<uuid8>` (factories.ts `rid`) and port ids are
    // fixed names ("video", "opacity") or `slot-<uuid>`, none of which contain "::".
    // Pinned so that if an id scheme ever changes to allow it, this test says why it
    // matters rather than leaving someone to debug a mis-drawn wire.
    expect(portKey("n1", "a::b")).toBe(portKey("n1::a", "b"));
  });

  it("draws a bezier whose control offset scales with the run, clamped both ends", () => {
    // Short edge: clamped to the 30px floor so it still reads as a curve.
    expect(edgePath(0, 0, 10, 0)).toBe("M 0 0 C 30 0, -20 0, 10 0");
    // Mid: half the run.
    expect(edgePath(0, 0, 100, 0)).toBe("M 0 0 C 50 0, 50 0, 100 0");
    // Long edge: clamped to the 120px ceiling rather than ballooning.
    expect(edgePath(0, 0, 1000, 0)).toBe("M 0 0 C 120 0, 880 0, 1000 0");
  });

  it("always bows left-to-right, so a backward edge loops out and back", () => {
    // The control offset uses the ABSOLUTE run (100 for both directions), but is applied
    // as x1+dx / x2-dx unconditionally. Forward that reads as a smooth flow; backward it
    // pushes the handles past both endpoints and the edge visibly loops.
    expect(edgePath(0, 0, 200, 0)).toBe("M 0 0 C 100 0, 100 0, 200 0");
    expect(edgePath(200, 0, 0, 0)).toBe("M 200 0 C 300 0, -100 0, 0 0");
    // This is fine for the graph as built — flowLayout puts producers left of consumers,
    // so edges run left-to-right — but it is why a hand-dragged backward wire looks odd.
  });
});
