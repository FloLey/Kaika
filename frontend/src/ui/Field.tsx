// Labelled form fields, finishing the vocabulary `Ctl`/`Toggle`/`Info` started.
//
// Those three cover sliders and checkboxes and are used by twenty files. Everything
// else is hand-rolled per screen: `<input type="number" className="hz-input">` is
// re-declared in six components, each with its own inline clamp — ExportStep alone
// had four copies of `Math.max(lo, Math.min(hi, Math.round(parseFloat(v) || 0)))` —
// and one visual role, "a select", has three different class names
// (`.signal-feature`, `.seg-select`, `.anim-select`).
//
// The clamp is the point, not the markup: written by hand it is the kind of thing
// that gets copied with one bound left at the old value.

import type { ChangeEvent, ReactNode } from "react";
import Info from "./Info";

interface FieldShellProps {
  label: string;
  help?: string;
  section?: string;
  hint?: ReactNode; // a line under the control, for what the value costs you
  children: ReactNode;
}

// The label + "?" + control + hint row. `.out-field` is the existing class, so
// these fields sit in the layouts that already style it.
export function Field({ label, help, section, hint, children }: FieldShellProps) {
  return (
    <div className="out-field">
      <span className="out-label">{label}</span>
      {help && <Info text={help} section={section} />}
      {children}
      {hint && <span className="export-hint">{hint}</span>}
    </div>
  );
}

export interface NumberFieldProps extends Omit<FieldShellProps, "children"> {
  value: number;
  min: number;
  max: number;
  step?: number;
  // Round to a whole number before clamping. Sizes, fps and cell counts all want
  // this; nothing in the app wants a fractional one.
  integer?: boolean;
  onChange: (v: number) => void;
}

// Clamp on the way OUT, not on the way in: clamping the displayed value as you type
// makes "40" unreachable when the minimum is 16 and you've typed "4".
export function clampTo(v: number, min: number, max: number, integer = true): number {
  const n = integer ? Math.round(v || 0) : v || 0;
  return Math.max(min, Math.min(max, n));
}

export function NumberField({
  value,
  min,
  max,
  step = 1,
  integer = true,
  onChange,
  ...shell
}: NumberFieldProps) {
  return (
    <Field {...shell}>
      <input
        type="number"
        className="hz-input"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={shell.label}
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          onChange(clampTo(parseFloat(e.target.value), min, max, integer))
        }
      />
    </Field>
  );
}

export interface SelectFieldProps<T extends string> extends Omit<FieldShellProps, "children"> {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}

export function SelectField<T extends string>({
  value,
  options,
  onChange,
  ...shell
}: SelectFieldProps<T>) {
  return (
    <Field {...shell}>
      <select
        className="anim-select"
        value={value}
        aria-label={shell.label}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}
