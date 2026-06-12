// The schema-driven inspector: Look | Emitters | Motion | YAML. Forms are
// generated from the recipe schema (SchemaForm); the few hand-built widgets
// (placement pad) swap in where the schema asks for them. Per-segment editing
// lives in the segment rail, not here.
import { useMemo, useState } from "react";
import yaml from "js-yaml";
import { ProjectDoc, TimelineDirective } from "../api";
import { SchemaCard, SchemaSection, Pad2D, FormCtx } from "./SchemaForm";
import HelpLink from "./HelpLink";

export type Tab = "look" | "emitters" | "motion" | "yaml";

interface Props {
  schema: any;
  project: ProjectDoc;
  ctx: FormCtx;                                  // recipe-path setter + badges
  onReplaceRecipe: (recipe: any, onErr: (e: string) => void) => void;
  onSetTimeline: (tl: TimelineDirective[]) => void;
}

const CANVAS_PRESETS = [
  { name: "Square 1:1", width: 1024, height: 1024 },
  { name: "Portrait 9:16", width: 1080, height: 1920 },
  { name: "Landscape 16:9", width: 1920, height: 1080 },
];

const EMITTER_TEMPLATES: Record<string, any> = {
  "kick jet": { trigger: { type: "onset", band: "low" },
    placement: { type: "wander", center: [0.5, 0.5] },
    direction: { type: "radial_out", jitter: 0.5 },
    color: { type: "palette", palette: "main", index: 0 },
    body: { radius: 0.1, force: 9000, lifetime_s: 0.8, emit: 0.22 } },
  "scatter pops": { trigger: { type: "onset", band: "high", max_per_frame: 5 },
    placement: { type: "random" }, direction: { type: "random" },
    color: { type: "palette_cycle", palette: "main", start: 1 },
    body: { radius: 0.03, force: 3500, lifetime_s: 0.3, emit: 0.11, speed: 2.6 } },
  "pitch line": { trigger: { type: "onset", band: "mid" },
    placement: { type: "signal_x", source: "chroma_argmax", range: [0.1, 0.9], y: 0.3 },
    direction: { type: "fixed", angle_deg: 90 },
    color: { type: "chroma_palette", palette: "main" },
    body: { radius: 0.05, force: 4000, lifetime_s: 0.6, emit: 0.13 } },
  "beat pulse": { trigger: { type: "beat", every: 4 }, count: 8,
    placement: { type: "fixed", points: [[0.5, 0.5]] },
    direction: { type: "radial_out", jitter: 0 },
    color: { type: "palette", palette: "main", index: 0, opacity: 0.4 },
    body: { radius: 0.18, force: 2000, lifetime_s: 0.4, emit: 0.05 } },
  "tension": { trigger: { type: "lookahead", section: "drop", window_s: 8 },
    placement: { type: "random", region: [0.2, 0.2, 0.8, 0.8] },
    direction: { type: "random" },
    color: { type: "palette", palette: "main", index: 0 },
    body: { radius: 0.08, force: 1500, lifetime_s: 0.7, emit: 0.1 } },
};

const SIGNALS = ["rms", "centroid", "flux", "beat_phase", "bar_phase",
  "harmonic_ratio", "chroma_argmax", "band.low", "band.mid", "band.high",
  "section.energy", "voice"];

function numericPaths(recipe: any): string[] {
  const out: string[] = [];
  const walk = (node: any, prefix: string) => {
    if (node == null) return;
    for (const [k, v] of Object.entries<any>(node)) {
      const p = `${prefix}.${k}`;
      if (typeof v === "number" && typeof v !== "boolean") out.push(p);
      else if (v && typeof v === "object" && !Array.isArray(v)) walk(v, p);
    }
  };
  walk(recipe.field ?? {}, "field");
  walk(recipe.render ?? {}, "render");
  for (const e of recipe.emitters ?? []) {
    walk({ body: e.body ?? {} }, `emitters.${e.id}`);
  }
  return out;
}

export default function Inspector(p: Props) {
  const { schema, project, ctx } = p;
  const recipe = project.recipe;
  const [tab, setTab] = useState<Tab>("look");
  const [yamlText, setYamlText] = useState("");
  const [yamlErr, setYamlErr] = useState("");
  const props = schema?.properties ?? {};
  const targets = useMemo(() => numericPaths(recipe), [recipe]);

  const openYaml = () => {
    setYamlText(yaml.dump({ ...recipe, timeline: undefined }, { noRefs: true })
      + "\n# project timeline:\n"
      + yaml.dump({ timeline: project.timeline }, { noRefs: true }));
    setYamlErr("");
    setTab("yaml");
  };
  const applyYaml = () => {
    try {
      const doc = yaml.load(yamlText) as any;
      const tl = doc.timeline;
      delete doc.timeline;
      p.onReplaceRecipe(doc, setYamlErr);
      if (Array.isArray(tl)) p.onSetTimeline(tl);
      setYamlErr("");
    } catch (e: any) { setYamlErr(String(e.message || e)); }
  };

  const T = (t: Tab, l: string) => (
    <button key={t} className={tab === t ? "active" : ""}
      onClick={() => (t === "yaml" ? openYaml() : setTab(t))}>{l}</button>
  );

  return (
    <div className="card inspector">
      <div className="insp-tabs">
        {T("look", "Look")}{T("emitters", "Emitters")}
        {T("motion", "Motion")}{T("yaml", "YAML")}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end",
                    margin: "-4px 0 6px" }}>
        <HelpLink anchor="reglages" />
      </div>
      <div className="insp-body">

        {tab === "look" && (
          <>
            <div className="preset-row">
              {CANVAS_PRESETS.map((c) => (
                <button key={c.name} className="btn ghost slim"
                  onClick={() => {
                    ctx.onSet("canvas.width", c.width);
                    ctx.onSet("canvas.height", c.height);
                  }}>{c.name}</button>
              ))}
            </div>
            <SchemaSection schema={props.canvas} value={recipe.canvas}
              basePath="canvas" tier="primary" ctx={ctx} />
            <label className="field">Palette (main)</label>
            <div className="palette-row">
              {(recipe.palettes?.main ?? []).map((c: string, i: number) => (
                <input key={i} type="color" value={c}
                  onChange={(e) => {
                    const pal = [...recipe.palettes.main];
                    pal[i] = e.target.value;
                    ctx.onSet("palettes.main", pal);
                  }} />
              ))}
              <button className="btn ghost slim" onClick={() =>
                ctx.onSet("palettes.main", [...recipe.palettes.main, "#888888"])}>+</button>
              {(recipe.palettes?.main?.length ?? 0) > 1 && (
                <button className="btn ghost slim" onClick={() =>
                  ctx.onSet("palettes.main", recipe.palettes.main.slice(0, -1))}>−</button>
              )}
            </div>
            <div className="group-name">Field</div>
            <SchemaCard schema={props.field} value={recipe.field}
              basePath="field" ctx={ctx} />
            <div className="group-name">Render</div>
            <SchemaCard schema={props.render} value={recipe.render}
              basePath="render" ctx={ctx} />
            <div className="group-name">Diffusion</div>
            <SchemaSection schema={props.diffusion} value={recipe.diffusion}
              basePath="diffusion" tier="primary" ctx={ctx} />
            <div className="group-name">Lyrics</div>
            <SchemaCard schema={props.lyrics} value={recipe.lyrics}
              basePath="lyrics" ctx={ctx} />
          </>
        )}

        {tab === "emitters" && (
          <>
            {(recipe.emitters ?? []).map((em: any, i: number) => (
              <details key={em.id} className="emitter-card" open={i === 0}>
                <summary>
                  <span className={`em-dot ${em.enabled === false ? "off" : ""}`} />
                  {em.id}
                  <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>
                    {em.trigger?.type}{em.trigger?.type === "onset" ? `·${em.trigger?.band}` : ""}
                  </span>
                  <button className="btn ghost slim" style={{ marginLeft: "auto" }}
                    onClick={(e) => { e.preventDefault();
                      ctx.onSet(`emitters.${i}.enabled`, em.enabled === false); }}>
                    {em.enabled === false ? "unmute" : "mute"}
                  </button>
                  <button className="btn ghost slim" onClick={(e) => {
                    e.preventDefault();
                    p.onReplaceRecipe({ ...recipe,
                      emitters: recipe.emitters.filter((_: any, k: number) => k !== i) },
                      () => {});
                  }}>✕</button>
                </summary>
                <div className="em-grid">
                  <div>
                    <div className="group-name">Trigger</div>
                    <SchemaSection schema={props.emitters?.items?.properties?.trigger}
                      value={em.trigger} basePath={`emitters.${i}.trigger`}
                      tier="primary" ctx={ctx} />
                    <SchemaSection schema={props.emitters?.items?.properties?.trigger}
                      value={em.trigger} basePath={`emitters.${i}.trigger`}
                      tier="advanced" ctx={ctx} />
                  </div>
                  <div>
                    <div className="group-name">Placement</div>
                    <SchemaSection schema={props.emitters?.items?.properties?.placement}
                      value={em.placement} basePath={`emitters.${i}.placement`}
                      tier="primary" ctx={ctx} />
                    <Pad2D placement={em.placement} aspect={ctx.canvasAspect}
                      onChange={(pl) => ctx.onSet(`emitters.${i}.placement`, pl)} />
                  </div>
                </div>
                <div className="group-name">Color</div>
                <SchemaSection schema={props.emitters?.items?.properties?.color}
                  value={em.color} basePath={`emitters.${i}.color`}
                  tier="primary" ctx={ctx} />
                <div className="group-name">Body</div>
                <SchemaCard schema={props.emitters?.items?.properties?.body}
                  value={em.body} basePath={`emitters.${i}.body`} ctx={ctx} />
              </details>
            ))}
            <div className="preset-row" style={{ marginTop: 10 }}>
              {Object.entries(EMITTER_TEMPLATES).map(([name, tpl]) => (
                <button key={name} className="btn ghost slim" onClick={() => {
                  const id = name.replace(/\s+/g, "_") + "_" +
                    (recipe.emitters.length + 1);
                  p.onReplaceRecipe({ ...recipe,
                    emitters: [...recipe.emitters, { id, ...structuredClone(tpl) }] },
                    () => {});
                }}>+ {name}</button>
              ))}
            </div>
          </>
        )}

        {tab === "motion" && (
          <>
            <div className="group-name">Modulators (audio → parameter)</div>
            {(recipe.modulators ?? []).map((m: any, i: number) => (
              <div key={i} className="mod-row">
                <select value={m.source}
                  onChange={(e) => ctx.onSet(`modulators.${i}.source`, e.target.value)}>
                  {SIGNALS.map((s) => <option key={s}>{s}</option>)}
                </select>
                <span className="muted">→</span>
                <select value={m.target}
                  onChange={(e) => ctx.onSet(`modulators.${i}.target`, e.target.value)}>
                  {[m.target, ...targets.filter((t) => t !== m.target)].map(
                    (t) => <option key={t}>{t}</option>)}
                </select>
                <input type="number" step={0.1} value={m.range?.[0] ?? 0}
                  onChange={(e) => ctx.onSet(`modulators.${i}.range`,
                    [parseFloat(e.target.value) || 0, m.range?.[1] ?? 1])} />
                <input type="number" step={0.1} value={m.range?.[1] ?? 1}
                  onChange={(e) => ctx.onSet(`modulators.${i}.range`,
                    [m.range?.[0] ?? 0, parseFloat(e.target.value) || 0])} />
                <select value={m.mode ?? "absolute"}
                  onChange={(e) => ctx.onSet(`modulators.${i}.mode`, e.target.value)}>
                  <option>absolute</option><option>add</option><option>scale</option>
                </select>
                <button className="btn ghost slim" onClick={() =>
                  p.onReplaceRecipe({ ...recipe,
                    modulators: recipe.modulators.filter((_: any, k: number) => k !== i) },
                    () => {})}>✕</button>
              </div>
            ))}
            <button className="btn ghost slim" style={{ marginTop: 8 }}
              onClick={() => p.onReplaceRecipe({ ...recipe, modulators: [
                ...(recipe.modulators ?? []),
                { source: "rms", target: targets[0] ?? "field.vorticity",
                  range: [0, 1], mode: "scale" }] }, () => {})}>
              + modulator
            </button>
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              absolute = the signal owns the target · add/scale = move around the
              segment's base value.
            </p>

            <div className="group-name" style={{ marginTop: 16 }}>
              Timeline (time-anchored accents)</div>
            {(project.timeline ?? []).map((d, i) => (
              <div key={i} className="tl-row">
                <input type="text" style={{ width: 90 }}
                  value={String(d.at ?? (d.between ? d.between.join("–") : ""))}
                  title='seconds or "section:drop+4" / "beat:32"'
                  onChange={(e) => {
                    const v = e.target.value;
                    const num = parseFloat(v);
                    const tl = [...project.timeline];
                    tl[i] = { ...d, at: isNaN(num) || String(num) !== v.trim() ? v : num };
                    p.onSetTimeline(tl);
                  }} />
                <span className="muted">{d.action}</span>
                {d.action === "spawn" && <span className="muted">×{d.count ?? 1}
                  {d.emitter ? ` (${d.emitter})` : ""}</span>}
                {d.action === "set" && <span className="muted">
                  {Object.keys(d.set ?? {}).join(", ")}</span>}
                <button className="btn ghost slim" style={{ marginLeft: "auto" }}
                  onClick={() => p.onSetTimeline(
                    project.timeline.filter((_, k) => k !== i))}>✕</button>
              </div>
            ))}
            <div className="preset-row" style={{ marginTop: 8 }}>
              <button className="btn ghost slim" onClick={() => p.onSetTimeline([
                ...(project.timeline ?? []),
                { at: 2.0, action: "spawn", emitter: recipe.emitters?.[0]?.id,
                  count: 3, mag: 1.0,
                  placement: { type: "line", points: [[0.25, 0.5], [0.75, 0.5]] } },
              ])}>+ spawn</button>
              <button className="btn ghost slim" onClick={() => p.onSetTimeline([
                ...(project.timeline ?? []),
                { between: [2.0, 6.0], action: "set",
                  set: { "field.vorticity": 40 }, fade_s: 0.5 },
              ])}>+ set window</button>
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              Anchors adapt to the track: try <code>section:drop</code> or{" "}
              <code>beat:32</code>. Unbound anchors are skipped with a warning.
            </p>
          </>
        )}

        {tab === "yaml" && (
          <>
            <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              The full recipe + project timeline — total control, schema-validated
              on apply.
            </p>
            <textarea className="yaml" value={yamlText}
              onChange={(e) => setYamlText(e.target.value)} spellCheck={false} />
            {yamlErr && <p className="err">{yamlErr}</p>}
            <button className="btn ghost" onClick={applyYaml}>Apply</button>
          </>
        )}
      </div>
    </div>
  );
}
