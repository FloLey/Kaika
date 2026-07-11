import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import { Toggle } from "../../../ui/Ctl";
import { ParamRow } from "./FluidParamRow";
import ArgInfo from "./ArgInfo";
import StreamPreview from "./StreamPreview";
import { useNodeData } from "./useNodeData";
import { argHelp } from "../../../lib/paramHelp";
import { aspectOf } from "../../../lib/output";
import { STYLIZE_PARAMS } from "../../../lib/nodeParams";
import { stylizeClip, pollJob } from "../../../lib/api";
import { jobIdOf } from "./nodeProps";
import type { NodeProps } from "./nodeProps";
import type { Asset, StylizeData } from "../../../lib/types";

// The AI Stylize video-FX card: one video in, one video out. It repaints the incoming
// fluid toward a prompt via img2img (`strength` = the keep↔reinvent curseur, a modulatable
// port). `inpaint` confines the repaint to the fluid's shape. Generation is expensive, so
// it runs as a background job on the ✨ Generate button (not per-render): the result is a
// content-addressed clip stored on `assetUrl`; until then the card passes the fluid through.
const MODELS: { id: StylizeData["model"]; label: string }[] = [
  { id: "draft", label: "SD-Turbo — fast draft" },
  { id: "hd", label: "Z-Image — HD (slow)" },
];

export default function StylizeNode({
  node,
  selected,
  helpers,
  ctx,
  onGraphChange,
  onDetach,
  onDelete,
}: NodeProps) {
  const d = node.data as StylizeData;
  const set = useNodeData<StylizeData>(node, onGraphChange);
  const model = d.model || "draft";
  const jobId = jobIdOf(ctx?.job);

  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Progress: the worker sets the job step to "frame X/Y" per frame — parse it into a
  // 0..1 fraction for the bar (null for the indeterminate render/encode phases).
  const m = step?.match(/(\d+)\s*\/\s*(\d+)/);
  const frac = m ? Math.min(1, Number(m[1]) / Math.max(1, Number(m[2]))) : null;

  // Abort in-flight polls on unmount — the backend job keeps running (the clip still lands
  // as an asset), this card just stops polling + setState-ing.
  const pollAbort = useRef(new AbortController());
  useEffect(() => {
    const c = pollAbort.current;
    return () => c.abort();
  }, []);
  const isAbort = (ex: unknown) => ex instanceof DOMException && ex.name === "AbortError";

  const onGenerate = async () => {
    if (!jobId || busy || !ctx?.graph || !ctx?.segment) return;
    setBusy(true);
    setErr(null);
    setStep(null);
    try {
      const { job_id } = await stylizeClip(jobId, {
        graph: ctx.graph,
        segment: ctx.segment,
        output: ctx.output,
        node_id: node.id,
      });
      const result = await pollJob<{ assets: Asset[] }>(
        job_id,
        setStep,
        1500,
        pollAbort.current.signal
      );
      const url = result.assets?.[0]?.url;
      if (url) set({ assetUrl: url });
    } catch (ex) {
      if (!isAbort(ex)) setErr(ex instanceof Error ? ex.message : "stylize failed");
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  return (
    <NodeFrame
      node={node}
      title="ai stylize"
      accent="var(--fx)"
      selected={selected}
      onTitlePointerDown={helpers.onTitlePointerDown}
      onDelete={onDelete}
      sideIn={
        <Port
          kind="in"
          flow="video"
          nodeId={node.id}
          portId="video"
          portRef={helpers.portRef}
          title="video in — wire a fluid here"
        />
      }
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
      <StreamPreview node={node} ctx={ctx} aspect={ctx?.output ? aspectOf(ctx.output) : "1 / 1"} />

      <div className="anim-combine-row">
        <Port
          kind="in"
          flow="video"
          nodeId={node.id}
          portId="control"
          portRef={helpers.portRef}
          title="control in (optional) — wire an Extract card for ControlNet guidance"
        />
        <span className="anim-combine-slot">control (optional)</span>
      </div>

      <label className="anim-select-row no-drag">
        <span className="anim-select-label">model</span>
        <ArgInfo type="stylize" k="model" />
        <select
          className="anim-select"
          value={model}
          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
            set({ model: e.target.value as StylizeData["model"] })
          }
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <div className="anim-static">
        <Toggle
          label="inpaint — confine to the fluid"
          value={!!d.inpaint}
          onChange={(v) => set({ inpaint: v })}
          {...argHelp("stylize", "inpaint")}
        />
      </div>

      <div className="anim-imagegen-prompts no-drag">
        <textarea
          className="anim-imagegen-prompt"
          rows={2}
          value={d.prompt}
          placeholder="prompt…"
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => set({ prompt: e.target.value })}
          title={argHelp("stylize", "prompt").help}
        />
      </div>

      {STYLIZE_PARAMS.map((p) => (
        <ParamRow
          key={p.key}
          node={node}
          param={p}
          helpers={helpers}
          onGraphChange={onGraphChange}
          onDetach={(key) => onDetach?.(node.id, key)}
        />
      ))}

      <button
        className="btn sm on anim-imagegen-generate"
        onClick={onGenerate}
        disabled={busy || !jobId}
        title="Generate the stylized clip locally (first use of a model downloads it)"
      >
        {busy ? step || "stylizing…" : d.assetUrl ? "↻ regenerate" : "✨ generate"}
      </button>
      {busy && (
        <div
          className="no-drag"
          style={{
            marginTop: 6,
            height: 6,
            background: "var(--line)",
            borderRadius: 3,
            overflow: "hidden",
          }}
          title={step || "stylizing…"}
        >
          <div
            style={{
              height: "100%",
              width: `${(frac ?? 0.06) * 100}%`,
              background: "var(--fx)",
              transition: "width .2s linear",
            }}
          />
        </div>
      )}
      {err && <div className="anim-asset-err">{err}</div>}
    </NodeFrame>
  );
}
