import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";

interface VolumeControlProps {
  value: number;
  onChange: (v: number) => void;
}

// A speaker button that pops a vertical volume slider on click. Closes on an
// outside click or Escape. `value` is 0..1; `onChange` gets the new value.
export default function VolumeControl({ value, onChange }: VolumeControlProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const icon = value === 0 ? "🔇" : value < 0.5 ? "🔉" : "🔊";

  return (
    <div className="seg-volume" ref={ref}>
      <button
        className="btn sm vol-btn"
        onClick={() => setOpen((o) => !o)}
        title="Volume (the simulation keeps playing)"
        aria-label="Volume"
        aria-expanded={open}
      >
        {icon}
      </button>
      {open && (
        <div className="vol-pop">
          <span className="vol-pct">{Math.round(value * 100)}</span>
          <div className="vol-track">
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={value}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(parseFloat(e.target.value))}
              aria-label="Volume"
            />
          </div>
        </div>
      )}
    </div>
  );
}
