// Studio v2 — the three-pane instrument: hear it (waveform + lanes), see it
// (looping window preview), turn a knob (schema-driven inspector). Any edit
// re-renders the same few seconds at draft quality in seconds; a chat copilot
// edits the project through validated tools.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, Analysis, ProjectDoc, RecipeEntry, Segment, Signals,
         TimelineDirective, getPath, setPath } from "../api";
import Waveform from "./Waveform";
import Lanes from "./Lanes";
import Inspector from "./Inspector";
import PreviewPane from "./PreviewPane";
import ChatPanel from "./ChatPanel";
import { FormCtx } from "./SchemaForm";

interface Props {
  initialRunId?: string | null;
  onPreview: (runId: string, jobId: string) => void;   // full-track → Render view
}

const MIN_SEG_S = 0.4;
const WINDOW_S = 6.0;
const SAVE_DEBOUNCE_MS = 500;

export default function Studio({ initialRunId, onPreview }: Props) {
  const [recipes, setRecipes] = useState<RecipeEntry[]>([]);
  const [recipeName, setRecipeName] = useState("eclosion");
  const [schema, setSchema] = useState<any>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectDoc | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [signals, setSignals] = useState<Signals | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState(false);
  const [err, setErr] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [previewJob, setPreviewJob] = useState<string | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [livePreview, setLivePreview] = useState(true);
  const [lyricsText, setLyricsText] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const playheadRef = useRef(0);
  playheadRef.current = playhead;
  const projectRef = useRef<ProjectDoc | null>(null);
  projectRef.current = project;
  // Track time of the clip the preview pane currently shows: recorded when a
  // preview is submitted, committed when its job lands (the video reloads).
  const pendingStart = useRef(0);
  const [previewStart, setPreviewStart] = useState(0);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => { api.recipes().then(setRecipes).catch(() => {}); }, []);
  useEffect(() => { api.schema().then(setSchema).catch(() => {}); }, []);

  const adopt = (p: Awaited<ReturnType<typeof api.getProject>>) => {
    setRunId(p.run_id);
    setProject(p.project);
    if (p.analysis) setAnalysis(p.analysis);
    setAudioUrl(p.audio_url ?? null);
    setWarnings(p.manifest?.warnings ?? []);
    api.signals(p.run_id).then(setSignals).catch(() => {});
  };

  useEffect(() => {
    if (initialRunId) {
      api.getProject(initialRunId).then(adopt)
        .catch((e) => setErr(String(e.message || e)));
    }
  }, [initialRunId]);

  // first preview as soon as a project is open — never an empty pane
  useEffect(() => {
    if (runId) kickPreview(runId);
  }, [runId]);                                          // eslint-disable-line

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const a = audioRef.current;
      if (a) setPlayhead(a.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // ---- the live loop: save (debounced) then re-render the window ----------
  const kickTimer = useRef<number | undefined>(undefined);
  const kickPreview = useCallback((rid: string) => {
    if (!livePreview) return;
    // debounced: scrubbing/seeking must not flood the job queue
    window.clearTimeout(kickTimer.current);
    kickTimer.current = window.setTimeout(async () => {
      const t0 = Math.max(0, playheadRef.current - 1);
      try {
        const { job_id } = await api.previewWindow(rid, t0, t0 + WINDOW_S, true);
        pendingStart.current = t0;
        setPreviewJob(job_id);
      } catch (e: any) { setErr(String(e.message || e)); }
    }, 400);
  }, [livePreview]);

  // Clicking a segment targets the preview at THAT segment (debounced so
  // arrowing through segments doesn't flood the job queue).
  const selectSegment = useCallback((i: number) => {
    setSel(i);
    if (!runId) return;
    window.clearTimeout(kickTimer.current);
    kickTimer.current = window.setTimeout(async () => {
      try {
        const { job_id } = await api.previewSegment(runId, i, true);
        pendingStart.current = projectRef.current?.segments[i]?.start ?? 0;
        setPreviewJob(job_id);
      } catch (e: any) { setErr(String(e.message || e)); }
    }, 350);
  }, [runId]);

  const scheduleSave = useCallback((next: ProjectDoc) => {
    if (!runId) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      try {
        setErr("");
        await api.updateProject(runId, {
          recipe: next.recipe, segments: next.segments,
          timeline: next.timeline, ui_pins: next.ui_pins,
        });
        kickPreview(runId);
      } catch (e: any) { setErr(String(e.message || e)); }
    }, SAVE_DEBOUNCE_MS);
  }, [runId, kickPreview]);

  const mutate = (fn: (p: ProjectDoc) => ProjectDoc) => {
    setProject((p) => {
      if (!p) return p;
      const next = fn(p);
      scheduleSave(next);
      return next;
    });
  };

  // recipe dot-path setter for the schema-driven inspector
  const onSet = useCallback((path: string, value: any) => {
    mutate((p) => ({ ...p, recipe: setPath(p.recipe, path, value) }));
  }, [scheduleSave]);                                   // eslint-disable-line

  const onReplaceRecipe = (recipe: any, onErrCb: (e: string) => void) => {
    if (!runId) return;
    api.setRecipe(runId, recipe).then((p) => {
      setProject(p.project);
      kickPreview(runId);
    }).catch((e) => onErrCb(String(e.message || e)));
  };

  // modulated paths (both by emitter id and list index, for badges)
  const modulated = useMemo(() => {
    const out = new Set<string>();
    const ems: any[] = project?.recipe?.emitters ?? [];
    for (const m of project?.recipe?.modulators ?? []) {
      out.add(m.target);
      const parts = (m.target as string).split(".");
      if (parts[0] === "emitters") {
        const idx = ems.findIndex((e) => e.id === parts[1]);
        if (idx >= 0) out.add(["emitters", String(idx), ...parts.slice(2)].join("."));
      }
    }
    return out;
  }, [project?.recipe]);

  const pins = useMemo(() => new Set(project?.ui_pins ?? []), [project?.ui_pins]);
  const togglePin = (path: string) => mutate((p) => ({
    ...p,
    ui_pins: p.ui_pins?.includes(path)
      ? p.ui_pins.filter((x) => x !== path)
      : [...(p.ui_pins ?? []), path],
  }));

  const aspect = (project?.recipe?.canvas?.width ?? 1)
    / (project?.recipe?.canvas?.height ?? 1);

  const ctx: FormCtx = { onSet, modulated, pins, onPin: togglePin,
                         canvasAspect: aspect || 1 };

  // ---- uploads / actions ---------------------------------------------------
  const upload = async (file: File) => {
    setErr(""); setBusy(true);
    try {
      const { audio_id } = await api.upload(file, lyricsText);
      adopt(await api.createProject({ audio_id, recipe_name: recipeName }));
    } catch (e: any) { setErr(String(e.message || e)); }
    finally { setBusy(false); }
  };

  const flushSave = async () => {
    if (!runId || !project) return;
    window.clearTimeout(saveTimer.current);
    await api.updateProject(runId, { recipe: project.recipe,
      segments: project.segments, timeline: project.timeline,
      ui_pins: project.ui_pins });
  };
  const previewFull = async () => {
    if (!runId) return;
    setBusy(true); setErr("");
    try {
      await flushSave();
      const { job_id } = await api.previewProject(runId, false);
      onPreview(runId, job_id);
    } catch (e: any) { setErr(String(e.message || e)); setBusy(false); }
  };
  const generate = async () => {
    if (!runId) return;
    setBusy(true); setErr("");
    try {
      await flushSave();
      const { job_id } = await api.generateProject(runId);
      onPreview(runId, job_id);
    } catch (e: any) { setErr(String(e.message || e)); setBusy(false); }
  };
  const hqWindow = async () => {
    if (!runId) return;
    const t0 = Math.max(0, playhead - 1);
    const { job_id } = await api.previewWindow(runId, t0, t0 + WINDOW_S, false);
    pendingStart.current = t0;
    setPreviewJob(job_id);
  };

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      previewVideoRef.current?.pause();   // one transport at a time
      a.play(); setPlaying(true);
    } else { a.pause(); setPlaying(false); }
  };
  const seek = (t: number) => {
    const a = audioRef.current;
    if (a) a.currentTime = t;
    setPlayhead(t);
    if (runId) kickPreview(runId);
  };

  const moveBoundary = (b: number, t: number) => {
    if (!project) return;
    const segs = structuredClone(project.segments);
    const lo = segs[b - 1].start + MIN_SEG_S;
    const hi = segs[b].end - MIN_SEG_S;
    const tt = Math.max(lo, Math.min(hi, t));
    segs[b - 1].end = tt;
    segs[b].start = tt;
    mutate((p) => ({ ...p, segments: segs }));
  };
  const splitAtPlayhead = () => {
    if (!project) return;
    const t = playhead;
    const i = project.segments.findIndex(
      (s) => t > s.start + MIN_SEG_S && t < s.end - MIN_SEG_S);
    if (i < 0) return;
    const segs = structuredClone(project.segments);
    const right: Segment = { ...structuredClone(segs[i]), start: t };
    segs[i].end = t;
    segs.splice(i + 1, 0, right);
    mutate((p) => ({ ...p, segments: segs }));
    setSel(i + 1);
  };
  const mergeWithNext = () => {
    if (!project || sel >= project.segments.length - 1) return;
    const segs = structuredClone(project.segments);
    segs[sel].end = segs[sel + 1].end;
    segs.splice(sel + 1, 1);
    mutate((p) => ({ ...p, segments: segs }));
  };

  const setTimeline = (tl: TimelineDirective[]) =>
    mutate((p) => ({ ...p, timeline: tl }));

  // pinned session controls strip
  const pinControls = (project?.ui_pins ?? []).map((path) => {
    const v = getPath(project!.recipe, path);
    if (typeof v !== "number") return null;
    return (
      <div key={path} className="pin-ctl" title={path}>
        <label className="field">{path.split(".").slice(-2).join(".")}
          <span className="val">{(+v).toFixed(2).replace(/\.?0+$/, "")}</span>
          <button className="pin on" onClick={() => togglePin(path)}>✕</button>
        </label>
        <input type="range" min={0} max={Math.max(1, v * 3)} step={v > 10 ? 1 : 0.01}
          value={v} onChange={(e) => onSet(path, parseFloat(e.target.value))} />
      </div>
    );
  });

  return (
    <div className="studio3">
      <div className="studio-main">
        {!project && (
          <div className={`drop ${hover ? "hover" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setHover(true); }}
            onDragLeave={() => setHover(false)}
            onDrop={(e) => { e.preventDefault(); setHover(false);
              const f = e.dataTransfer.files[0]; if (f) upload(f); }}>
            <p style={{ fontSize: 18, marginBottom: 10 }}>Drop an audio file here</p>
            <p className="muted">analysis splits it into editable segments</p>
            <label className="btn ghost" style={{ display: "inline-block",
              width: "auto", marginTop: 12 }}>
              Choose file
              <input type="file" accept="audio/*" style={{ display: "none" }}
                onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            </label>
            <div style={{ marginTop: 18 }}>
              <label className="field" style={{ textAlign: "center" }}>Visual identity</label>
              <select value={recipeName} onChange={(e) => setRecipeName(e.target.value)}
                style={{ maxWidth: 240, margin: "0 auto" }}>
                {recipes.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
              </select>
            </div>
            <div style={{ marginTop: 14 }}>
              <label className="field" style={{ textAlign: "center" }}>
                Lyrics (optional)</label>
              <textarea value={lyricsText}
                onChange={(e) => setLyricsText(e.target.value)}
                onDrop={(e) => e.stopPropagation()}
                placeholder={"Paste the song lyrics — plain text or .lrc.\nThey get auto-aligned to the track."}
                rows={4}
                style={{ maxWidth: 420, margin: "0 auto", display: "block",
                         width: "100%", resize: "vertical" }} />
            </div>
            {busy && <p className="muted" style={{ marginTop: 10 }}>analyzing…</p>}
          </div>
        )}

        {project && runId && (
          <>
            <PreviewPane runId={runId} jobId={previewJob}
              version={previewVersion} aspect={aspect || 1}
              windowLabel={`window ${Math.max(0, playhead - 1).toFixed(1)}–${(Math.max(0, playhead - 1) + WINDOW_S).toFixed(1)}s · draft`}
              windowStart={previewStart}
              onJobDone={() => { setPreviewJob(null);
                setPreviewStart(pendingStart.current);
                setPreviewVersion((v) => v + 1); }}
              onHq={hqWindow}
              onTime={(t) => { if (!playing) setPlayhead(t); }}
              onPlaying={(pl) => {
                if (pl) {            // preview takes the transport
                  const a = audioRef.current;
                  if (a && !a.paused) { a.pause(); setPlaying(false); }
                }
              }}
              registerVideo={(el) => { previewVideoRef.current = el; }} />

            {(project.ui_pins?.length ?? 0) > 0 && (
              <div className="card pin-strip">{pinControls}</div>
            )}

            {analysis && (
              <div className="card">
                <div className="transport">
                  <button className="play" onClick={togglePlay}>
                    {playing ? "❚❚" : "▶"}</button>
                  <span className="mono muted">
                    {playhead.toFixed(1)}s / {analysis.duration_s.toFixed(1)}s
                  </span>
                  <label className="check" style={{ marginLeft: 12 }}
                    title="re-render the preview window after every edit">
                    <input type="checkbox" checked={livePreview}
                      onChange={(e) => setLivePreview(e.target.checked)} />
                    live preview
                  </label>
                  <span className="mono muted" style={{ marginLeft: "auto" }}>
                    {analysis.tempo_bpm.toFixed(0)} BPM ·{" "}
                    {project.segments.length} segments
                  </span>
                </div>
                {audioUrl && (
                  <audio ref={audioRef} src={audioUrl}
                    onEnded={() => setPlaying(false)} />
                )}
                <Waveform
                  waveform={analysis.waveform}
                  duration={analysis.duration_s}
                  segments={project.segments}
                  selected={sel}
                  beats={(analysis.beats || []).map((b) => b.t)}
                  onsets={{ low: analysis.onsets?.low ?? [],
                            high: analysis.onsets?.high ?? [] }}
                  playhead={playhead}
                  onSelect={selectSegment}
                  onSeek={seek}
                  onMoveBoundary={moveBoundary}
                />
                {signals && (
                  <Lanes signals={signals} duration={analysis.duration_s}
                    timeline={project.timeline ?? []} playhead={playhead}
                    onSeek={seek}
                    onMovePin={(i, t) => {
                      const tl = [...(project.timeline ?? [])];
                      tl[i] = { ...tl[i], at: t };
                      setTimeline(tl);
                    }} />
                )}
                <div className="seg-ops">
                  <button className="btn ghost slim" onClick={splitAtPlayhead}>
                    Split at playhead</button>
                  <button className="btn ghost slim" onClick={mergeWithNext}
                    disabled={sel >= project.segments.length - 1}>
                    Merge with next</button>
                  <span style={{ flex: 1 }} />
                  <button className="btn ghost slim" disabled={busy}
                    onClick={previewFull}>Preview full track</button>
                  <button className="btn slim" disabled={busy} onClick={generate}>
                    Generate (diffusion)</button>
                </div>
              </div>
            )}
            {warnings.length > 0 && (
              <div className="card warn">
                {warnings.map((w, i) => <p key={i}>⚠ {w}</p>)}
              </div>
            )}
            {err && <p className="err">{err}</p>}

            <ChatPanel runId={runId}
              onProjectChanged={() => api.getProject(runId).then((p) => {
                setProject(p.project);
                setWarnings(p.manifest?.warnings ?? []);
              })}
              onPreviewJob={(jid) => setPreviewJob(jid)} />
          </>
        )}
        {!project && err && <p className="err">{err}</p>}
      </div>

      <aside className="studio-side">
        {project && schema && (
          <Inspector schema={schema} project={project} ctx={ctx}
            onReplaceRecipe={onReplaceRecipe}
            onSetTimeline={setTimeline}
            onSetSegments={(segs) => mutate((p) => ({ ...p, segments: segs }))}
            selectedSegment={sel}
            onSelectSegment={selectSegment} />
        )}
      </aside>
    </div>
  );
}
