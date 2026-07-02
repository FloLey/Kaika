import { useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import { ParamRow } from "./FluidParamRow";
import Ctl, { Toggle } from "../../../ui/Ctl";
import ArgInfo from "./ArgInfo";
import { patchNodeData } from "../../../lib/graphModel";
import { argHelp } from "../../../lib/paramHelp";
import { LYRICS_PARAMS } from "../../../lib/nodeParams";
import { listFonts, type FontOption } from "../../../lib/api";
import type { NodeProps } from "./nodeProps";
import type { LyricsData, LyricsAlign, LyricsCase, LyricsPosition, LyricsReveal } from "../../../lib/types";

// Lyrics source: burns the segment's ALIGNED lyrics into the frame, timed to the
// vocal (→ video). No input; the lyric lines ride in from the project (ctx.lyricLines).
// With reveal="word" the active line fills in word-by-word. Text word-wraps and
// auto-fits the box; a black outline keeps it readable. size/colour/opacity are ports.
const POSITIONS: LyricsPosition[] = ["top", "center", "bottom"];
const ALIGNS: LyricsAlign[] = ["left", "center", "right"];
const CASES: LyricsCase[] = ["none", "upper", "lower"];
const REVEALS: LyricsReveal[] = ["line", "word"];
const dp2 = (v: number) => v.toFixed(2);

// The bundled fonts are fetched once (GET /fonts) and shared across every lyrics node.
// Falls back to just the default so the card still renders offline / in tests.
const FALLBACK_FONTS: FontOption[] = [{ key: "inter", label: "Inter" }];
let fontsCache: FontOption[] | null = null;
let fontsPromise: Promise<FontOption[]> | null = null;

function useFonts(): FontOption[] {
  const [fonts, setFonts] = useState<FontOption[]>(fontsCache ?? FALLBACK_FONTS);
  useEffect(() => {
    if (fontsCache) return;
    fontsPromise ??= listFonts()
      .then((f) => (fontsCache = f.length ? f : FALLBACK_FONTS))
      .catch(() => FALLBACK_FONTS);
    let alive = true;
    fontsPromise.then((f) => alive && setFonts(f));
    return () => {
      alive = false;
    };
  }, []);
  return fonts;
}

export default function LyricsNode({ node, selected, helpers, ctx, onGraphChange, onDetach, onDelete }: NodeProps) {
  const d = node.data as LyricsData;
  const fonts = useFonts();
  const set = (patch: Partial<LyricsData>) =>
    onGraphChange((g) => patchNodeData(g, node.id, patch as Record<string, unknown>));
  const lineCount = (ctx?.lyricLines || []).length;

  const sel = <K extends keyof LyricsData>(label: string, key: K, opts: readonly string[]) => (
    <label className="anim-select-row">
      <span className="anim-select-label">{label}</span>
      <ArgInfo type="lyrics" k={key as string} />
      <select
        className="anim-select"
        value={d[key] as string}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => set({ [key]: e.target.value } as Partial<LyricsData>)}
      >
        {opts.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );

  const box = (label: string, key: "box_x" | "box_y" | "box_w" | "box_h", min: number) => (
    <Ctl
      label={label}
      value={d[key]}
      min={min}
      max={1}
      step={0.01}
      fmt={dp2}
      onChange={(v) => set({ [key]: v } as Partial<LyricsData>)}
      {...argHelp("lyrics", key)}
    />
  );

  return (
    <NodeFrame
      node={node}
      title="lyrics"
      accent="var(--courant)"
      selected={selected}
      onTitlePointerDown={helpers.onTitlePointerDown}
      onDelete={onDelete}
      sideOut={
        <Port
          kind="out"
          flow="video"
          nodeId={node.id}
          portId="out"
          portRef={helpers.portRef}
          startConnect={helpers.startConnect}
          title="video out"
        />
      }
    >
      <div className="anim-fx-hint">
        {lineCount > 0 ? `${lineCount} aligned line${lineCount === 1 ? "" : "s"} for this track` : "no aligned lyrics for this track"}
      </div>
      <div className="anim-static">
        <label className="anim-select-row">
          <span className="anim-select-label">font</span>
          <ArgInfo type="lyrics" k="font" />
          <select
            className="anim-select"
            value={d.font}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => set({ font: e.target.value })}
          >
            {fonts.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        {sel("position", "position", POSITIONS)}
        {sel("align", "align", ALIGNS)}
        {sel("case", "case", CASES)}
        {sel("reveal", "reveal", REVEALS)}
        <div className="anim-mod-remap">
          <span className="anim-mod-remap-label">text box</span>
          {box("x", "box_x", 0)}
          {box("y", "box_y", 0)}
          {box("w", "box_w", 0.1)}
          {box("h", "box_h", 0.1)}
        </div>
        <Toggle
          label="outline"
          value={d.outline}
          onChange={(v) => set({ outline: v })}
          {...argHelp("lyrics", "outline")}
        />
        <Ctl
          label="outline width"
          value={d.outlineWidth}
          min={0}
          max={0.4}
          step={0.01}
          fmt={dp2}
          onChange={(v) => set({ outlineWidth: v })}
          {...argHelp("lyrics", "outlineWidth")}
        />
      </div>
      {LYRICS_PARAMS.map((p) => (
        <ParamRow
          key={p.key}
          node={node}
          param={p}
          helpers={helpers}
          onGraphChange={onGraphChange}
          onDetach={(key) => onDetach?.(node.id, key)}
        />
      ))}
    </NodeFrame>
  );
}
