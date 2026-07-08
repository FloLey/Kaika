import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import ArgInfo from "./ArgInfo";
import { useNodeData } from "./useNodeData";
import { useResolvedCurve } from "./useResolvedCurve";
import { argHelp } from "../../../lib/paramHelp";
import { generateImage, pollJob } from "../../../lib/api";
import { upstreamKey, videoSource } from "../../../lib/graphModel";
import { countRises, fitPrompts } from "../../../lib/imageCount";
import { assetName } from "./useAssetUpload";
import { jobIdOf } from "./nodeProps";
import type { NodeProps } from "./nodeProps";
import type { Asset, ImagegenData } from "../../../lib/types";

// The selectable models: a fast low-res draft and the HD model. The card's ✨ makes
// drafts for speed while building; the final export always regenerates in HD.
const DRAFT_MODEL = "stabilityai/sd-turbo";
const MODELS: { id: string; label: string }[] = [
  { id: DRAFT_MODEL, label: "SD-Turbo — fast draft" },
  { id: "Tongyi-MAI/Z-Image-Turbo", label: "Z-Image-Turbo — HD (slow)" },
];

// The image GENERATOR: one image per prompt (assetUrls align 1:1 with prompts by
// index — regenerating always replaces, never accumulates), generated locally into
// content-addressed assets. It produces no video itself: wire its `images` output
// into a Slideshow card's `images` input. An optional value `in` accepts a gate's
// output — the card counts the gate's pulses and auto-sizes its prompt list so there's
// one image per gate switch (see the Slideshow's rising-edge advance).
export default function ImagegenNode({ node, selected, helpers, ctx, onGraphChange, onDelete }: NodeProps) {
  const d = node.data as ImagegenData;
  const set = useNodeData<ImagegenData>(node, onGraphChange);
  const prompts = d.prompts?.length ? d.prompts : [""];
  const generated = d.assetUrls || [];
  const model = d.model || DRAFT_MODEL;

  const setPrompt = (i: number, text: string) =>
    set({ prompts: prompts.map((p, k) => (k === i ? text : p)) });
  const addPrompt = () => set({ prompts: [...prompts, ""] });
  const removePrompt = (i: number) =>
    set({ prompts: prompts.length > 1 ? prompts.filter((_, k) => k !== i) : [""] });

  const jobId = jobIdOf(ctx?.job);

  // Optional gate input: resolve the wired source's ACTUAL curve (the same /resolve
  // the Scope uses — so all of the gate's threshold/hysteresis/minGap/divide is already
  // applied) and count its rising edges. The slideshow shows `rises + 1` distinct
  // images, so that's how many the card needs. upstreamKey covers exactly the wired
  // source's contributing subgraph — refetch on any UPSTREAM change but NOT on this
  // card's own prompt/seed edits (and no O(graph) stringify per render).
  const srcId = ctx?.graph ? videoSource(ctx.graph, node.id, "in") : null;
  const depKey =
    srcId && ctx?.graph ? upstreamKey(ctx.graph, srcId, ctx?.segment?.signals) : "";
  const { curve } = useResolvedCurve(srcId ? ctx : undefined, srcId ?? "", depKey);
  const needed = srcId && curve.length ? countRises(curve) + 1 : null;

  // A wired gate caps the card to its first `needed` rows: rows beyond that are hidden
  // from the card entirely (but kept in the data + their images), so they reappear —
  // with their image — if the gate later needs more. The gate owns the row count.
  const gated = needed != null;
  const visiblePrompts = gated ? prompts.slice(0, needed) : prompts;
  const filled = visiblePrompts.map((p) => p.trim()).filter(Boolean);

  // Auto-fit the prompt rows to the gate, non-destructively (only add/remove EMPTY
  // rows — never a typed prompt), and persist `activeCount` so the slideshow/output
  // (front + back) cap to the first N. Keyed on `needed` only, so typing a prompt
  // doesn't re-trigger it; guarded so it writes only when something actually changes.
  useEffect(() => {
    if (needed == null) return;
    const fitted = fitPrompts(prompts, needed);
    const patch: Partial<ImagegenData> = {};
    if (fitted.length !== prompts.length || fitted.some((p, i) => p !== prompts[i]))
      patch.prompts = fitted;
    if (d.activeCount !== needed) patch.activeCount = needed;
    if (Object.keys(patch).length) set(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needed]);

  // Gate unwired → drop the cap so every image shows and passes through again.
  useEffect(() => {
    if (!srcId && d.activeCount != null) set({ activeCount: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcId]);

  // `busyRow` is "all" while the whole batch runs, the row index while a single
  // prompt regenerates, else null. One in-flight generation at a time.
  const [busyRow, setBusyRow] = useState<number | "all" | null>(null);
  const busy = busyRow !== null;
  const [err, setErr] = useState<string | null>(null);

  // Abort in-flight job polls on unmount — the backend job keeps running (the
  // images still land in the library), but this card stops polling + setState-ing.
  const pollAbort = useRef(new AbortController());
  useEffect(() => {
    const ctl = pollAbort.current;
    return () => ctl.abort();
  }, []);
  const isAbort = (ex: unknown) => ex instanceof DOMException && ex.name === "AbortError";

  const onGenerate = async () => {
    if (!jobId || !filled.length || busy) return;
    setBusyRow("all");
    setErr(null);
    try {
      // Only the VISIBLE (gate-capped) rows are (re)generated; hidden rows keep their
      // existing images untouched.
      const trimmed = visiblePrompts.map((p) => p.trim());
      const toGen = trimmed.filter(Boolean);
      const { job_id } = await generateImage(jobId, toGen, d.seed, model);
      const result = await pollJob<{ assets: Asset[] }>(job_id, undefined, 1000, pollAbort.current.signal);
      const urls = (result.assets || []).map((a) => a.url);
      // Scatter the results back to their PROMPT INDICES so assetUrls[i] is prompt i's
      // image (empty rows get ""), then re-append the hidden rows' images so they stay.
      let k = 0;
      const visibleUrls = trimmed.map((p) => (p ? (urls[k++] ?? "") : ""));
      const next = [...visibleUrls, ...generated.slice(visiblePrompts.length)];
      set({ assetUrls: next, seed: d.seed + toGen.length });
    } catch (ex) {
      if (!isAbort(ex)) setErr(ex instanceof Error ? ex.message : "generation failed");
    } finally {
      setBusyRow(null);
    }
  };

  // Regenerate JUST the image for prompt row `i` (a fresh random seed → a new take),
  // replacing exactly assetUrls[i] (index-aligned with the prompts).
  const onRegenOne = async (i: number) => {
    const text = prompts[i]?.trim();
    if (!jobId || !text || busy) return;
    setBusyRow(i);
    setErr(null);
    try {
      const freshSeed = Math.floor(Math.random() * 9999) + 1;
      const { job_id } = await generateImage(jobId, [text], freshSeed, model);
      const result = await pollJob<{ assets: Asset[] }>(job_id, undefined, 1000, pollAbort.current.signal);
      const url = result.assets?.[0]?.url;
      if (url) {
        const next = [...generated];
        while (next.length <= i) next.push("");
        next[i] = url;
        set({ assetUrls: next });
      }
    } catch (ex) {
      if (!isAbort(ex)) setErr(ex instanceof Error ? ex.message : "generation failed");
    } finally {
      setBusyRow(null);
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
      sideIn={
        <Port
          kind="in"
          flow="value"
          nodeId={node.id}
          portId="in"
          portRef={helpers.portRef}
          title="gate in (optional) — sizes the prompt list to the gate's pulses"
        />
      }
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
      {needed != null ? (
        <div className="anim-fx-hint">
          gate → <strong>{needed}</strong> image{needed === 1 ? "" : "s"}
          {filled.length > needed ? ` · you have ${filled.length}` : ""}
        </div>
      ) : (
        <div className="anim-fx-hint">
          will generate <strong>{filled.length}</strong> image{filled.length === 1 ? "" : "s"} (one
          per prompt)
        </div>
      )}
      <label className="anim-select-row no-drag">
        <span className="anim-select-label">model</span>
        <ArgInfo type="imagegen" k="model" />
        <select
          className="anim-select"
          value={model}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => set({ model: e.target.value })}
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <div className="anim-fx-hint">
        ✨ makes fast drafts; the <strong>final export regenerates in HD</strong> automatically.
      </div>
      <div className="anim-imagegen-prompts no-drag">
        {visiblePrompts.map((p, i) => (
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
              title="regenerate just this image (new seed)"
              onClick={() => onRegenOne(i)}
              disabled={busy || !p.trim() || !jobId}
            >
              {busyRow === i ? "…" : "↻"}
            </button>
            {/* When a gate owns the row count, no manual remove (keeps rows aligned). */}
            {!gated && (
              <button
                className="iconbtn"
                title="remove this prompt"
                onClick={() => removePrompt(i)}
                disabled={busy}
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <div className="anim-imagegen-controls">
          {/* The gate drives the count when wired, so hide the manual add. */}
          {!gated && (
            <button className="btn sm" onClick={addPrompt} disabled={busy}>
              + prompt
            </button>
          )}
          <label className="anim-imagegen-seed">
            <span>seed</span>
            <input
              type="number"
              min={1}
              max={9999}
              step={1}
              value={d.seed}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                set({ seed: Math.max(1, Math.min(9999, Math.round(parseFloat(e.target.value) || 1))) })
              }
            />
            <ArgInfo type="imagegen" k="seed" />
          </label>
        </div>
        <button
          className="btn sm on anim-imagegen-generate"
          onClick={onGenerate}
          disabled={busy || !filled.length || !jobId}
          title="Generate one draft image per prompt, locally (first use of a model downloads it)"
        >
          {busyRow === "all" ? "generating…" : "✨ generate all"}
        </button>
      </div>
      {err && <div className="anim-asset-err">{err}</div>}
      {/* The generated-image STRIP moves to the settings window's gallery (right column);
          hide it there so it isn't shown twice. */}
      {!ctx?.previewInPanel &&
        (needed != null ? generated.slice(0, needed) : generated).some(Boolean) && (
          <div className="anim-imagegen-strip no-drag">
            {(needed != null ? generated.slice(0, needed) : generated).map((u, i) =>
              u ? (
                <span className="anim-imagegen-slot gen" key={`${u}-${i}`} title={assetName(u)}>
                  <img src={u} alt="" draggable={false} />
                </span>
              ) : null
            )}
          </div>
        )}
    </NodeFrame>
  );
}
