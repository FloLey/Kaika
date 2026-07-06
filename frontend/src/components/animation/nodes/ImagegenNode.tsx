import { useState } from "react";
import type { ChangeEvent } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import Ctl from "../../../ui/Ctl";
import { useNodeData } from "./useNodeData";
import { argHelp } from "../../../lib/paramHelp";
import { generateImage, pollJob } from "../../../lib/api";
import { assetName } from "./useAssetUpload";
import type { NodeProps } from "./nodeProps";
import type { Asset, ImagegenData } from "../../../lib/types";

// The image GENERATOR: one prompt per image — the card shows how many it will make —
// generated locally (Stable Diffusion on the GPU job queue, seeded so prompt+seed
// reproduces) into content-addressed assets. It produces no video itself: wire its
// `images` output into a Slideshow card's `images` input and the generated list
// feeds the slideshow (after the slideshow's own picks).
export default function ImagegenNode({ node, selected, helpers, ctx, onGraphChange, onDelete }: NodeProps) {
  const d = node.data as ImagegenData;
  const set = useNodeData<ImagegenData>(node, onGraphChange);
  const prompts = d.prompts?.length ? d.prompts : [""];
  const generated = d.assetUrls || [];

  const setPrompt = (i: number, text: string) =>
    set({ prompts: prompts.map((p, k) => (k === i ? text : p)) });
  const addPrompt = () => set({ prompts: [...prompts, ""] });
  const removePrompt = (i: number) =>
    set({ prompts: prompts.length > 1 ? prompts.filter((_, k) => k !== i) : [""] });

  const job = ctx?.job;
  const jobId = typeof job === "string" ? job : (job as { job_id?: string } | undefined)?.job_id;
  const filled = prompts.map((p) => p.trim()).filter(Boolean);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const onGenerate = async () => {
    if (!jobId || !filled.length || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const { job_id } = await generateImage(jobId, filled, d.seed);
      const result = await pollJob<{ assets: Asset[] }>(job_id);
      const fresh = (result.assets || []).map((a) => a.url);
      // REPLACE the generated list (one image per prompt, in prompt order) and bump
      // the seed so the next ✨ gives new variations by default. Old images stay in
      // the 📚 library (content-addressed) if you want them back.
      set({ assetUrls: fresh, seed: d.seed + fresh.length });
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "generation failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <NodeFrame
      node={node}
      title="image gen"
      accent="var(--courant)"
      selected={selected}
      onTitlePointerDown={helpers.onTitlePointerDown}
      onDelete={onDelete}
      sideOut={
        <Port
          kind="out"
          flow="images"
          nodeId={node.id}
          portId="out"
          portRef={helpers.portRef}
          startConnect={helpers.startConnect}
          title="images out — wire into a Slideshow card"
        />
      }
    >
      <div className="anim-fx-hint">
        will generate <strong>{filled.length}</strong> image{filled.length === 1 ? "" : "s"} (one
        per prompt)
      </div>
      <div className="anim-imagegen-prompts no-drag">
        {prompts.map((p, i) => (
          <div className="anim-imagegen-prompt-row" key={i}>
            <input
              className="anim-imagegen-prompt"
              type="text"
              placeholder={`image ${i + 1} prompt…`}
              value={p}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setPrompt(i, e.target.value)}
              title={argHelp("imagegen", "prompts").help}
            />
            <button
              className="iconbtn"
              title="remove this prompt"
              onClick={() => removePrompt(i)}
            >
              ✕
            </button>
          </div>
        ))}
        <div className="anim-imagegen-gen">
          <button className="btn sm" onClick={addPrompt}>
            + prompt
          </button>
          <Ctl
            label="seed"
            value={d.seed}
            min={1}
            max={9999}
            step={1}
            fmt={(v) => `${v | 0}`}
            onChange={(v) => set({ seed: Math.round(v) })}
            {...argHelp("imagegen", "seed")}
          />
          <button
            className="btn sm on"
            onClick={onGenerate}
            disabled={busy || !filled.length || !jobId}
            title="Generate one image per prompt, locally (first run downloads the model, ~2 GB)"
          >
            {busy ? "generating…" : "✨ generate"}
          </button>
        </div>
      </div>
      {err && <div className="anim-asset-err">{err}</div>}
      {generated.length > 0 && (
        <div className="anim-imagegen-strip no-drag">
          {generated.map((u, i) => (
            <span className="anim-imagegen-slot gen" key={`${u}-${i}`} title={assetName(u)}>
              <img src={u} alt="" draggable={false} />
            </span>
          ))}
        </div>
      )}
    </NodeFrame>
  );
}
