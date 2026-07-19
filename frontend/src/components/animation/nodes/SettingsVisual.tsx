import type { ReactNode } from "react";
import ValuePreview from "./ValuePreview";
import PointsPad from "./PointsPad";
import StreamPreview from "./StreamPreview";
import CompactPreview from "./CompactPreview";
import ImagegenGallery from "./ImagegenGallery";
import { useResolvedPoints } from "./useResolvedPoints";
import { patternPoints } from "../../../lib/pointsGen";
import { aspectOf } from "../../../lib/output";
import { VIDEO_TYPES } from "./CompactPreview";
import type { NodeCtx } from "./nodeProps";
import type {
  BackdropData,
  ColorData,
  GraphNode,
  ImagegenData,
  PatternData,
  PointsData,
} from "../../../lib/types";

// The settings window's RIGHT column: the card's single, LARGE, LIVE visual. Every VIDEO
// producer (fluid/combine/image/video/slideshow/lyrics + output) streams its REAL rendered
// output — the same block-render the Output card uses — so you see exactly what it exports
// (a slideshow advancing, lyrics revealing, a layer placed). Value cards show a centred
// pulse, points a scatter, colour/backdrop a swatch, imagegen a gallery. The card's own
// controls (box editor, drop zone, prompts…) stay in the LEFT column.

const VALUE_TYPES = new Set(["signal", "lfo", "noise", "shaper", "gate", "math", "scope"]);
// ONE list, shared with CompactPreview. It used to be a second literal here with six
// entries against that file's nineteen, so montage / transform / stylize / echo /
// colorgrade / the sim cards silently fell through to the `default` branch and only
// looked right by accident.

// ---- colour helpers (mirror ColorNode's swatch math; kept tiny, as in CompactPreview) ----
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const hex2 = (v: number) =>
  Math.round(clamp01(v) * 255)
    .toString(16)
    .padStart(2, "0");
const constVal = (d: ColorData, key: string, def: number) => {
  const b = d.ports?.[key]?.binding;
  return b && b.kind === "const" ? b.value : def;
};
const colorCss = (d: ColorData): string => {
  if (d.mode === "gradient") {
    const stops = [...(d.stops || [])]
      .sort((a, b) => a.t - b.t)
      .map((s) => `${s.color} ${Math.round(clamp01(s.t) * 100)}%`)
      .join(", ");
    return stops ? `linear-gradient(90deg, ${stops})` : "#ffffff";
  }
  return `#${hex2(constVal(d, "r", 1))}${hex2(constVal(d, "g", 1))}${hex2(constVal(d, "b", 1))}`;
};

// animate/merge points resolve from the backend (hooks can't be conditional).
function ResolvedPointsPreview({ node, ctx }: { node: GraphNode; ctx: NodeCtx }) {
  const depKey = ctx?.graph ? JSON.stringify([ctx.graph.nodes, ctx.graph.edges]) : "";
  const { points } = useResolvedPoints(ctx, node.id, depKey);
  return <PointsPad points={points} aspect={ctx?.output ? aspectOf(ctx.output) : "1 / 1"} />;
}

interface Props {
  node: GraphNode;
  ctx: NodeCtx;
  accent: string;
}

export default function SettingsVisual({ node, ctx, accent }: Props) {
  const aspect = ctx?.output ? aspectOf(ctx.output) : "1 / 1";
  const wrap = (mode: string, content: ReactNode) => (
    <div className={`sv sv-${mode}`}>{content}</div>
  );

  if (VALUE_TYPES.has(node.type)) {
    // The full curve + pulse pad, centred (a value card visualises a 0..1 scalar).
    return wrap("pad", <ValuePreview node={node} ctx={ctx} color={accent} />);
  }
  if (VIDEO_TYPES.has(node.type)) {
    // The real rendered output, filling the column at the project aspect.
    return wrap("fill", <StreamPreview node={node} ctx={ctx} aspect={aspect} />);
  }
  switch (node.type) {
    case "color":
      return wrap(
        "swatch",
        <div className="sv-color" style={{ background: colorCss(node.data as ColorData) }} />
      );
    case "backdrop":
      return wrap(
        "swatch",
        <div className="sv-color" style={{ background: (node.data as BackdropData).color }} />
      );
    case "points":
      return wrap(
        "fill",
        <PointsPad points={(node.data as PointsData).points || []} aspect={aspect} />
      );
    case "pattern":
      return wrap(
        "fill",
        <PointsPad points={patternPoints(node.data as PatternData)} aspect={aspect} />
      );
    case "animate-points":
    case "merge-points":
      return wrap("fill", <ResolvedPointsPreview node={node} ctx={ctx} />);
    case "imagegen": {
      const d = node.data as ImagegenData;
      const urls = (
        d.activeCount != null ? (d.assetUrls || []).slice(0, d.activeCount) : d.assetUrls || []
      ).filter(Boolean);
      return wrap("gallery", <ImagegenGallery urls={urls} />);
    }
    case "output":
      return wrap(
        "output",
        <>
          <StreamPreview node={node} ctx={ctx} aspect={aspect} />
          {ctx.setFinalOutput && (
            <button
              className={"anim-final-btn" + (ctx.finalOutputId === node.id ? " on" : "")}
              onClick={() => ctx.setFinalOutput?.(ctx.finalOutputId === node.id ? "" : node.id)}
              title={
                ctx.finalOutputId === node.id
                  ? "This output is the segment's final (exported) render — click to unmark"
                  : "Mark this output as the segment's final (exported) render"
              }
            >
              {ctx.finalOutputId === node.id ? "★ final" : "☆ mark final"}
            </button>
          )}
        </>
      );
    default:
      return wrap("fallback", <CompactPreview node={node} ctx={ctx} accent={accent} />);
  }
}
