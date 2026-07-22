import { useMontageShortfall } from "./useMontageShortfall";
import type { GraphNode } from "../../../lib/types";
import type { NodeCtx } from "./nodeProps";

// The black roll-up, surfaced on a COMPACTED montage. The full card carries the same
// warning, but a collapsed card showed only a thumbnail — so "your export will have black
// in it" was invisible exactly when a busy timeline makes you collapse cards, and an export
// shipped with a black hole no one was told about. Same hook, same truth, one badge.
export default function MontageCompactWarning({
  node,
  ctx,
}: {
  node: GraphNode;
  ctx: NodeCtx | undefined;
}) {
  const { shortRows } = useMontageShortfall(node, ctx);
  if (shortRows.black <= 0.05) return null;
  return (
    <span
      className="anim-compact-warn"
      title={
        `${shortRows.n} slot${shortRows.n === 1 ? "" : "s"} short of material: ` +
        `${shortRows.rows.map((r) => `slot ${r.row} (−${r.short.toFixed(1)}s)`).join(", ")}. ` +
        "A slot with loop off goes BLACK once its clip runs out — expand the card to fix it."
      }
    >
      ⚠ {shortRows.black.toFixed(1)}s black
    </span>
  );
}
