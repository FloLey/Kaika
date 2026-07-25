// What a wire dropped on a card should DO — decided as pure data, so the canvas can
// render the choice and the tests can assert it without a pointer drag.
//
// Why this exists: every card except `output` renders compact, and a compact card has
// ONE consolidated input dot standing in for all of its ports. The editor's answer to
// that ambiguity was to park every drop as a gray loose wire and make the user assign
// it in the settings window — which is correct, but it meant the canvas could no
// longer wire anything: the drag gesture always produced a placeholder. This resolves
// the port at the drop point instead, and keeps parking as an explicit choice rather
// than the only outcome.

import type { Graph, GraphNode, PortFlow } from "../../lib/types";
import { resolveDropPort } from "../../lib/graphModel";
import { cardInputs, inputSource } from "./nodeInputs";
import type { DynamicInputs } from "./nodeInputs";

export interface DropCandidate {
  portId: string;
  label: string;
  group?: string; // fluid param group — the menu shows these as section headers
  currentSource: string | null; // node id already feeding this port (a pick REPLACES it)
}

export type DropPlan =
  | { kind: "connect"; portId: string } // unambiguous — wire it, no menu
  | { kind: "menu"; candidates: DropCandidate[]; dynamic?: DynamicInputs & { flow: PortFlow } }
  | { kind: "park" }; // the card can't take this flow at all — today's loose wire

// The inputs of `node` that a `flow` output can legally feed, with whatever is
// already wired into each.
export function dropCandidates(graph: Graph, node: GraphNode, flow: PortFlow): DropCandidate[] {
  return cardInputs(node)
    .inputs.filter((i) => i.flow === flow)
    .map((i) => ({
      portId: i.portId,
      label: i.label,
      group: i.group,
      currentSource: inputSource(node, graph, i),
    }));
}

// Decide what a drop of `srcFlow` onto `tgtId` means.
//
// Order matters: `resolveDropPort` runs FIRST because it is the editor's existing,
// documented auto-assign heuristic (output.video, a combine's first free slot, a
// fluid's positions, the only unbound modulatable port). Compact-only made it
// unreachable; this puts it back in front. Only when it declines do we look at the
// card's full input list.
export function planDrop(graph: Graph, srcFlow: PortFlow, tgtId: string): DropPlan {
  const node = (graph.nodes || []).find((n) => n.id === tgtId);
  if (!node) return { kind: "park" };

  const auto = resolveDropPort(graph, tgtId, srcFlow);
  if (auto) return { kind: "connect", portId: auto };

  const candidates = dropCandidates(graph, node, srcFlow);
  const dyn = cardInputs(node).dynamic;
  // The dynamic group's flow is only knowable from an existing row (a combine's
  // layers are video, math's inputs are value…). With no row of this flow we can't
  // tell, so we don't offer to grow it.
  const dynamic = dyn && candidates.length ? { ...dyn, flow: srcFlow } : undefined;

  if (!candidates.length) return dynamic ? { kind: "menu", candidates, dynamic } : { kind: "park" };

  // Exactly one legal input, and it's empty: nothing to disambiguate, so wire it.
  // This is the case `resolveDropPort` never covered — a gate/shaper/scope `in` is a
  // plain edge, not a modulatable port, so a signal dropped on one used to park even
  // though the card had exactly one place it could go. An OCCUPIED single input
  // still opens the menu: silently replacing a wire you can't see is not a gesture
  // anyone asked for.
  if (candidates.length === 1 && !candidates[0].currentSource) {
    return { kind: "connect", portId: candidates[0].portId };
  }

  return { kind: "menu", candidates, dynamic };
}
