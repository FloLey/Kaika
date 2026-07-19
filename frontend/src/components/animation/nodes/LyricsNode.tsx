import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import { ParamRow } from "./FluidParamRow";
import Ctl, { Toggle } from "../../../ui/Ctl";
import ArgInfo from "./ArgInfo";
import { videoSource } from "../../../lib/graphModel";
import { useNodeData } from "./useNodeData";
import { dp2 } from "./nodeConstants";
import { argHelp } from "../../../lib/paramHelp";
import { LYRICS_PARAMS } from "../../../lib/nodeParams";
import { aspectOf } from "../../../lib/output";
import { useLyricsFont } from "../../../lib/lyricsFont";
import { listFonts, type FontOption } from "../../../lib/api";
import BoxPad, { type BoxPreview } from "./BoxPad";
import StreamPreview from "./StreamPreview";
import LyricsEditor from "../LyricsEditor";
import type { NodeProps } from "./nodeProps";
import type { LyricsData, LyricsAlign, LyricsCase, LyricsReveal } from "../../../lib/types";

// Lyrics source: burns the segment's ALIGNED lyrics into the frame, timed to the
// vocal (→ video). No input; the lyric lines ride in from the project (ctx.lyricLines).
// With reveal="word" the active line fills in word-by-word. Text word-wraps and
// auto-fits the box; a black outline keeps it readable. size/colour/opacity are ports.
const ALIGNS: LyricsAlign[] = ["left", "center", "right"];
const CASES: LyricsCase[] = ["none", "upper", "lower"];
const REVEALS: LyricsReveal[] = ["line", "word"];

interface LyricLine {
  t0?: number;
  t1?: number;
  text?: string;
}
const applyCase = (t: string, c: LyricsCase) =>
  c === "upper" ? t.toUpperCase() : c === "lower" ? t.toLowerCase() : t;

// The lyric text visible at song time `t` — mirrors backend sources.lyrics: the active
// line, and (reveal="word") only the words revealed so far over its [t0, t1].
function textAtTime(lines: LyricLine[], t: number, reveal: LyricsReveal, c: LyricsCase): string {
  const line = lines.find((l) => (l.t0 ?? 0) <= t && t < (l.t1 ?? 0));
  if (!line || !line.text) return "";
  let text = applyCase(line.text.trim(), c);
  if (reveal === "word") {
    const words = text.split(/\s+/).filter(Boolean);
    const t0 = line.t0 ?? 0;
    const t1 = Math.max(t0 + 0.1, line.t1 ?? t0 + 1);
    const frac = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
    text = words.slice(0, Math.max(1, Math.ceil(frac * words.length))).join(" ");
  }
  return text;
}

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

export default function LyricsNode({
  node,
  selected,
  helpers,
  ctx,
  onGraphChange,
  onDetach,
  onDelete,
}: NodeProps) {
  const d = node.data as LyricsData;
  const fonts = useFonts();
  const set = useNodeData<LyricsData>(node, onGraphChange);
  const lineCount = (ctx?.lyricLines || []).length;
  const [editorOpen, setEditorOpen] = useState(false);
  // A `color` card can drive the fill and/or the outline colour (else white / black).
  const fillWired = useMemo(
    () => !!(ctx?.graph && videoSource(ctx.graph, node.id, "fillColor")),
    [ctx?.graph, node.id]
  );
  const outlineWired = useMemo(
    () => !!(ctx?.graph && videoSource(ctx.graph, node.id, "outlineColor")),
    [ctx?.graph, node.id]
  );

  const sel = <K extends keyof LyricsData>(label: string, key: K, opts: readonly string[]) => (
    <label className="anim-select-row">
      <span className="anim-select-label">{label}</span>
      <ArgInfo type="lyrics" k={key as string} />
      <select
        className="anim-select"
        value={d[key] as string}
        onChange={(e: ChangeEvent<HTMLSelectElement>) =>
          set({ [key]: e.target.value } as Partial<LyricsData>)
        }
      >
        {opts.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );

  const aspect = ctx?.output ? aspectOf(ctx.output) : "1 / 1";
  const family = useLyricsFont(d.font);
  // The preview plays the reveal off the shared clock (see BoxPad): `getText(t)` gives the
  // revealed text at song time t; when paused it shows `idleText` (the longest line so the
  // box can be sized safely, else a sample when the track has no lyrics).
  const lines = useMemo(() => (ctx?.lyricLines || []) as LyricLine[], [ctx?.lyricLines]);
  const getText = useCallback(
    (t: number) => textAtTime(lines, t, d.reveal, d.case),
    [lines, d.reveal, d.case]
  );
  const idleText = useMemo(() => {
    let t = "";
    for (const l of lines) if (l?.text && l.text.length > t.length) t = l.text;
    return applyCase(t || "Aa Bb Cc", d.case);
  }, [lines, d.case]);
  // Stable identity so the preview's rAF loop doesn't tear down every render.
  const preview = useMemo<BoxPreview>(
    () => ({
      getText,
      idleText,
      fontFamily: family,
      align: d.align,
      outline: d.outline,
      outlineWidth: d.outlineWidth,
      clock: ctx?.groupClock,
      playing: !!ctx?.groupPlaying,
      time0: ctx?.segStart ?? 0,
    }),
    [
      getText,
      idleText,
      family,
      d.align,
      d.outline,
      d.outlineWidth,
      ctx?.groupClock,
      ctx?.groupPlaying,
      ctx?.segStart,
    ]
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
      {/* The live rendered output — the lyrics revealing on the vocal exactly as they
          export. Suppressed in the settings window (its right column shows it). */}
      <StreamPreview node={node} ctx={ctx} aspect={aspect} />
      <div className="anim-fx-hint anim-lyrics-lines">
        <span>
          {lineCount > 0
            ? `${lineCount} aligned line${lineCount === 1 ? "" : "s"} for this track`
            : "no aligned lyrics for this track"}
        </span>
        {ctx?.onSaveLyricLines && lineCount > 0 && (
          <button
            className="btn sm no-drag"
            onClick={() => setEditorOpen(true)}
            title="Edit the words and start/end time of each line"
          >
            ✎ edit lines
          </button>
        )}
      </div>
      {editorOpen && ctx?.onSaveLyricLines && (
        <LyricsEditor
          lines={lines}
          onSave={ctx.onSaveLyricLines}
          onClose={() => setEditorOpen(false)}
        />
      )}
      {/* Fill / outline colour: wire a `color` card here to drive them (else white / black).
          The outline stays opaque whatever its colour, so it keeps the text readable. */}
      <div className="anim-pos-row">
        <Port
          kind="in"
          flow="color"
          nodeId={node.id}
          portId="fillColor"
          portRef={helpers.portRef}
          title="wire a color card to set the text fill colour"
        />
        <span className="anim-pos-label">fill color</span>
        <span className="anim-pos-count">{fillWired ? "wired" : "white"}</span>
      </div>
      <div className="anim-pos-row">
        <Port
          kind="in"
          flow="color"
          nodeId={node.id}
          portId="outlineColor"
          portRef={helpers.portRef}
          title="wire a color card to set the outline colour"
        />
        <span className="anim-pos-label">outline color</span>
        <span className="anim-pos-count">{outlineWired ? "wired" : "black"}</span>
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
        {sel("align", "align", ALIGNS)}
        {sel("case", "case", CASES)}
        {sel("reveal", "reveal", REVEALS)}
        <div className="anim-mod-remap">
          <span className="anim-mod-remap-label">
            text box <ArgInfo type="lyrics" k="box" />
          </span>
          <BoxPad
            box={{ x: d.box_x, y: d.box_y, w: d.box_w, h: d.box_h }}
            aspect={aspect}
            onChange={(b) => set({ box_x: b.x, box_y: b.y, box_w: b.w, box_h: b.h })}
            preview={preview}
          />
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
