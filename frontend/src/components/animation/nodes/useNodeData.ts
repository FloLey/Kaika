// The one way a node card patches its own `node.data`. Every card used to inline
// the same `set = (patch) => onGraphChange((g) => patchNodeData(g, node.id, patch))`
// closure — this hook is that closure, memoized so children receiving `set` don't
// re-render on every graph change. Lives beside nodeProps.ts (which stays types-only).

import { useCallback } from "react";
import { patchNodeData } from "../../../lib/graphModel";
import type { Graph, GraphNode } from "../../../lib/types";

export function useNodeData<T>(
  node: GraphNode,
  onGraphChange: (updater: (g: Graph) => Graph) => void
): (patch: Partial<T>) => void {
  return useCallback(
    (patch: Partial<T>) => onGraphChange((g) => patchNodeData(g, node.id, patch as Record<string, unknown>)),
    [node.id, onGraphChange]
  );
}
