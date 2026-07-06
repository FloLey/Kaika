import MiniSpark from "./MiniSpark";
import { useResolvedCurve } from "./useResolvedCurve";
import { assetName } from "./useAssetUpload";
import type { NodeCtx } from "./nodeProps";
import type {
  BackdropData,
  ColorData,
  GraphNode,
  ImageData,
  ImagegenData,
  LyricsData,
  PatternData,
  PointsData,
  VideoData,
} from "../../../lib/types";

// The tiny live preview inside a CompactCard's body — one cheap glance at what the
// card produces, switched on node.type. Deliberately LIGHT: no <video> elements, no
// param rows, no per-frame clocks; the full card (settings modal / expanded view) owns
// the rich preview. Types with nothing cheap to show (fluid, combine, output…) render
// null — the compact body stays a clickable title-only strip.

// Value cards preview their REAL resolved 0..1 curve (same `/resolve` the Scope and
// full cards use), so the compact sparkline can't drift from what renders.
const VALUE_TYPES = new Set(["signal", "lfo", "noise", "shaper", "gate", "math", "scope"]);

// Split out so the hook only mounts for value cards (hooks can't be conditional).
function SparkPreview({ node, ctx, accent }: { node: GraphNode; ctx: NodeCtx; accent: string }) {
  const { curve } = useResolvedCurve(ctx, node.id, JSON.stringify(node.data));
  return <MiniSpark values={curve} accent={accent} />;
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
    return <SparkPreview node={node} ctx={ctx} accent={accent} />;
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
    case "image": {
      const d = node.data as ImageData;
      return d.assetUrl ? (
        <img className="anim-compact-thumb" src={d.assetUrl} alt="" draggable={false} />
      ) : (
        <span className="anim-compact-hint">no image</span>
      );
    }
    case "imagegen": {
      const urls = (node.data as ImagegenData).assetUrls || [];
      return urls.length ? (
        <span className="anim-compact-thumbwrap">
          <img className="anim-compact-thumb" src={urls[0]} alt="" draggable={false} />
          <span className="anim-compact-count">×{urls.length}</span>
        </span>
      ) : (
        <span className="anim-compact-hint">no images</span>
      );
    }
    case "video": {
      const d = node.data as VideoData;
      return (
        <span className="anim-compact-hint">
          🎞 {d.assetUrl ? assetName(d.assetUrl) : "no video"}
        </span>
      );
    }
    case "lyrics": {
      // The longest aligned line as a one-line snippet (what the card burns in).
      const lines = (ctx.lyricLines || []) as { text?: string }[];
      let snippet = "";
      for (const l of lines) if (l?.text && l.text.length > snippet.length) snippet = l.text;
      const d = node.data as LyricsData;
      const cased =
        d.case === "upper" ? snippet.toUpperCase() : d.case === "lower" ? snippet.toLowerCase() : snippet;
      return <span className="anim-compact-lyric">{cased || "no lyrics"}</span>;
    }
    case "points":
      return (
        <span className="anim-compact-hint">
          ⁘ {((node.data as PointsData).points || []).length} pts
        </span>
      );
    case "pattern":
      return <span className="anim-compact-hint">⁘ {(node.data as PatternData).count} pts</span>;
    case "animate-points":
    case "merge-points":
      return <span className="anim-compact-hint">⁘</span>;
    default:
      return null; // fluid / combine / output…: title-only compact body
  }
}
