import { useEffect } from "react";
import {
  ORIENTATION_PRESETS, QUALITY_PRESETS, FPS_OPTIONS, presetFor, aspectOf,
} from "../../lib/output";

// Project-level output settings modal (opened from the CREATE ANIMATION header
// gear). Edits the one shared `output` object — size/orientation, render quality,
// fps, and background color — that every render and the live preview read.
export default function OutputSettings({ output, onChange, onClose }) {
  const set = (patch) => onChange({ ...output, ...patch });
  const preset = presetFor(output);

  // ESC closes; lock the page scroll while open.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const clampDim = (v) => Math.max(16, Math.min(4096, Math.round(v || 0)));

  return (
    <div className="anim-modal-scrim" onPointerDown={onClose}>
      <div
        className="anim-modal"
        role="dialog"
        aria-label="Output settings"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="anim-modal-head">
          <span className="anim-modal-title">OUTPUT SETTINGS</span>
          <button className="iconbtn" title="Close" onClick={onClose}>✕</button>
        </div>

        <div className="anim-modal-body">
          {/* live aspect preview */}
          <div className="out-preview-wrap">
            <div className="out-preview" style={{ aspectRatio: aspectOf(output) }}>
              <span className="out-preview-dim">{output.width}×{output.height}</span>
            </div>
          </div>

          {/* orientation presets */}
          <div className="out-field">
            <span className="out-label">orientation</span>
            <div className="out-presets">
              {ORIENTATION_PRESETS.map((p) => (
                <button
                  key={p.key}
                  className={"btn sm" + (preset === p.key ? " on" : "")}
                  onClick={() => set({ width: p.width, height: p.height })}
                >
                  {p.label} <span className="out-ratio">{p.ratio}</span>
                </button>
              ))}
            </div>
          </div>

          {/* custom size */}
          <div className="out-field">
            <span className="out-label">size{preset === "custom" ? " · custom" : ""}</span>
            <div className="out-size">
              <input
                type="number" className="hz-input" min={16} max={4096} step={2}
                value={output.width}
                onChange={(e) => set({ width: clampDim(parseFloat(e.target.value)) })}
              />
              <span className="out-x">×</span>
              <input
                type="number" className="hz-input" min={16} max={4096} step={2}
                value={output.height}
                onChange={(e) => set({ height: clampDim(parseFloat(e.target.value)) })}
              />
              <span className="out-unit">px</span>
            </div>
          </div>

          {/* render quality */}
          <div className="out-field">
            <span className="out-label">quality</span>
            <div className="out-presets">
              {QUALITY_PRESETS.map((q) => (
                <button
                  key={q.key}
                  className={"btn sm" + (output.quality === q.key ? " on" : "")}
                  onClick={() => set({ quality: q.key })}
                  title={q.hint}
                >
                  {q.label}
                </button>
              ))}
            </div>
          </div>

          {/* fps */}
          <div className="out-field">
            <span className="out-label">fps</span>
            <div className="out-presets">
              {FPS_OPTIONS.map((f) => (
                <button
                  key={f}
                  className={"btn sm" + (output.fps === f ? " on" : "")}
                  onClick={() => set({ fps: f })}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          {/* background color */}
          <div className="out-field">
            <span className="out-label">background</span>
            <div className="out-bg">
              <input
                type="color"
                className="out-color"
                value={output.background}
                onChange={(e) => set({ background: e.target.value })}
              />
              <span className="out-bg-hex">{output.background}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
