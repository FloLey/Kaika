import type { ChangeEvent } from "react";
import Info from "./Info";

interface CtlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  fmt?: (v: number) => string;
  help?: string;
  section?: string;
}

// Shared slider + checkbox control rows used by SignalCard and FluidLab. The
// optional `help`/`section` render a clickable "?" that deep-links into the
// guide. `onChange` receives the parsed value (FluidLab adapts its (key,value)
// convention at the call site). `section` defaults to the Studio shaping anchor
// since that's the most common caller; FluidLab overrides it.
export default function Ctl({
  label,
  value,
  min,
  max,
  step,
  onChange,
  fmt,
  help,
  section = "studio-shaping",
}: CtlProps) {
  return (
    <label className="ctl">
      <span className="ctl-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(parseFloat(e.target.value))}
      />
      <span className="ctl-val">{fmt ? fmt(value) : value}</span>
      {help && <Info text={help} section={section} />}
    </label>
  );
}

interface ToggleProps {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  help?: string;
  section?: string;
}

export function Toggle({ label, value, onChange, help, section }: ToggleProps) {
  return (
    <label className="ctl ctl-check">
      <span className="ctl-label">{label}</span>
      <input
        type="checkbox"
        checked={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.checked)}
      />
      {help && <Info text={help} section={section} />}
    </label>
  );
}
