import { useState } from "react";
import type { ChangeEvent } from "react";
import {
  ORIENTATION_PRESETS,
  QUALITY_PRESETS,
  FPS_OPTIONS,
  presetFor,
  aspectOf,
} from "../../lib/output";
import type { OutputSettings as Output, Quality } from "../../lib/types";
import { useEscapeKey } from "../../lib/useEscapeKey";

interface OutputSettingsProps {
  output: Output;
  onChange: (o: Output) => void;
  onClose: () => void;
}

// Project-level output settings modal (opened from the CREATE ANIMATION header
// gear). Edits the one shared `output` object — size/orientation, render quality,
// and fps — that every render and the live preview read. (There is no background
// setting: un-dyed pixels are black; a backdrop is the bottom layer of a stack combine.)
export default function OutputSettings({ output, onChange, onClose }: OutputSettingsProps) {
  const set = (patch: Partial<Output>) => onChange({ ...output, ...patch });
  const preset = presetFor(output);

  // Aspect-ratio lock: when on, editing one dimension derives the other so the shape
  // is preserved. `ratio` (w/h) is (re)captured when the lock engages or an
  // orientation preset is picked — so custom edits then follow that shape.
  const [locked, setLocked] = useState(true);
  const [ratio, setRatio] = useState(() => output.width / output.height);
  const toggleLock = () =>
    setLocked((was) => {
      if (!was) setRatio(output.width / output.height); // capture current shape on lock
      return !was;
    });
  const pickOrientation = (w: number, h: number) => {
    setRatio(w / h); // the lock follows the chosen orientation
    set({ width: w, height: h });
  };

  // ESC closes; lock the page scroll while open.
  useEscapeKey(onClose);

  const clampDim = (v: number) => Math.max(16, Math.min(4096, Math.round(v || 0)));

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
          <button className="iconbtn" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="anim-modal-body">
          {/* live aspect preview */}
          <div className="out-preview-wrap">
            <div className="out-preview" style={{ aspectRatio: aspectOf(output) }}>
              <span className="out-preview-dim">
                {output.width}×{output.height}
              </span>
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
                  onClick={() => pickOrientation(p.width, p.height)}
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
                type="number"
                className="hz-input"
                min={16}
                max={4096}
                step={2}
                value={output.width}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const w = clampDim(parseFloat(e.target.value));
                  set(locked ? { width: w, height: clampDim(w / ratio) } : { width: w });
                }}
              />
              <span className="out-x">×</span>
              <input
                type="number"
                className="hz-input"
                min={16}
                max={4096}
                step={2}
                value={output.height}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const h = clampDim(parseFloat(e.target.value));
                  set(locked ? { height: h, width: clampDim(h * ratio) } : { height: h });
                }}
              />
              <span className="out-unit">px</span>
              <button
                type="button"
                className={"iconbtn out-lock" + (locked ? " on" : "")}
                title={
                  locked
                    ? "Aspect ratio locked — editing one side scales the other. Click to unlock."
                    : "Lock aspect ratio to the current shape"
                }
                aria-label="Lock aspect ratio"
                aria-pressed={locked}
                onClick={toggleLock}
              >
                {locked ? "🔒" : "🔓"}
              </button>
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
                  onClick={() => set({ quality: q.key as Quality })}
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
        </div>
      </div>
    </div>
  );
}
