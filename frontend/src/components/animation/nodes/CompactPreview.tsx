import ValuePreview from "./ValuePreview";
import PointsPad from "./PointsPad";
import StreamPreview from "./StreamPreview";
import { useResolvedPoints } from "./useResolvedPoints";
import { patternPoints } from "../../../lib/pointsGen";
import { aspectOf } from "../../../lib/output";
import type { NodeCtx } from "./nodeProps";
import type {
  BackdropData,
  ColorData,
  GraphNode,
  ImagegenData,
  PatternData,
  PointsData,
} from "../../../lib/types";

// The live preview inside a CompactCard's body — one glance at what the card produces,
// switched on node.type: value cards pulse, points cards scatter, and every VIDEO producer
// (fluid, combine, transform, image, video, slideshow, lyrics) streams its REAL rendered
// output — the same block-render the Output card uses — so the card shows exactly what it
// puts out. Output never compacts (its body IS the render). Heavy previews are
// viewport-gated inside.

// Value cards preview their REAL resolved 0..1 output (same `/resolve` the Scope and
// full cards use) as a pulsing pad — so a compact signal reads as "alive" and can't
// drift from what renders.
const VALUE_TYPES = new Set(["signal", "lfo", "noise", "shaper", "gate", "math", "scope"]);

// Cards whose output is VIDEO — their preview is a live block-stream of the actual render
// (not a client-side approximation), so a slideshow advances / lyrics reveal / a layer is
// placed exactly as it will export. Backdrop stays a swatch (its output IS a flat colour);
// output never compacts. Exported so `registry.test.tsx` can assert a new video card was
// added here too — a missing entry renders a BLANK compact body, which is easy to miss.
export const VIDEO_TYPES = new Set([
  "fluid",
  "combine",
  "transform",
  "image",
  "video",
  "slideshow",
  "lyrics",
]);

// animate/merge points depend on upstream + transforms, so their scatter is resolved
// from the backend (hooks can't be conditional — split into its own component).
function ResolvedPointsPreview({ node, ctx }: { node: GraphNode; ctx: NodeCtx }) {
  const depKey = ctx?.graph ? JSON.stringify([ctx.graph.nodes, ctx.graph.edges]) : "";
  const { points } = useResolvedPoints(ctx, node.id, depKey);
  return <PointsPad points={points} aspect={ctx?.output ? aspectOf(ctx.output) : "1 / 1"} compact />;
}

// ---- colour helpers (mirrors ColorNode's swatch math, kept tiny) ----------------
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const hex2 = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");
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
  // swatch / rgb: the const channel values (a wired channel just shows its default).
  return `#${hex2(constVal(d, "r", 1))}${hex2(constVal(d, "g", 1))}${hex2(constVal(d, "b", 1))}`;
};

interface CompactPreviewProps {
  node: GraphNode;
  ctx: NodeCtx;
  accent: string;
}

export default function CompactPreview({ node, ctx, accent }: CompactPreviewProps) {
  if (VALUE_TYPES.has(node.type)) {
    return <ValuePreview node={node} ctx={ctx} color={accent} compact />;
  }
  const aspect = ctx?.output ? aspectOf(ctx.output) : "1 / 1";
  if (VIDEO_TYPES.has(node.type)) {
    return <StreamPreview node={node} ctx={ctx} aspect={aspect} compact />;
  }
  switch (node.type) {
    case "color":
      return (
        <div
          className="anim-compact-swatch"
          style={{ background: colorCss(node.data as ColorData) }}
        />
      );
    case "backdrop":
      return (
        <div
          className="anim-compact-swatch"
          style={{ background: (node.data as BackdropData).color }}
        />
      );
    case "imagegen": {
      const d = node.data as ImagegenData;
      const n = (d.prompts || []).filter((p) => p.trim()).length;
      const urls = d.assetUrls || [];
      return urls.length ? (
        <span className="anim-compact-thumbwrap">
          <img className="anim-compact-thumb" src={urls[0]} alt="" draggable={false} />
          <span className="anim-compact-count">×{urls.length}</span>
        </span>
      ) : (
        <span className="anim-compact-hint">{n ? `${n} prompt${n === 1 ? "" : "s"}` : "no prompts"}</span>
      );
    }
    case "points":
      return <PointsPad points={(node.data as PointsData).points || []} aspect={aspect} compact />;
    case "pattern":
      return <PointsPad points={patternPoints(node.data as PatternData)} aspect={aspect} compact />;
    case "animate-points":
    case "merge-points":
      return <ResolvedPointsPreview node={node} ctx={ctx} />;
    default:
      return null; // output never compacts (its body IS the render)
  }
}
