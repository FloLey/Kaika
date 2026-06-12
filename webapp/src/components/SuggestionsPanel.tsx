// Creative-director panel: asks the LLM for a global look + a proposal per
// segment, each previewable WITHOUT committing, then accept (applies, undoable)
// or reject (dismiss).
import { useState } from "react";
import { api, GlobalProposal, SegmentProposal } from "../api";
import HelpLink from "./HelpLink";

interface Props {
  runId: string;
  onProjectChanged: () => void;
  onPreviewJob: (jobId: string) => void;
}

function changeSummary(p: SegmentProposal | GlobalProposal): string[] {
  const out: string[] = [];
  const g = p as GlobalProposal;
  if (g.recipe_values) {
    for (const k of Object.keys(g.recipe_values)) out.push(k);
  }
  const s = p as SegmentProposal;
  if (s.fluid) {
    const walk = (o: any, pre: string) => {
      for (const k of Object.keys(o || {})) {
        const v = o[k];
        if (v && typeof v === "object" && !Array.isArray(v)) walk(v, `${pre}${k}.`);
        else out.push(`${pre}${k}`);
      }
    };
    walk(s.fluid, "");
  }
  if (s.prompt) out.push("prompt");
  if (s.timeline?.length) out.push(`${s.timeline.length} timeline accent(s)`);
  return out;
}

export default function SuggestionsPanel({ runId, onProjectChanged,
                                          onPreviewJob }: Props) {
  const [globalP, setGlobalP] = useState<GlobalProposal | null>(null);
  const [segs, setSegs] = useState<SegmentProposal[]>([]);
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [extra, setExtra] = useState("");

  const generate = async () => {
    setBusy(true); setErr(""); setGlobalP(null); setSegs([]);
    try {
      const plan = await api.suggest(runId, extra);
      setGlobalP(plan.global);
      setSegs(plan.segments || []);
      if (!plan.global && !(plan.segments || []).length) {
        setErr("the model returned no proposals — try again");
      }
    } catch (e: any) {
      setErr(String(e.message || e));   // e.g. "Anthropic API key missing"
    } finally { setBusy(false); }
  };

  // Segment proposals are designed on top of the global look (they may use a
  // palette the global proposal introduces), so carry the global with them.
  const wrap = (proposal: any) =>
    "segment_index" in proposal
      ? (globalP ? { ...proposal, global: globalP } : proposal)
      : { global: proposal };

  const preview = async (key: string, proposal: any) => {
    setActing(key); setErr("");
    try {
      const { job_id } = await api.previewProposal(runId, wrap(proposal));
      onPreviewJob(job_id);
    } catch (e: any) { setErr(String(e.message || e)); }
    finally { setActing(null); }
  };

  const accept = async (key: string, proposal: any, drop: () => void) => {
    setActing(key); setErr("");
    try {
      await api.applySuggestion(runId, wrap(proposal));
      onProjectChanged();
      drop();
    } catch (e: any) { setErr(String(e.message || e)); }
    finally { setActing(null); }
  };

  const card = (key: string, title: string, reasoning: string | undefined,
                proposal: GlobalProposal | SegmentProposal, drop: () => void) => {
    const invalid = (proposal as any).invalid;
    return (
      <div className={`sugg-card${invalid ? " invalid" : ""}`} key={key}>
        <div className="sugg-head">{title}</div>
        {reasoning && <p className="muted">{reasoning}</p>}
        <div className="sugg-changes">
          {changeSummary(proposal).map((c, i) =>
            <span className="chip" key={i}>{c}</span>)}
        </div>
        {invalid && <p className="err">can't apply: {invalid}</p>}
        <div className="sugg-actions">
          <button className="btn ghost slim" disabled={!!acting || invalid}
            onClick={() => preview(key, proposal)}>
            {acting === key ? "…" : "Preview"}</button>
          <button className="btn slim" disabled={!!acting || invalid}
            onClick={() => accept(key, proposal, drop)}>Accept</button>
          <button className="btn ghost slim" onClick={drop}>Reject</button>
        </div>
      </div>
    );
  };

  return (
    <div className="card sugg-panel">
      <div className="sugg-bar">
        <input value={extra} placeholder="optional steer (darker, more energetic…)"
          onChange={(e) => setExtra(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && generate()} />
        <button className="btn" disabled={busy} onClick={generate}>
          {busy ? "thinking…" : "✨ Propose ideas"}</button>
        <HelpLink anchor="assistant" />
      </div>
      {err && <p className="err">{err}</p>}
      {globalP && card("global", `🎨 ${globalP.title || "Global look"}`,
        globalP.reasoning, globalP, () => setGlobalP(null))}
      {segs.map((s) => card(`seg-${s.segment_index}`,
        `Segment ${s.segment_index} · ${s.label || ""}`, s.reasoning, s,
        () => setSegs((xs) => xs.filter((x) => x !== s))))}
    </div>
  );
}
