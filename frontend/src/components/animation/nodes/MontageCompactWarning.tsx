import { useMemo } from "react";
import { useMontageShortfall } from "./useMontageShortfall";
import type { GraphNode } from "../../../lib/types";
import type { NodeCtx } from "./nodeProps";

// The montage roll-ups, surfaced on a COMPACTED montage. The full card (in the settings
// modal) carries the same warnings, but a collapsed card showed only a thumbnail — so
// "your export will have black in it" (and "these two slots replay the same clip") was
// invisible exactly when a busy timeline makes you collapse cards, and an export shipped
// with a defect no one was told about. Same hook, same truth, badges on the tile.
export default function MontageCompactWarning({
  node,
  ctx,
}: {
  node: GraphNode;
  ctx: NodeCtx | undefined;
}) {
  const { shortRows, repeats } = useMontageShortfall(node, ctx);
  const dupRows = useMemo(() => {
    // `repeats[i].row` is `first + 1` (raw index), so a slot's own number is `i + 1`.
    const rows = repeats
      .map((r, i) => (r ? { slot: i + 1, row: r.row, identical: r.identical } : null))
      .filter((r): r is { slot: number; row: number; identical: boolean } => r != null);
    return { n: rows.length, identical: rows.filter((r) => r.identical).length, rows };
  }, [repeats]);

  const black = shortRows.black > 0.05;
  if (!black && dupRows.n === 0) return null;
  return (
    <div className="anim-compact-warns">
      {black && (
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
      )}
      {dupRows.n > 0 && (
        <span
          className={"anim-compact-warn anim-compact-dup" + (dupRows.identical > 0 ? " same" : "")}
          title={
            `${dupRows.n} slot${dupRows.n === 1 ? "" : "s"} repeat an earlier clip: ` +
            `${dupRows.rows
              .map(
                (r) => `slot ${r.slot} = slot ${r.row}${r.identical ? "" : " (different in-point)"}`
              )
              .join(", ")}. ` +
            "Two slots from the same clip and in-point play frame-identical — it reads as a loop, " +
            "not a cut. Open the card to re-order or replace one."
          }
        >
          ⧉ {dupRows.n} repeat{dupRows.n === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}
