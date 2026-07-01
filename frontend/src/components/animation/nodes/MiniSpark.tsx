// A tiny static sparkline (SVG) used by the modulator cards to preview a generator's
// shape. Stretches the 0..1 curve to fill its box; the stroke stays crisp at any size.
interface MiniSparkProps {
  values: number[];
  accent?: string;
}

export default function MiniSpark({ values, accent = "var(--mod)" }: MiniSparkProps) {
  const n = values.length;
  if (n < 2) return <div className="anim-mini-spark" />;
  const pts = values
    .map((v, i) => `${(i / (n - 1)) * 100},${(1 - Math.max(0, Math.min(1, v))) * 100}`)
    .join(" ");
  return (
    <svg
      className="anim-mini-spark"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline
        points={pts}
        fill="none"
        stroke={accent}
        strokeWidth={2}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
