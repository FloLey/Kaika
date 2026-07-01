import { useState } from "react";
import type { CSSProperties } from "react";
import { fmtTime } from "../../lib/mel";
import { labelColor } from "../../lib/segments";
import { NODE_TYPES, PALETTE_CATEGORIES } from "../animation/nodes/registry";
import type { Segment } from "../../lib/types";

interface SegmentRailProps {
  segments: Segment[];
  activeSegId?: string;
  onSelect: (id: string) => void;
  onCollapse?: () => void;
  // Playground mode: title "CARDS" and group the entries into collapsible categories
  // (matching the add-menu), with no time range — these are cards, not musical segments.
  grouped?: boolean;
}

// Card display label -> palette category key, derived from the node registry so the
// playground rail groups exactly like the add-menu (segment labels ARE card names).
const LABEL_TO_CATEGORY: Record<string, string> = Object.fromEntries(
  Object.values(NODE_TYPES)
    .filter((s) => s.palette)
    .map((s) => [s.palette!.label, s.palette!.category])
);

// Studio left column. For a normal project: the validated segments (with their time
// range). For the playground: the cards, grouped into collapsible categories.
export default function SegmentRail({
  segments,
  activeSegId,
  onSelect,
  onCollapse,
  grouped,
}: SegmentRailProps) {
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(() => new Set());
  const toggleCat = (key: string) =>
    setCollapsedCats((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const chip = (s: Segment, idx: number) => (
    <button
      key={s.id}
      className={"seg-chip" + (s.id === activeSegId ? " active" : "")}
      style={{ "--c": labelColor(s.label) } as CSSProperties}
      onClick={() => onSelect(s.id)}
    >
      <span className="seg-chip-top">
        {!grouped && <span className="seg-idx">{idx + 1}</span>}
        <span className="seg-name">{s.label}</span>
      </span>
      {!grouped && (
        <span className="seg-chip-range">
          {fmtTime(s.start)} – {fmtTime(s.end)} · {fmtTime(s.end - s.start)}
        </span>
      )}
    </button>
  );

  const head = (
    <div className="seg-rail-head">
      <span className="section-title">{grouped ? "CARDS" : "SEGMENTS"}</span>
      <button className="iconbtn sm" title={grouped ? "Hide cards" : "Hide segments"} onClick={onCollapse}>
        ‹
      </button>
    </div>
  );

  if (!grouped) {
    return (
      <div className="seg-rail">
        {head}
        {segments.map((s, i) => chip(s, i))}
      </div>
    );
  }

  // Group by category, in the add-menu order; keep the original index for selection.
  const byCat: Record<string, { seg: Segment; idx: number }[]> = {};
  segments.forEach((seg, idx) => {
    const cat = LABEL_TO_CATEGORY[seg.label] || "sources";
    (byCat[cat] ||= []).push({ seg, idx });
  });

  return (
    <div className="seg-rail">
      {head}
      {PALETTE_CATEGORIES.filter((c) => byCat[c.key]?.length).map((c) => {
        const isCollapsed = collapsedCats.has(c.key);
        return (
          <div key={c.key} className="seg-rail-group">
            <button
              className="seg-rail-group-label"
              onClick={() => toggleCat(c.key)}
              aria-expanded={!isCollapsed}
            >
              <span className="seg-rail-group-chev">{isCollapsed ? "▸" : "▾"}</span>
              <span>{c.label}</span>
              <span className="seg-rail-group-count">{byCat[c.key].length}</span>
            </button>
            {!isCollapsed && byCat[c.key].map(({ seg, idx }) => chip(seg, idx))}
          </div>
        );
      })}
    </div>
  );
}
