import type { CSSProperties } from "react";
import { fmtTime } from "../../lib/mel";
import { labelColor } from "../../lib/segments";
import type { Segment } from "../../lib/types";

interface SegmentRailProps {
  segments: Segment[];
  activeSegId?: string;
  onSelect: (id: string) => void;
  onCollapse?: () => void;
}

// Studio left column: the list of validated segments. Click one to load it into
// the stem editor on the right.
export default function SegmentRail({
  segments,
  activeSegId,
  onSelect,
  onCollapse,
}: SegmentRailProps) {
  return (
    <div className="seg-rail">
      <div className="seg-rail-head">
        <span className="section-title">SEGMENTS</span>
        <button className="iconbtn sm" title="Hide segments" onClick={onCollapse}>
          ‹
        </button>
      </div>
      {segments.map((s, i) => (
        <button
          key={s.id}
          className={"seg-chip" + (s.id === activeSegId ? " active" : "")}
          style={{ "--c": labelColor(s.label) } as CSSProperties}
          onClick={() => onSelect(s.id)}
        >
          <span className="seg-chip-top">
            <span className="seg-idx">{i + 1}</span>
            <span className="seg-name">{s.label}</span>
          </span>
          <span className="seg-chip-range">
            {fmtTime(s.start)} – {fmtTime(s.end)} · {fmtTime(s.end - s.start)}
          </span>
        </button>
      ))}
    </div>
  );
}
