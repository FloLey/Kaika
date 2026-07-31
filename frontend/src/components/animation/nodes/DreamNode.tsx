import { useEffect, useState } from "react";
import type { ChangeEvent, PointerEvent as RPointerEvent } from "react";
import NodeFrame, { Port } from "./NodeFrame";
import BreakpointTimeline, { partColor, useLivePart } from "../BreakpointTimeline";
import { useDreamSchedule } from "./useDreamSchedule";
import { lyricCuts } from "../../../lib/cutSchedule";
import { ParamRows } from "./FluidParamRow";
import { Toggle } from "../../../ui/Ctl";
import ArgInfo from "./ArgInfo";
import StreamPreview from "./StreamPreview";
import { useNodeData } from "./useNodeData";
import { argHelp } from "../../../lib/paramHelp";
import { ctxAspect } from "../../../lib/output";
import { DREAM_PARAMS } from "../../../lib/nodeParams";
import { dreamClip, pollJob } from "../../../lib/api";
import { mkSlotId } from "../../../lib/graph/core";
import { jobIdOf } from "./nodeProps";
import type { NodeProps } from "./nodeProps";
import type { Asset, DreamData, DreamPrompt } from "../../../lib/types";
import { useUnmountAbort } from "./useUnmountAbort";

// The Dream card: a control track in, a video of generated imagery out. Every frame is
// invented from scratch — pure txt2img + ControlNet, no img2img anchor — so consecutive
// frames share nothing but the control map's shapes. A `trigger` signal splits the window
// into PARTS the same way the montage card cuts, and each part carries its own prompt.
//
// Generation is expensive (one diffusion call per frame), so it runs as a background job
// on ✨ generate, never per-render: the result is a content-addressed clip on `assetUrl`,
// and until then the card passes its control input through.
const MODELS: { id: DreamData["model"]; label: string }[] = [
  { id: "draft", label: "SD-Turbo — fast draft" },
  { id: "hd", label: "Z-Image — HD (slow)" },
];

const SEED_MODES: { id: DreamData["seedMode"]; label: string }[] = [
  { id: "gate", label: "seed: new per part" },
  { id: "fixed", label: "seed: fixed" },
  { id: "frame", label: "seed: new every frame" },
];

// In-flight ✨ jobs by node id, at MODULE scope — the card unmounts on a segment switch
// but the job keeps running server-side; on remount it re-attaches. Session-only: the
// server-side write-back already lands a finished clip on the node across a reload.
const pendingJobs = new Map<string, string>();

// A part's band, drawn with its fade ramps as gradient shoulders: transparent at the far
// end of an incoming ramp (the previous prompt still owns those frames), solid across the
// middle, fading again into the outgoing one. So the picture matches what `dream_plan`
// computes — including a CLAMPED fade, which is why the caller passes the clamped
// geometry rather than the typed values.
function rampBackground(
  b: { from: number; to: number; inTo: number; outFrom: number },
  color: string,
  live: boolean
): string {
  const alpha = live ? "b3" : "59";
  const span = Math.max(1, b.to - b.from);
  const inPct = Math.max(0, Math.min(100, ((b.inTo - b.from) / span) * 100));
  const outPct = Math.max(0, Math.min(100, ((b.outFrom - b.from) / span) * 100));
  if (inPct <= 0 && outPct >= 100) return `${color}${alpha}`;
  return (
    `linear-gradient(to right, ${color}14 0%, ${color}${alpha} ${inPct}%, ` +
    `${color}${alpha} ${outPct}%, ${color}14 100%)`
  );
}

export default function DreamNode({
  node,
  selected,
  helpers,
  ctx,
  onGraphChange,
  onDetach,
  onDelete,
}: NodeProps) {
  const d = node.data as DreamData;
  const set = useNodeData<DreamData>(node, onGraphChange);
  const jobId = jobIdOf(ctx?.job);
  const prompts = d.prompts || [];

  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<number | null>(null);

  const { sched, bands, promptLabel, fps, hasTrigger } = useDreamSchedule(node, ctx);
  const livePart = useLivePart(
    ctx?.groupClock,
    sched.starts,
    sched.total,
    fps,
    ctx?.segment?.start ?? 0
  );

  // Drag a band edge to set that transition's fade. The distance dragged IS the fade
  // length in seconds — a fade-in grows rightwards from the cut, a fade-out leftwards
  // into the part before it, which is the direction each one actually extends.
  const startFadeDrag = (e: RPointerEvent, part: number, side: "fadeIn" | "fadeOut") => {
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    const width = (e.currentTarget as HTMLElement).parentElement?.parentElement?.clientWidth || 1;
    const secsPerPx = sched.total / fps / Math.max(1, width);
    const id = prompts[part]?.id;
    if (!id) return;
    let last = 0;
    const move = (ev: PointerEvent) => {
      const dx = side === "fadeIn" ? ev.clientX - x0 : x0 - ev.clientX;
      last = Math.max(0, Math.round(dx * secsPerPx * 20) / 20); // snap to 0.05s
      patchPrompt(id, { [side]: last || undefined });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // The worker sets the job step to "frame X/Y" per frame — parse it into a 0..1 fraction
  // (null for the indeterminate render/encode phases). On a warm frame cache this races
  // through, which is the cache hitting, not a stall.
  const m = step?.match(/(\d+)\s*\/\s*(\d+)/);
  const frac = m ? Math.min(1, Number(m[1]) / Math.max(1, Number(m[2]))) : null;

  const { controller: pollAbort, isAbort } = useUnmountAbort();

  const track = async (job_id: string) => {
    setBusy(true);
    setErr(null);
    try {
      const result = await pollJob<{ assets: Asset[] }>(
        job_id,
        setStep,
        1500,
        pollAbort.current.signal
      );
      pendingJobs.delete(node.id);
      const url = result.assets?.[0]?.url;
      if (url) set({ assetUrl: url });
    } catch (ex) {
      if (!isAbort(ex)) {
        pendingJobs.delete(node.id);
        setErr(ex instanceof Error ? ex.message : "dream failed");
      }
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  // Re-attach to a generation started before this mount (segment switch & back).
  useEffect(() => {
    const pending = pendingJobs.get(node.id);
    if (pending) track(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

  const onGenerate = async () => {
    if (!jobId || busy || !ctx?.graph || !ctx?.segment) return;
    setBusy(true);
    setErr(null);
    setStep(null);
    try {
      const { job_id } = await dreamClip(jobId, {
        graph: ctx.graph,
        // Decorated with the lyric lines, the way every render request is
        // (useStreamRender / OutputNode): the job's schedule can depend on them, and
        // the bare ctx.segment carries none.
        segment: { ...ctx.segment, lyric_lines: ctx.lyricLines || [] },
        output: ctx.output,
        node_id: node.id,
      });
      pendingJobs.set(node.id, job_id);
      await track(job_id);
    } catch (ex) {
      if (!isAbort(ex)) setErr(ex instanceof Error ? ex.message : "dream failed");
      setBusy(false);
    }
  };

  // Seed the prompt rows from the lyric lines. Deliberately a one-shot ACTION, not a
  // render-time substitution: from here on the rows are ordinary editable prompts, so a
  // rewrite of yours survives everything except pressing this again. The button says
  // what it does, which beats a half-magic merge that surprises you later.
  const fillFromLyrics = () => {
    const lines = (ctx?.lyricLines || []).filter((l) => !(d.skipUnaligned && l.aligned === false));
    if (!lines.length) return;
    const segStart = ctx?.segment?.start ?? 0;
    const style = (d.lyricStyle || "").trim();
    const instrumental = (d.instrumentalPrompt || "").trim() || "instrumental, abstract";
    const cuts = lyricCuts(lines, segStart, fps, sched.total, {
      skipUnaligned: d.skipUnaligned,
    });
    // Each part takes the line being sung when it STARTS — sampled the same way the
    // renderer picks the line for a frame — or the instrumental prompt when that moment
    // is silent. Part 0 begins at frame 0, so a window opening mid-line gets that line.
    const textAt = (frame: number) => {
      const t = segStart + frame / Math.max(1, fps);
      const line = lines.find((l) => l.t0 <= t && t < l.t1);
      if (!line) return instrumental;
      return style ? `${line.text}, ${style}` : line.text;
    };
    const starts = [0, ...cuts.map((c) => c.frame)];
    set({
      prompts: starts.map((f, k) => ({ id: prompts[k]?.id || mkSlotId(), text: textAt(f) })),
    });
  };

  const patchPrompt = (id: string, patch: Partial<DreamPrompt>) =>
    set({ prompts: prompts.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  const addPrompt = () => set({ prompts: [...prompts, { id: mkSlotId(), text: "" }] });
  // Never drop the last row: a Dream card with no prompts cannot generate, and there
  // would be no way back to a usable card from the UI.
  const removePrompt = (id: string) =>
    prompts.length > 1 && set({ prompts: prompts.filter((p) => p.id !== id) });

  return (
    <NodeFrame
      node={node}
      title="dream"
      accent="var(--fx)"
      selected={selected}
      onTitlePointerDown={helpers.onTitlePointerDown}
      onDelete={onDelete}
      sideIn={
        <Port
          kind="in"
          flow="video"
          nodeId={node.id}
          portId="control"
          portRef={helpers.portRef}
          title="control in — wire an Extract card (canny/depth) or a control-map video"
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
      <StreamPreview node={node} ctx={ctx} aspect={ctxAspect(ctx)} />

      {/* OPTIONAL start image. Without it every frame begins from pure noise and the
          background is invented; wired, each frame starts from this clip's matching
          frame (img2img at `strength`), so the source's layout survives. With only a
          video and no Extract, its canny becomes the control. */}
      <div className="anim-combine-row">
        <Port
          kind="in"
          flow="video"
          nodeId={node.id}
          portId="video"
          portRef={helpers.portRef}
          title="video in (optional) — a start image per frame; without it each frame is invented from noise"
        />
        <span className="anim-combine-slot">video (optional)</span>
      </div>

      <label className="anim-select-row no-drag">
        <span className="anim-select-label">model</span>
        <ArgInfo type="dream" k="model" />
        <select
          className="anim-select"
          value={d.model || "draft"}
          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
            set({ model: e.target.value as DreamData["model"] })
          }
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      {/* Follow the lyrics: the project's aligned lines add their own cuts, so the
          imagery changes on the sung lines. No wire — the lines arrive with the project,
          exactly as the Lyrics card receives them. */}
      <div className="anim-static">
        <Toggle
          label="follow the lyrics"
          value={!!d.followLyrics}
          onChange={(v) => set({ followLyrics: v })}
          {...argHelp("dream", "followLyrics")}
        />
        {d.followLyrics && (
          <>
            <label className="anim-num-row" title={argHelp("dream", "lyricStyle").help}>
              <span className="anim-select-label">style</span>
              <ArgInfo type="dream" k="lyricStyle" />
              <input
                className="anim-text"
                type="text"
                placeholder="oil painting, dark background…"
                value={d.lyricStyle || ""}
                onChange={(e) => set({ lyricStyle: e.target.value })}
              />
            </label>
            <label className="anim-num-row" title={argHelp("dream", "instrumentalPrompt").help}>
              <span className="anim-select-label">silences</span>
              <ArgInfo type="dream" k="instrumentalPrompt" />
              <input
                className="anim-text"
                type="text"
                placeholder="instrumental, abstract"
                value={d.instrumentalPrompt || ""}
                onChange={(e) => set({ instrumentalPrompt: e.target.value })}
              />
            </label>
            <Toggle
              label="skip unaligned lines"
              value={!!d.skipUnaligned}
              onChange={(v) => set({ skipUnaligned: v })}
              {...argHelp("dream", "skipUnaligned")}
            />
            <button
              className="btn sm"
              onClick={fillFromLyrics}
              disabled={!(ctx?.lyricLines || []).length}
              title="Rewrite every prompt from the lyric lines — this REPLACES what is there"
            >
              ↻ prompts from lyrics
            </button>
            {!(ctx?.lyricLines || []).length && (
              <div className="anim-fx-hint">no lyric lines on this project</div>
            )}
          </>
        )}
      </div>

      {/* The schedule: a strip over the window where the trigger's cuts and any
          hand-placed splits divide it into PARTS, one prompt each. Click the rail to
          place a split, click a gate cut to disable it, drag a band edge to set that
          transition's fade. */}
      <div className="no-drag">
        <BreakpointTimeline
          nodeId={node.id}
          marks={sched.marks}
          fps={fps}
          total={sched.total}
          clock={ctx?.groupClock}
          segStart={ctx?.segment?.start ?? 0}
          onGraphChange={onGraphChange}
          lane={
            <div className="bp-extracts" role="group" aria-label="prompt parts">
              {bands.map((b) => (
                <button
                  key={`p${b.part}`}
                  type="button"
                  className={"bp-band" + (b.part === livePart ? " bp-band-live" : "")}
                  style={{
                    left: `${(b.from / sched.total) * 100}%`,
                    width: `${((b.to - b.from) / sched.total) * 100}%`,
                    // The ramps are drawn as gradient shoulders on the band, so the
                    // fade you see IS the fade that renders (clamped values, not typed
                    // ones — see useDreamSchedule).
                    background: rampBackground(b, partColor(b.part), b.part === livePart),
                  }}
                  title={`prompt ${b.part + 1} · ${b.secs.toFixed(1)}s${
                    b.clamped ? " — fades CLAMPED to fit this part" : ""
                  } — click to edit it`}
                  onClick={() => setPicked(b.part)}
                />
              ))}
              {/* Fade handles: drag a band's leading/trailing edge to set the fade on
                  that side. Each owns a few pixels at the boundary, so dragging a fade
                  and clicking a band can never be the same gesture. */}
              {bands.map((b) => (
                <span key={`h${b.part}`}>
                  {b.part > 0 && (
                    <span
                      className="bp-fade-handle"
                      style={{ left: `${(b.from / sched.total) * 100}%` }}
                      title={`fade IN of prompt ${b.part + 1} — drag right to lengthen`}
                      onPointerDown={(e) => startFadeDrag(e, b.part, "fadeIn")}
                    />
                  )}
                  {b.part + 1 < bands.length && (
                    <span
                      className="bp-fade-handle"
                      style={{ left: `${(b.to / sched.total) * 100}%` }}
                      title={`fade OUT of prompt ${b.part + 1} — drag left to lengthen`}
                      onPointerDown={(e) => startFadeDrag(e, b.part, "fadeOut")}
                    />
                  )}
                </span>
              ))}
            </div>
          }
          legend={
            <>
              <span className="bp-key bp-key-gate" /> gate ·{" "}
              <span className="bp-key bp-key-manual" /> manual · {bands.length} part
              {bands.length === 1 ? "" : "s"} · {(sched.total / fps).toFixed(1)}s
              {!hasTrigger && " · no trigger — one part"}
              <ArgInfo type="dream" k="prompts" />
            </>
          }
        />
      </div>

      {/* One prompt per part of the schedule, in order, colour-matched to its band. */}
      <div className="anim-imagegen-prompts anim-dream-prompts no-drag">
        {prompts.map((p, k) => (
          <div
            key={p.id}
            className={"anim-dream-prompt" + (k === picked ? " sel" : "")}
            style={k < bands.length ? { borderLeft: `3px solid ${partColor(k)}` } : undefined}
          >
            <div className="anim-dream-prompt-head anim-fx-hint">
              <span className="bp-key" style={{ background: partColor(k) }} /> {promptLabel(k)}
              {bands[k]?.clamped && (
                <strong title="this part is shorter than its fades"> ⚠ fades clamped</strong>
              )}
            </div>
            <textarea
              className="anim-imagegen-prompt"
              rows={2}
              value={p.text}
              placeholder={`prompt ${k + 1}…`}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                patchPrompt(p.id, { text: e.target.value })
              }
              title={argHelp("dream", "prompts").help}
            />
            <div className="anim-dream-prompt-args">
              <label title="seconds this prompt takes to fade IN, from the cut">
                in
                <input
                  className="anim-num"
                  type="number"
                  min={0}
                  step={0.1}
                  value={p.fadeIn ?? 0}
                  onChange={(e) =>
                    patchPrompt(p.id, { fadeIn: Math.max(0, Number(e.target.value)) || undefined })
                  }
                />
              </label>
              <label title="seconds this prompt takes to fade OUT, before the next cut">
                out
                <input
                  className="anim-num"
                  type="number"
                  min={0}
                  step={0.1}
                  value={p.fadeOut ?? 0}
                  onChange={(e) =>
                    patchPrompt(p.id, { fadeOut: Math.max(0, Number(e.target.value)) || undefined })
                  }
                />
              </label>
              <label title="how many cuts this prompt swallows before the next one starts">
                ×
                <input
                  className="anim-num"
                  type="number"
                  min={1}
                  max={16}
                  step={1}
                  value={p.span ?? 1}
                  onChange={(e) =>
                    patchPrompt(p.id, {
                      span: Math.max(1, Math.round(Number(e.target.value))) || undefined,
                    })
                  }
                />
              </label>
              {prompts.length > 1 && (
                <button className="btn sm" onClick={() => removePrompt(p.id)} title="remove">
                  ✕
                </button>
              )}
            </div>
          </div>
        ))}
        <button className="btn sm" onClick={addPrompt}>
          + prompt
        </button>
      </div>

      <label className="anim-select-row no-drag">
        <span className="anim-select-label">seed</span>
        <ArgInfo type="dream" k="seedMode" />
        <select
          className="anim-select"
          value={d.seedMode || "gate"}
          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
            set({ seedMode: e.target.value as DreamData["seedMode"] })
          }
        >
          {SEED_MODES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>

      {/* The seed, with a re-roll. It has to be reachable: every generated frame is
          cached on its inputs, so pressing ↻ regenerate with nothing changed correctly
          returns the SAME clip in a second — which reads as "regenerate is broken" when
          the only thing you wanted was a different take. 🎲 is that different take.
          (Not auto-bumped on every ✨, unlike the Image gen card: that would re-roll
          every frame after a one-prompt edit and throw the cache away.) */}
      <div className="anim-static">
        <label className="anim-num-row" title={argHelp("dream", "seed").help}>
          <span className="anim-select-label">seed</span>
          <ArgInfo type="dream" k="seed" />
          <input
            className="anim-num"
            type="number"
            min={1}
            step={1}
            value={d.seed ?? 1}
            onChange={(e) => set({ seed: Math.max(1, Math.round(Number(e.target.value)) || 1) })}
          />
          <button
            className="btn sm"
            onClick={() => set({ seed: (d.seed ?? 1) + 1 })}
            title="another take — bumps the seed, so the next generate invents new imagery"
          >
            🎲
          </button>
        </label>
      </div>

      <div className="anim-static">
        <label className="anim-num-row" title={argHelp("dream", "fadeShape").help}>
          <span className="anim-select-label">fade shape</span>
          <ArgInfo type="dream" k="fadeShape" />
          <input
            className="anim-num"
            type="number"
            min={0.25}
            max={6}
            step={0.25}
            value={d.fadeShape ?? 1}
            onChange={(e) => set({ fadeShape: Math.max(0.25, Number(e.target.value)) || 1 })}
          />
        </label>
      </div>

      <ParamRows
        params={DREAM_PARAMS}
        node={node}
        helpers={helpers}
        onGraphChange={onGraphChange}
        onDetach={onDetach}
      />

      <button
        className="btn sm on anim-imagegen-generate"
        onClick={onGenerate}
        disabled={busy || !jobId}
        title="Generate the clip locally (first use of a model downloads it)"
      >
        {busy ? step || "dreaming…" : d.assetUrl ? "↻ regenerate" : "✨ generate"}
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
          title={step || "dreaming…"}
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
