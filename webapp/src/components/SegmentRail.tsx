// The song spine: a vertical list of segments. Click selects + previews;
// the selected one expands in place for contextual editing (name, prompt,
// split/merge, advanced fluid override) — no separate inspector tab.
import { useState } from "react";
import yaml from "js-yaml";
import { Segment } from "../api";
import HelpLink from "./HelpLink";

interface Props {
  segments: Segment[];
  selected: number;
  busy: boolean;
  onSelect: (i: number) => void;
  onUpdateSegment: (i: number, patch: Partial<Segment>) => void;
  onSplit: () => void;
  onMerge: () => void;
  onTune: () => void;                 // flip the context panel to Réglages
  onPreviewFull: () => void;
  onGenerate: () => void;
}

const LABEL_COLOR: Record<string, string> = {
  intro: "#6C4A8C", verse: "#34808A", chorus: "#B84A74",
  drop: "#D98A5E", build: "#E0A458", outro: "#3FA39B",
};
const dotColor = (label: string) => LABEL_COLOR[label] || "#8a8a8a";

export default function SegmentRail({
  segments, selected, busy, onSelect, onUpdateSegment, onSplit, onMerge,
  onTune, onPreviewFull, onGenerate }: Props) {
  const [advanced, setAdvanced] = useState(false);
  const [fluidText, setFluidText] = useState("");
  const [fluidErr, setFluidErr] = useState("");

  const openAdvanced = (seg: Segment) => {
    setAdvanced((a) => {
      const next = !a;
      if (next) {
        setFluidErr("");
        setFluidText(Object.keys(seg.fluid || {}).length
          ? yaml.dump(seg.fluid) : "");
      }
      return next;
    });
  };

  const applyFluid = (i: number) => {
    try {
      const obj = fluidText.trim() ? yaml.load(fluidText) : {};
      if (obj && typeof obj !== "object") throw new Error("expected a mapping");
      onUpdateSegment(i, { fluid: (obj as any) || {} });
      setFluidErr("");
    } catch (e: any) { setFluidErr(String(e.message || e)); }
  };

  return (
    <div className="card seg-rail">
      <h3>Segments <HelpLink anchor="segments" /></h3>
      <div className="seg-list">
        {segments.map((s, i) => (
          <div key={i} className={`seg-item${i === selected ? " sel" : ""}`}
            onClick={() => i !== selected && onSelect(i)}>
            <div className="seg-row">
              <span className="seg-dot" style={{ background: dotColor(s.label) }} />
              <span className="seg-name">{s.label || `segment ${i + 1}`}</span>
              <span className="seg-time">
                {s.start.toFixed(0)}–{s.end.toFixed(0)}s</span>
            </div>

            {i === selected && (
              <div className="seg-edit" onClick={(e) => e.stopPropagation()}>
                <label className="field">Name</label>
                <input value={s.label}
                  onChange={(e) => onUpdateSegment(i, { label: e.target.value })} />
                <label className="field">Prompt (diffusion)</label>
                <textarea rows={2} value={s.prompt}
                  placeholder="how this section should look once diffused…"
                  onChange={(e) => onUpdateSegment(i, { prompt: e.target.value })} />
                <div className="row">
                  <button className="btn ghost slim" onClick={onSplit}>
                    Split at playhead</button>
                  <button className="btn ghost slim" onClick={onMerge}
                    disabled={i >= segments.length - 1}>Merge next</button>
                </div>
                <button className="btn ghost slim" onClick={() => openAdvanced(s)}>
                  {advanced ? "Hide" : "Advanced"} overrides</button>
                {advanced && (
                  <>
                    <textarea rows={4} className="mono" value={fluidText}
                      placeholder={"field:\n  vorticity: 30"}
                      onChange={(e) => setFluidText(e.target.value)} />
                    {fluidErr && <p className="err">{fluidErr}</p>}
                    <button className="btn slim" onClick={() => applyFluid(i)}>
                      Apply overrides</button>
                  </>
                )}
                <button className="btn slim" onClick={onTune}>
                  ⚙ Tune this segment →</button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="seg-actions">
        <button className="btn ghost slim" disabled={busy} onClick={onPreviewFull}>
          Preview full track</button>
        <button className="btn slim" disabled={busy} onClick={onGenerate}>
          Generate (diffusion)</button>
      </div>
    </div>
  );
}
