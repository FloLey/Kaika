// Schema-driven form engine: the inspector is GENERATED from the recipe JSON
// Schema (served at /api/schema/recipe), curated by its `ui` annotations
// (tier / widget / label / min / max / step). No hand-built per-field forms —
// moving a field between the card face and "More settings" is one annotation
// on the backend, not UI code.
import { useRef } from "react";
import { getPath } from "../api";

export interface FormCtx {
  onSet: (path: string, value: any) => void;   // dot-path relative to recipe root
  modulated: Set<string>;                      // paths currently driven by a modulator
  pins: Set<string>;
  onPin: (path: string) => void;
  canvasAspect: number;                        // w/h, for the 2D pad
}

const isNum = (s: any) => s?.type === "number" || s?.type === "integer";

function label(name: string, ui: any): string {
  if (ui?.label) return ui.label;
  return name.replace(/_/g, " ").replace(/\bs\b$/, "(s)");
}

/** Hoverable ⓘ describing what a parameter does (text comes from the schema's
 * ui.help annotation — one source of truth with the chat copilot). */
function Help({ ui }: { ui: any }) {
  if (!ui?.help) return null;
  return <span className="help" title={ui.help}>?</span>;
}

function NumberRow({ name, schema, value, path, ctx }:
  { name: string; schema: any; value: any; path: string; ctx: FormCtx }) {
  const ui = schema.ui || {};
  const min = schema.minimum ?? ui.min ?? 0;
  const max = schema.maximum ?? ui.max ?? Math.max(1, (schema.default ?? 1) * 4);
  const step = ui.step ?? (schema.type === "integer" ? 1 : (max - min) / 100);
  const v = value ?? schema.default ?? 0;
  const isMod = ctx.modulated.has(path);
  const pinned = ctx.pins.has(path);
  return (
    <div className="slider-row">
      <label className="field frow">
        <span className="fname">{label(name, ui)}</span>
        <Help ui={ui} />
        {isMod && <span className="mod-badge" title="audio-driven by a modulator">~</span>}
        <span className="val">{schema.type === "integer" ? v : (+v).toFixed(3).replace(/\.?0+$/, "")}</span>
        <button className={`pin ${pinned ? "on" : ""}`} title="pin to session controls"
          onClick={() => ctx.onPin(path)}>⌖</button>
      </label>
      <input type="range" min={min} max={max} step={step} value={v}
        onChange={(e) => ctx.onSet(path, schema.type === "integer"
          ? parseInt(e.target.value) : parseFloat(e.target.value))} />
    </div>
  );
}

function EnumRow({ name, schema, value, path, ctx }:
  { name: string; schema: any; value: any; path: string; ctx: FormCtx }) {
  return (
    <div className="enum-row">
      <label className="field frow">
        <span className="fname">{label(name, schema.ui)}</span>
        <Help ui={schema.ui} />
      </label>
      <select value={value ?? schema.default ?? schema.enum[0]}
        onChange={(e) => ctx.onSet(path, e.target.value)}>
        {schema.enum.map((o: string) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

function StringRow({ name, schema, value, path, ctx }:
  { name: string; schema: any; value: any; path: string; ctx: FormCtx }) {
  const v = value ?? schema.default ?? "";
  const isColor = schema.ui?.widget === "color" || /^#[0-9a-fA-F]{6}$/.test(v);
  return (
    <div className="enum-row">
      <label className="field frow">
        <span className="fname">{label(name, schema.ui)}</span>
        <Help ui={schema.ui} />
      </label>
      {isColor ? (
        <input type="color" value={v || "#888888"}
          onChange={(e) => ctx.onSet(path, e.target.value)} />
      ) : (
        <input type="text" value={v}
          onChange={(e) => ctx.onSet(path, e.target.value)} />
      )}
    </div>
  );
}

function BoolRow({ name, schema, value, path, ctx }:
  { name: string; schema: any; value: any; path: string; ctx: FormCtx }) {
  return (
    <label className="check">
      <input type="checkbox" checked={value ?? schema.default ?? false}
        onChange={(e) => ctx.onSet(path, e.target.checked)} />
      {label(name, schema.ui)}
      <Help ui={schema.ui} />
    </label>
  );
}

function NumListRow({ name, value, path, ctx, dflt, ui }:
  { name: string; value: any; path: string; ctx: FormCtx; dflt: any[]; ui?: any }) {
  const v: any[] = Array.isArray(value) ? value : dflt;
  return (
    <div className="numlist-row">
      <label className="field frow">
        <span className="fname">{label(name, ui)}</span>
        <Help ui={ui} />
      </label>
      <div className="numlist">
        {v.map((x, i) => (
          <input key={i} type="number" step={0.01} value={Array.isArray(x) ? "" : x}
            disabled={Array.isArray(x)}
            onChange={(e) => {
              const next = [...v];
              next[i] = parseFloat(e.target.value) || 0;
              ctx.onSet(path, next);
            }} />
        ))}
      </div>
    </div>
  );
}

/** Drag-a-point pad rendered at the canvas aspect — the hand-built widget the
 * schema requests via `ui.widget: pad2d` (placements). */
export function Pad2D({ placement, onChange, aspect }:
  { placement: any; onChange: (p: any) => void; aspect: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const type = placement?.type ?? "random";
  const pts: number[][] = type === "fixed" || type === "line"
    ? (placement.points?.length ? placement.points
       : type === "line" ? [[0.25, 0.5], [0.75, 0.5]] : [[0.5, 0.5]])
    : [];
  const center = placement?.center ?? [0.5, 0.5];
  const region = placement?.region ?? [0.05, 0.05, 0.95, 0.95];

  const apply = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    const p = { ...placement };
    if (type === "fixed" || type === "line") {
      const arr = pts.map((q) => [...q]);
      // move the nearest point
      let best = 0, bd = 9;
      arr.forEach((q, i) => {
        const d = (q[0] - x) ** 2 + (q[1] - y) ** 2;
        if (d < bd) { bd = d; best = i; }
      });
      arr[best] = [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
      p.points = arr;
    } else {
      p.center = [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
    }
    onChange(p);
  };

  const H = 110;
  return (
    <div ref={ref} className="pad2d"
      style={{ height: H, width: Math.min(220, H * aspect) }}
      onClick={apply} title="click to place">
      {type === "random" && (
        <div className="pad-region" style={{
          left: `${region[0] * 100}%`, top: `${region[1] * 100}%`,
          width: `${(region[2] - region[0]) * 100}%`,
          height: `${(region[3] - region[1]) * 100}%` }} />
      )}
      {(type === "wander" || type === "circle" || type === "grid"
        || type.startsWith("signal")) && (
        <div className="pad-dot center"
          style={{ left: `${center[0] * 100}%`, top: `${center[1] * 100}%` }} />
      )}
      {pts.map((q, i) => (
        <div key={i} className="pad-dot"
          style={{ left: `${q[0] * 100}%`, top: `${q[1] * 100}%` }} />
      ))}
      {type === "line" && pts.length >= 2 && (
        <svg className="pad-line">
          <line x1={`${pts[0][0] * 100}%`} y1={`${pts[0][1] * 100}%`}
                x2={`${pts[1][0] * 100}%`} y2={`${pts[1][1] * 100}%`} />
        </svg>
      )}
    </div>
  );
}

/** Recursively render one object-schema's fields, filtered by tier.
 * `tier="primary"` renders card-face fields; `tier="advanced"` the rest. */
export function SchemaSection({ schema, value, basePath, tier, ctx, skip = [] }: {
  schema: any; value: any; basePath: string;
  tier: "primary" | "advanced"; ctx: FormCtx; skip?: string[];
}) {
  if (!schema?.properties) return null;
  const rows: any[] = [];
  for (const [name, sub] of Object.entries<any>(schema.properties)) {
    if (skip.includes(name)) continue;
    const path = basePath ? `${basePath}.${name}` : name;
    const v = getPath(value, name);
    const fieldTier = sub.ui?.tier ?? "advanced";
    if (sub.type === "object" && sub.properties) {
      const inner = (
        <SchemaSection key={path} schema={sub} value={v ?? {}} basePath={path}
          tier={tier} ctx={ctx} />
      );
      rows.push(<div key={path} className="schema-group">
        <div className="group-name">{label(name, sub.ui)}</div>{inner}</div>);
      continue;
    }
    if (fieldTier !== tier) continue;
    if (sub.enum) rows.push(<EnumRow key={path} name={name} schema={sub} value={v} path={path} ctx={ctx} />);
    else if (isNum(sub)) rows.push(<NumberRow key={path} name={name} schema={sub} value={v} path={path} ctx={ctx} />);
    else if (sub.type === "boolean") rows.push(<BoolRow key={path} name={name} schema={sub} value={v} path={path} ctx={ctx} />);
    else if (sub.type === "string") rows.push(<StringRow key={path} name={name} schema={sub} value={v} path={path} ctx={ctx} />);
    else if (sub.type === "array" && Array.isArray(sub.default ?? v)
             && (sub.default ?? v)?.every?.((x: any) => typeof x === "number"))
      rows.push(<NumListRow key={path} name={name} value={v} path={path} ctx={ctx}
        dflt={sub.default ?? v ?? []} ui={sub.ui} />);
  }
  // prune empty groups
  const visible = rows.filter((r) => !(r.props?.className === "schema-group"
    && !r.props.children[1]?.props));
  return <>{visible}</>;
}

/** A full card body: primary fields + an "More settings" expander with the
 * advanced tier. The progressive-disclosure pattern, generated. */
export function SchemaCard({ schema, value, basePath, ctx, skip = [] }: {
  schema: any; value: any; basePath: string; ctx: FormCtx; skip?: string[];
}) {
  return (
    <>
      <SchemaSection schema={schema} value={value} basePath={basePath}
        tier="primary" ctx={ctx} skip={skip} />
      <details className="advanced">
        <summary>More settings</summary>
        <SchemaSection schema={schema} value={value} basePath={basePath}
          tier="advanced" ctx={ctx} skip={skip} />
      </details>
    </>
  );
}
