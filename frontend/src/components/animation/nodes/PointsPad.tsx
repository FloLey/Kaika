import type { CSSProperties } from "react";

interface Props {
  points: [number, number][];
  aspect?: string;
  compact?: boolean;
}

// Read-only scatter of normalized (0..1) source points over the output aspect box —
// the shared preview for pattern / animate-points / merge-points and the compact
// previews of every points card. (PointsNode keeps its own editable pad.)
export default function PointsPad({ points, aspect = "1 / 1", compact = false }: Props) {
  return (
    <div
      className={"anim-points-pad anim-points-pad-ro" + (compact ? " anim-points-pad-sm" : "")}
      style={{ "--out-aspect": aspect } as CSSProperties}
    >
      {points.map(([x, y], i) => (
        <span
          key={i}
          className="anim-points-marker anim-points-marker-ro"
          style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
        />
      ))}
    </div>
  );
}
