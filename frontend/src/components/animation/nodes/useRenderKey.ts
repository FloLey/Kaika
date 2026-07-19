import { useMemo } from "react";

import { outputHash } from "../../../lib/graphModel";
import type { NodeCtx } from "./nodeProps";

// One node's render key: the hash of its contributing subgraph plus everything else that
// changes the rendered clip. When this string changes, the clip would differ — so it is
// what gates a re-render, and it must mean the SAME thing for the Output card and for a
// card preview, or the two disagree about when a render is stale.
//
// It was written out identically in OutputNode and StreamPreview, same expression, same
// nine-entry dependency array. Those two files share nothing else worth merging (see
// below), but they must share this.
//
// The lyrics term is the subtle part: the backend folds a lyrics card's burned-in text
// into output_hash, and the aligned lines arrive asynchronously — so a graph that is
// otherwise unchanged still needs a fresh render once the text lands. `ctx.lyricsKey` is
// the editor's single serialization of those lines for all outputs; the JSON fallback
// covers a ctx that has none.
export function useRenderKey(ctx: NodeCtx | undefined, nodeId: string): string {
  const { graph, segment, job, signals, lyricLines, lyricsKey, output } = ctx || {};
  return useMemo(
    () =>
      graph
        ? outputHash(graph, nodeId, job, segment?.start, segment?.end, signals) +
          JSON.stringify(output || {}) +
          `|ly:${lyricsKey ?? JSON.stringify(lyricLines || [])}`
        : "",
    [graph, nodeId, job, segment?.start, segment?.end, signals, output, lyricsKey, lyricLines]
  );
}
