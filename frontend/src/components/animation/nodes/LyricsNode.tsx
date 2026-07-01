import type { ChangeEvent } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import { ParamRow } from "./FluidParamRow";
import ArgInfo from "./ArgInfo";
import { patchNodeData } from "../../../lib/graphModel";
import { LYRICS_PARAMS } from "../../../lib/nodeParams";
import type { NodeProps } from "./nodeProps";
import type { LyricsData, LyricsAlign, LyricsCase, LyricsPosition, LyricsReveal } from "../../../lib/types";

// Lyrics source: burns the segment's ALIGNED lyrics into the frame, timed to the
// vocal (→ video). No input; the lyric lines ride in from the project (ctx.lyricLines).
// With reveal="word" the active line fills in word-by-word. size/colour/opacity are
// modulatable ports.
const POSITIONS: LyricsPosition[] = ["top", "center", "bottom"];
const ALIGNS: LyricsAlign[] = ["left", "center", "right"];
const CASES: LyricsCase[] = ["none", "upper", "lower"];
const REVEALS: LyricsReveal[] = ["line", "word"];

export default function LyricsNode({ node, selected, helpers, ctx, onGraphChange, onDetach, onDelete }: NodeProps) {
  const d = node.data as LyricsData;
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
        {sel("position", "position", POSITIONS)}
        {sel("align", "align", ALIGNS)}
        {sel("case", "case", CASES)}
        {sel("reveal", "reveal", REVEALS)}
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
