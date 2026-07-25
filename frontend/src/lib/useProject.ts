// One open project: everything about it, and everything that changes it.
//
// This was nineteen `useState`s in `App.tsx` that all describe the same thing and are
// all set together in `openProject`, plus the autosave, the montage-drift reconciler
// and the three save paths. Lifting them here is a pure move — `App` keeps only the
// chrome it actually owns (logs drawer, settings modal, error badge) and the JSX.
//
// The reason it had to move: a second app shell (`?ui=next`) needs the same project,
// and the alternative to a hook is a second copy of nineteen `useState`s whose
// `lastSaved` bookkeeping is load-bearing. `docs/cleanup` flagged the same thing from
// the readability side; this is the same collapse, done because a caller needs it.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Asset, CompositionPool, LyricLine, OutputSettings, Segment } from "./types";
import type { UploadResult, SegmentProposal } from "./api";
import { hydrateSegments, serializeSegments } from "./segments";
import { hydrateCompositions, pruneOrphans, shiftMontageLocalTimes, splitAt } from "./compositions";
import { OUTPUT_DEFAULTS, withOutputDefaults } from "./output";
import { EXPORT_DEFAULTS, withExportDefaults } from "./export";
import type { ExportSettings } from "./export";
import * as api from "./api";
import { createSaveChain } from "./saveChain";

// The persisted project shape, in ONE place. It was written out four times — the
// autosave, the lyric-lines save, the fixture save, and (the dangerous one) the
// `lastSaved` seed in openProject. That seed must serialise to EXACTLY what the autosave
// would produce: too different and the app re-PUTs the moment a project opens, too
// similar-but-not-equal and a real edit can be mistaken for already-saved. Four hand-kept
// copies of a shape whose equality is load-bearing is a data bug waiting for someone to
// add a field to three of them.
export function buildSavePayload(
  step: string,
  segments: Segment[],
  compositions: CompositionPool,
  output: OutputSettings,
  exportSettings: ExportSettings
) {
  return {
    step,
    segments: serializeSegments(segments),
    // The pool is already pure JSON (hydration normalizes it); it rides the same
    // payload as the segments that reference it, so the two can't save out of step.
    // Orphans (nothing reachable from any segment's root) are pruned FROM THE
    // PAYLOAD, not from the state: an in-session undo that restores the last
    // reference finds the composition still in memory and simply saves it again.
    compositions: pruneOrphans(compositions, segments),
    output,
    export: exportSettings,
  };
}

export interface UploadRequest {
  file: File | null;
  youtubeUrl: string;
  ytStart: string;
  ytEnd: string;
  lyrics: string;
  lyricsFile: File | null;
}

export function useProject() {
  // projects | upload | processing | review | studio | export | error
  const [step, setStep] = useState("projects");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState(false);

  const [job, setJob] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [duration, setDuration] = useState(0);
  const [originalSpec, setOriginalSpec] = useState("");
  // The project's asset library — cards read clip metadata from it (the montage's
  // per-slot duration warning) instead of probing the source files in the browser.
  const [assets, setAssets] = useState<Asset[]>([]);
  const [stems, setStems] = useState<
    Record<string, { sr?: number; spectrogram?: string; audio?: string }>
  >({});

  const [segments, setSegments] = useState<Segment[]>([]);
  // The composition pool — every animation graph in the project, addressed by id;
  // segments (and later montage extracts) reference into it. Saves with segments.
  const [compositions, setCompositions] = useState<CompositionPool>({});

  // When a segment's START moves (a boundary drag on the review screen), its root
  // composition's montage breakpoints — stored in window-LOCAL seconds — would slide
  // against the MUSIC while the gate cuts stay on their beats. Reconcile here, off a
  // baseline of starts by id: whatever path moved the boundary (60 Hz drag updaters
  // included — a wrapper around setSegments couldn't see those), the montage's local
  // times shift by the same delta so every hand-placed cut keeps its absolute
  // musical position. Incremental deltas over a drag sum to the total. The baseline
  // resets per project (a LOAD is not a boundary edit); a root shared by two
  // segments is left alone (one shift can't serve two windows).
  const segStartBaseline = useRef<Map<string, number>>(new Map());
  const compositionsRef = useRef(compositions);
  compositionsRef.current = compositions;
  useEffect(() => {
    segStartBaseline.current = new Map();
  }, [job]);
  useEffect(() => {
    const base = segStartBaseline.current;
    segStartBaseline.current = new Map(segments.map((s) => [s.id, s.start]));
    let pool: CompositionPool | null = null;
    for (const s of segments) {
      const old = base.get(s.id);
      if (old === undefined || !s.rootCompositionId) continue;
      const delta = s.start - old;
      if (Math.abs(delta) < 1e-4) continue;
      if (segments.some((o) => o.id !== s.id && o.rootCompositionId === s.rootCompositionId))
        continue;
      const src: CompositionPool[string] | undefined = (pool ?? compositionsRef.current)[
        s.rootCompositionId
      ];
      if (!src) continue;
      const g = shiftMontageLocalTimes(src.graph, delta);
      if (g !== src.graph) {
        pool = {
          ...(pool ?? compositionsRef.current),
          [s.rootCompositionId]: { ...src, graph: g },
        };
      }
    }
    if (pool) setCompositions(pool);
  }, [segments]);

  const [vocalEnvelope, setVocalEnvelope] = useState<number[]>([]);
  const [envelopeTimes, setEnvelopeTimes] = useState<number[]>([]);
  const [lyricLines, setLyricLines] = useState<LyricLine[]>([]);
  const [activeSegId, setActiveSegId] = useState<string | null>(null);
  // Project-wide animation output settings (size/quality/fps/background).
  const [output, setOutput] = useState(OUTPUT_DEFAULTS);
  // Final-export settings (HD size/fps/detail/background) — used by the export stage.
  const [exportSettings, setExportSettings] = useState(EXPORT_DEFAULTS);
  const lastSaved = useRef("");
  // Background-job polls outlive the call that started them. Without a signal an
  // abandoned poll (unmount, or a second upload) keeps hitting /jobs and calling
  // setState forever, so every pollJob rides this controller.
  const pollAbort = useRef<AbortController | null>(null);
  const abortPoll = useCallback(() => {
    pollAbort.current?.abort();
    pollAbort.current = null;
  }, []);
  useEffect(() => abortPoll, [abortPoll]);

  // ---- autosave (debounced, serialized) --------------------------------------
  // Every project PUT rides ONE promise chain: two overlapping saves could commit
  // out of order server-side (the DB would keep the OLDER payload while the UI
  // thinks everything saved). The chain serializes them, and a queued save that a
  // newer edit superseded is skipped instead of writing stale state.
  const saveChain = useRef(createSaveChain());
  useEffect(() => {
    if (!job || (step !== "review" && step !== "studio" && step !== "export")) return;
    // Serialised INSIDE the debounce, not before it. `serializeSegments` + stringify walk
    // every segment's graph, and running them on the synchronous path meant paying for
    // them on every keystroke and every slider tick, ~800ms of which are then thrown away.
    // The equality guard moves in with them: scheduling a timer that decides to do nothing
    // is far cheaper than serialising the project to find out.
    const t = setTimeout(() => {
      const payload = buildSavePayload(step, segments, compositions, output, exportSettings);
      const jsonStr = JSON.stringify(payload);
      if (jsonStr === lastSaved.current) return;
      saveChain.current.supersedable(async () => {
        try {
          await api.saveProject(job, payload);
          lastSaved.current = jsonStr;
          setSaveError(false);
        } catch (e) {
          // lastSaved stays stale, so the next edit retries automatically; we
          // just flag it so the user knows the latest change isn't persisted.
          console.warn("autosave failed:", (e as Error)?.message || e);
          setSaveError(true);
        }
      });
    }, 800);
    return () => clearTimeout(t);
  }, [segments, compositions, step, job, output, exportSettings]);

  // ---- lyric line edits ------------------------------------------------------
  // Rewriting line TEXT (the wedding-lyrics flow) keeps the aligned timings. The
  // PUT must carry the full autosave payload — the backend writes segments
  // unconditionally — plus the optional lyric_lines the route persists to the
  // analysis cache. Local state updates on success so every consumer (lyrics
  // card preview, render keys) picks the new words up immediately. Joins the same
  // save chain so it can't interleave with an in-flight autosave.
  const saveLyricLines = useCallback(
    async (lines: LyricLine[]) => {
      if (!job) return;
      const base = buildSavePayload(step, segments, compositions, output, exportSettings);
      // `exclusive`: this payload carries lyric_lines the autosave payload lacks, so it
      // must never be skipped as superseded.
      return saveChain.current.exclusive(async () => {
        await api.saveProject(job, { ...base, lyric_lines: lines });
        setLyricLines(lines);
        lastSaved.current = JSON.stringify(base); // autosave needn't re-PUT this state
      });
    },
    [job, step, segments, compositions, output, exportSettings]
  );

  // ---- playground 💾 save fixture -------------------------------------------
  // Persist the CURRENT state first (the autosave is debounced — a sub-800ms edit may
  // not even be queued yet), then capture the DB into the committed fixture. Joins the
  // save chain so it can't interleave with an in-flight autosave.
  const saveFixture = useCallback(async (): Promise<api.FixtureExport> => {
    if (!job) throw new Error("no project open");
    const payload = buildSavePayload(step, segments, compositions, output, exportSettings);
    return saveChain.current.exclusive(async () => {
      await api.saveProject(job, payload);
      lastSaved.current = JSON.stringify(payload);
      return api.exportPlaygroundFixture();
    });
  }, [job, step, segments, compositions, output, exportSettings]);

  // ---- new track: upload + propose -----------------------------------------
  const handleUpload = useCallback(
    async ({ file, youtubeUrl, ytStart, ytEnd, lyrics, lyricsFile }: UploadRequest) => {
      setStep("processing");
      setError("");
      abortPoll();
      const ac = (pollAbort.current = new AbortController());
      try {
        setStatus(file ? "separating stems with demucs…" : "downloading audio from YouTube…");
        const fd = new FormData();
        if (file) fd.append("file", file);
        else if (youtubeUrl) {
          fd.append("youtube_url", youtubeUrl);
          if (ytStart) fd.append("yt_start", ytStart);
          if (ytEnd) fd.append("yt_end", ytEnd);
        }
        if (lyricsFile) fd.append("lyrics_file", lyricsFile);
        else if (lyrics && lyrics.trim()) fd.append("lyrics", lyrics);

        // Both stages run in the background now; kick them off and poll for the
        // result, feeding each phase's label into the Processing screen.
        const { job_id } = await api.uploadSong(fd);
        const data = await api.pollJob<UploadResult>(job_id, setStatus, 1000, ac.signal);

        setJob(data.job_id);
        setTitle(data.title || "");
        setDuration(data.duration || 0);
        setStems(data.stems);
        setOriginalSpec(data.stems.original?.spectrogram || "");

        await api.segmentJob(job_id);
        const segData = await api.pollJob<SegmentProposal>(job_id, setStatus, 1000, ac.signal);
        setVocalEnvelope(segData.vocal_envelope || []);
        setEnvelopeTimes(segData.envelope_times || []);
        setLyricLines(segData.lyric_lines || []);
        if (segData.duration) setDuration(segData.duration);
        lastSaved.current = "";
        setSegments(hydrateSegments(segData.segments, data.stems));
        setCompositions({}); // a fresh project has no animations yet
        setStep("review");
      } catch (e) {
        if ((e as DOMException)?.name === "AbortError") return; // we walked away; not an error
        setError((e as Error).message);
        setStep("error");
      }
    },
    [abortPoll]
  );

  // ---- resume an existing project ------------------------------------------
  const openProject = useCallback(async (id: string) => {
    setStep("processing");
    setStatus("loading project…");
    setError("");
    try {
      const p = await api.getProject(id);
      setJob(p.job_id);
      setTitle(p.title || "");
      setDuration(p.duration || 0);
      setStems(p.stems || {});
      setAssets(p.assets || []);
      setOriginalSpec(p.stems?.original?.spectrogram || "");
      setVocalEnvelope(p.vocal_envelope || []);
      setLyricLines(p.lyric_lines || []);
      setEnvelopeTimes(p.envelope_times || []);
      const segs = hydrateSegments(p.segments, p.stems || {});
      setSegments(segs);
      // Orphans from past sessions (references removed after their last save)
      // are collected on the way in.
      const pool = pruneOrphans(hydrateCompositions(p.compositions), segs);
      setCompositions(pool);
      setActiveSegId(segs[0]?.id || null);
      const loadedOutput = withOutputDefaults(p.output);
      setOutput(loadedOutput);
      const loadedExport = withExportDefaults(p.export);
      setExportSettings(loadedExport);
      // If hydration added missing default signals, leave lastSaved empty so the
      // autosave persists them; otherwise mark as already-saved (no redundant PUT).
      const loadedCount = (p.segments || []).reduce(
        (a: number, s: { signals?: unknown[] }) => a + (s.signals || []).length,
        0
      );
      const mergedCount = segs.reduce((a, s) => a + s.signals.length, 0);
      lastSaved.current =
        mergedCount === loadedCount
          ? JSON.stringify(
              buildSavePayload(p.step || "studio", segs, pool, loadedOutput, loadedExport)
            )
          : "";
      setStep(p.step || "studio");
    } catch (e) {
      setError((e as Error).message);
      setStep("error");
    }
  }, []);

  // The Playground: the always-present, app-managed project (one pipeline per card).
  // Built lazily on first open, then loaded into the Studio like any project.
  const openPlayground = useCallback(async () => {
    setStep("processing");
    setStatus("preparing playground…");
    setError("");
    try {
      const { job_id } = await api.ensurePlayground();
      await openProject(job_id);
    } catch (e) {
      setError((e as Error).message);
      setStep("error");
    }
  }, [openProject]);

  const validateSplit = useCallback(() => {
    if (segments.length) setActiveSegId(segments[0].id);
    setStep("studio");
  }, [segments]);

  // Splitting touches BOTH halves of the project state (the second half gets a
  // cloned composition), so the handler lives here where both setters are; the
  // review screen's other edits (move/merge) stay pure segment updaters.
  const splitSegmentsAt = useCallback(
    (t: number) => {
      const res = splitAt(segments, compositions, t);
      setSegments(() => res.segments);
      setCompositions(res.pool);
    },
    [segments, compositions]
  );

  const toProjects = useCallback(() => {
    abortPoll(); // leaving the flow stops any upload/segment poll still running
    setSegments([]);
    setCompositions({});
    setActiveSegId(null);
    setJob(null);
    setError("");
    lastSaved.current = "";
    setStep("projects");
  }, [abortPoll]);

  return {
    // state
    step,
    status,
    error,
    saveError,
    job,
    title,
    duration,
    originalSpec,
    assets,
    stems,
    segments,
    compositions,
    vocalEnvelope,
    envelopeTimes,
    lyricLines,
    activeSegId,
    output,
    exportSettings,
    // setters the screens drive directly
    setStep,
    setSegments,
    setCompositions,
    setActiveSegId,
    setOutput,
    setExportSettings,
    // whole-project actions
    handleUpload,
    openProject,
    openPlayground,
    validateSplit,
    splitSegmentsAt,
    toProjects,
    saveLyricLines,
    saveFixture,
  };
}

export type Project = ReturnType<typeof useProject>;
