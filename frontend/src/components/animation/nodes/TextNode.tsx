import { useMemo, useState, useEffect } from "react";
import type { ChangeEvent } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import { ParamRows } from "./FluidParamRow";
import Ctl, { Toggle } from "../../../ui/Ctl";
import ArgInfo from "./ArgInfo";
import { videoSource } from "../../../lib/graphModel";
import { useNodeData } from "./useNodeData";
import { dp2, pct } from "./nodeConstants";
import { argHelp } from "../../../lib/paramHelp";
import { TEXT_PARAMS } from "../../../lib/nodeParams";
import { ctxAspect } from "../../../lib/output";
import { useLyricsFont } from "../../../lib/lyricsFont";
import { listFonts, type FontOption } from "../../../lib/api";
import BoxPad, { type BoxPreview } from "./BoxPad";
import StreamPreview from "./StreamPreview";
import type { NodeProps } from "./nodeProps";
import type { TextData, LyricsAlign, LyricsCase } from "../../../lib/types";

// The TEXT card — a free-typed caption placed like an Instagram sticker (→ video).
// The lyrics pipeline renders it (same wrap/fit/outline/colour machinery) as one
// always-on line whose text lives in the card's data. Combine it over anything;
// opacity is the modulatable port, fill/outline colours come from wired color cards.
const ALIGNS: LyricsAlign[] = ["left", "center", "right"];
const CASES: LyricsCase[] = ["none", "upper", "lower"];

const applyCase = (t: string, c: LyricsCase) =>
  c === "upper" ? t.toUpperCase() : c === "lower" ? t.toLowerCase() : t;

// Bundled fonts, fetched once (same cache discipline as LyricsNode's useFonts —
// kept local: the two cards share the ENDPOINT, not component state).
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

export default function TextNode({
  node,
  selected,
  helpers,
  ctx,
  onGraphChange,
  onDetach,
  onDelete,
}: NodeProps) {
  const d = node.data as TextData;
  const fonts = useFonts();
  const set = useNodeData<TextData>(node, onGraphChange);
  const fillWired = useMemo(
    () => !!(ctx?.graph && videoSource(ctx.graph, node.id, "fillColor")),
    [ctx?.graph, node.id]
  );
  const outlineWired = useMemo(
    () => !!(ctx?.graph && videoSource(ctx.graph, node.id, "outlineColor")),
    [ctx?.graph, node.id]
  );

  const sel = <K extends keyof TextData>(label: string, key: K, opts: readonly string[]) => (
    <label className="anim-select-row">
      <span className="anim-select-label">{label}</span>
      <ArgInfo type="text" k={key as string} />
      <select
        className="anim-select"
        value={d[key] as string}
        onChange={(e: ChangeEvent<HTMLSelectElement>) =>
          set({ [key]: e.target.value } as Partial<TextData>)
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

  const aspect = ctxAspect(ctx);
  const family = useLyricsFont(d.font);
  // Sizing mode, derived exactly like the lyrics card's (equal clamps = fixed).
  const hasMin = d.sizeMin != null && d.sizeMin > 0;
  const hasMax = d.sizeMax != null && d.sizeMax < 1;
  const sizeMode =
    hasMin && hasMax && d.sizeMin === d.sizeMax ? "fixed" : hasMin || hasMax ? "minmax" : "auto";

  // The WYSIWYG box preview: static text (no clock — a caption doesn't reveal).
  const shown = applyCase(d.text || "Your text", d.case);
  const preview = useMemo<BoxPreview>(
    () => ({
      getText: () => shown,
      idleText: shown,
      fontFamily: family,
      align: d.align,
      outline: d.outline,
      outlineWidth: d.outlineWidth,
      sizeMin: d.sizeMin,
      sizeMax: d.sizeMax,
      time0: 0,
    }),
    [shown, family, d.align, d.outline, d.outlineWidth, d.sizeMin, d.sizeMax]
  );

  return (
    <NodeFrame
      node={node}
      title="text"
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
      {/* The live rendered output — exactly what exports. Suppressed in the
          settings window (its right column shows it). */}
      <StreamPreview node={node} ctx={ctx} aspect={aspect} />
      <label className="anim-select-row anim-text-row">
        <span className="anim-select-label">text</span>
        <ArgInfo type="text" k="text" />
        <textarea
          className="anim-text-input no-drag"
          rows={2}
          value={d.text}
          placeholder="Your text"
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => set({ text: e.target.value })}
        />
      </label>
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
          <ArgInfo type="text" k="font" />
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
        <div className="anim-mod-remap">
          <span className="anim-mod-remap-label">
            text box <ArgInfo type="text" k="box" />
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
          {...argHelp("text", "outline")}
        />
        <Ctl
          label="outline width"
          value={d.outlineWidth}
          min={0}
          max={0.4}
          step={0.01}
          fmt={dp2}
          onChange={(v) => set({ outlineWidth: v })}
          {...argHelp("text", "outlineWidth")}
        />
        <label className="anim-select-row">
          <span className="anim-select-label">size</span>
          <ArgInfo type="text" k="sizing" />
          <select
            className="anim-select"
            value={sizeMode}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => {
              const m = e.target.value;
              if (m === "auto") set({ sizeMin: 0, sizeMax: 1 });
              else if (m === "fixed") {
                const v = d.sizeMax && d.sizeMax < 1 ? d.sizeMax : 0.06;
                set({ sizeMin: v, sizeMax: v });
              } else {
                set({ sizeMin: d.sizeMin || 0.02, sizeMax: d.sizeMax || 0.12 });
              }
            }}
          >
            <option value="auto">auto (fit box)</option>
            <option value="fixed">fixed</option>
            <option value="minmax">min – max</option>
          </select>
        </label>
        {sizeMode === "fixed" && (
          <Ctl
            label="font size"
            value={d.sizeMax ?? 0.06}
            min={0.01}
            max={0.4}
            step={0.005}
            fmt={pct}
            onChange={(v) => set({ sizeMin: v, sizeMax: v })}
            {...argHelp("text", "sizeFixed")}
          />
        )}
        {sizeMode === "minmax" && (
          <>
            <Ctl
              label="min size"
              value={d.sizeMin ?? 0}
              min={0}
              max={0.3}
              step={0.005}
              fmt={pct}
              onChange={(v) => set({ sizeMin: v })}
              {...argHelp("text", "sizeMin")}
            />
            <Ctl
              label="max size"
              value={d.sizeMax ?? 1}
              min={0.05}
              max={1}
              step={0.01}
              fmt={pct}
              onChange={(v) => set({ sizeMax: v })}
              {...argHelp("text", "sizeMax")}
            />
          </>
        )}
      </div>
      <ParamRows
        params={TEXT_PARAMS}
        node={node}
        helpers={helpers}
        onGraphChange={onGraphChange}
        onDetach={onDetach}
      />
    </NodeFrame>
  );
}
