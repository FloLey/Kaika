import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ChangeEvent } from "react";
import SegmentRail from "./SegmentRail";
import SignalCard from "./SignalCard";
import AnimationCanvas from "../animation/AnimationCanvas";
import OutputSettings from "../animation/OutputSettings";
import VolumeControl from "./VolumeControl";
import { useStudioPlayback } from "./useStudioPlayback";
import { engine } from "../../lib/audio";
import { STEM_META, seedSignal, copyLayout } from "../../lib/segments";
import { fmtTime } from "../../lib/mel";
import type {
  Graph,
  OutputSettings as OutputSettingsT,
  Segment,
  Signal,
  StemInfo,
} from "../../lib/types";

interface StudioProps {
  segments: Segment[];
  setSegments: (updater: (prev: Segment[]) => Segment[]) => void;
  activeSegId?: string;
  setActiveSegId: (id: string) => void;
  stems: Record<string, StemInfo>;
  duration?: number;
  job?: string;
  output: OutputSettingsT;
  setOutput: (o: OutputSettingsT) => void;
  lyricLines?: unknown[];
  onEditSplit?: () => void;
}

// Stage 3 — the studio. Owns all playback/ephemeral state (rail open, what's
// playing, the full-mix reference clock, the per-signal audio registry) and the
// per-segment signal edits. App owns the project (segments/activeSegId) and
// passes setters down. Unmounting (leaving the studio) tears the audio graph
// down via the cleanup effect, so App never reaches into these internals.
export default function Studio({
  segments,
  setSegments,
  activeSegId,
  setActiveSegId,
  stems,
  duration,
  job,
  output,
  setOutput,
  lyricLines,
  onEditSplit,
}: StudioProps) {
  const [railOpen, setRailOpen] = useState(true);
  // The Playground is about the cards, so it lands on the animation tab; a normal
  // project opens on signals (extract first, then animate).
  const [tab, setTab] = useState(job === "playground" ? "animation" : "signals"); // "signals" | "animation"
  const [showOutput, setShowOutput] = useState(false); // output-settings modal

  // Fullscreen the WHOLE studio panel (timeline + canvas + output modal + tabs), not
  // just the canvas — so the segment transport stays visible and the settings modal,
  // which lives in this subtree, still renders on top in fullscreen.
  const studioMainRef = useRef<HTMLDivElement>(null);
  const [isFull, setIsFull] = useState(false);
  useEffect(() => {
    const onFs = () => setIsFull(document.fullscreenElement === studioMainRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  const toggleFullscreen = useCallback(() => {
    const el = studioMainRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.().catch(() => {});
  }, []);

  const activeSeg = useMemo(
    () => segments.find((s) => s.id === activeSegId) || null,
    [segments, activeSegId]
  );
  // No segment selected → the window is the whole track, so the full mix can play
  // before any segment exists. Fall back to the audio element's own duration when
  // the `duration` prop isn't known yet (otherwise winEnd=0 loops instantly = silence).
  const [mediaDuration, setMediaDuration] = useState(0);
  const winStart = activeSeg ? activeSeg.start : 0;
  const winEnd = activeSeg ? activeSeg.end : duration || mediaDuration || 0;
  const segLen = Math.max(0.001, winEnd - winStart);

  // The audio engine + transport (full-mix clock, per-signal registry, play/seek/
  // solo/volume) lives in this hook; Studio just wires its output into the view.
  const {
    refAudio,
    audioProps,
    allPlaying,
    clockT,
    volume,
    setVolume,
    loop,
    setLoop,
    seek,
    playAll,
    resetTransport,
    registerAudio,
    onPlayingChange,
    handleSolo,
  } = useStudioPlayback({ activeSeg, winStart, winEnd, segLen });

  function selectSegment(id: string) {
    resetTransport();
    setActiveSegId(id);
  }

  // ---- per-segment signal edits --------------------------------------------
  const editActiveSignals = useCallback(
    (fn: (sigs: Signal[]) => Signal[]) => {
      setSegments((prev) =>
        prev.map((s) => (s.id === activeSegId ? { ...s, signals: fn(s.signals) } : s))
      );
    },
    [activeSegId, setSegments]
  );

  const updateSignal = useCallback(
    (id: string, p: Partial<Signal>) => {
      editActiveSignals((sigs) => sigs.map((s) => (s.id === id ? { ...s, ...p } : s)));
    },
    [editActiveSignals]
  );

  const addSignal = useCallback(
    (stemKey: string) => {
      editActiveSignals((sigs) => {
        const meta = STEM_META.find((m: { key: string }) => m.key === stemKey);
        const n = sigs.filter((s) => s.stemKey === stemKey).length + 1;
        const name = `${(meta?.name || stemKey).toLowerCase()} ${n}`;
        return [...sigs, seedSignal(stems, name, stemKey)];
      });
    },
    [editActiveSignals, stems]
  );

  const removeSignal = useCallback(
    (id: string) => {
      engine.remove(id);
      registerAudio(id, null); // drop it from the playback registry
      editActiveSignals((sigs) => sigs.filter((s) => s.id !== id));
    },
    [editActiveSignals, registerAudio]
  );

  // The animation graph is a whole-segment field (segment.graph); patch it and let
  // App's autosave persist it alongside signals.
  const setActiveGraph = useCallback(
    (graph: Graph) => {
      setSegments((prev) => prev.map((s) => (s.id === activeSegId ? { ...s, graph } : s)));
    },
    [activeSegId, setSegments]
  );

  // Copy the current segment's card layout (its whole animation graph) onto the NEXT
  // segment, so you can build once and reuse the pipeline down the track. `copyLayout`
  // deep-copies the graph AND rewires its signal cards onto the next segment's own
  // signals (matching bands, cloning any it's missing) — so the copy drives the right
  // segment, never the previous one.
  const segIdx = useMemo(() => segments.findIndex((s) => s.id === activeSegId), [segments, activeSegId]);
  const nextSeg = segIdx >= 0 && segIdx + 1 < segments.length ? segments[segIdx + 1] : null;
  const canCopyLayout = !!(nextSeg && activeSeg?.graph?.nodes?.length);
  const copyLayoutToNext = useCallback(() => {
    if (!nextSeg || !activeSeg?.graph?.nodes?.length) return;
    if (
      nextSeg.graph?.nodes?.length &&
      !window.confirm(`Replace “${nextSeg.label}”'s animation with this segment's layout?`)
    ) {
      return;
    }
    const updated = copyLayout(activeSeg, nextSeg);
    setSegments((prev) => prev.map((s) => (s.id === nextSeg.id ? updated : s)));
  }, [nextSeg, activeSeg, setSegments]);

  return (
    <div className={"studio" + (railOpen ? "" : " rail-collapsed")}>
      {railOpen ? (
        <SegmentRail
          segments={segments}
          activeSegId={activeSegId}
          onSelect={selectSegment}
          onCollapse={() => setRailOpen(false)}
          grouped={job === "playground"}
        />
      ) : (
        <button className="rail-reopen" title="Show segments" onClick={() => setRailOpen(true)}>
          ☰
        </button>
      )}
      <div className={"studio-main" + (isFull ? " full" : "")} ref={studioMainRef}>
        <audio
          ref={refAudio}
          src={job ? `/audio/${job}/original` : ""}
          preload="auto"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (isFinite(d)) setMediaDuration(d);
          }}
          {...audioProps}
        />
        <div className="results-head">
          <span className="section-title">
            {activeSeg ? activeSeg.label.toUpperCase() : "FULL TRACK"} ·{" "}
            {tab === "signals" ? "EXTRACT SIGNALS BY TRACK" : "CREATE ANIMATION"}
          </span>
          <div className="controls">
            <button className="btn sm edit-split" onClick={onEditSplit}>
              ↩ edit split
            </button>
            {tab === "animation" && (
              <button
                className="btn sm"
                onClick={copyLayoutToNext}
                disabled={!canCopyLayout}
                title={
                  nextSeg
                    ? `Copy these cards to the next segment (${nextSeg.label})`
                    : "No next segment to copy to"
                }
              >
                ⧉ copy → next
              </button>
            )}
            <button
              className="btn on seg-play"
              onClick={playAll}
              title={allPlaying ? "Pause" : "Play segment"}
              aria-label={allPlaying ? "Pause" : "Play segment"}
            >
              {allPlaying ? "❚❚" : "▶"}
            </button>
            <input
              className="seg-timeline"
              type="range"
              min={0}
              max={segLen}
              step={0.01}
              value={Math.min(clockT, segLen)}
              onChange={(e: ChangeEvent<HTMLInputElement>) => seek(parseFloat(e.target.value))}
              title="segment timeline — scrub to navigate"
            />
            <span className="seg-time">
              {fmtTime(clockT)} / {fmtTime(segLen)}
            </span>
            <VolumeControl value={volume} onChange={setVolume} />
            <label className="loop-toggle" title="Loop the segment">
              <input
                type="checkbox"
                checked={loop}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setLoop(e.target.checked)}
              />
              loop
            </label>
          </div>
        </div>

        {tab === "signals"
          ? activeSeg &&
            STEM_META.filter((m: { key: string }) => stems[m.key]).map(
              (stem: { key: string; name: string; color: string }) => {
                const sigs = activeSeg.signals.filter((s) => s.stemKey === stem.key);
                return (
                  <div
                    className="track-group"
                    key={stem.key}
                    style={{ "--accent": stem.color } as CSSProperties}
                  >
                    <div className="track-group-head">
                      <span className="track-name">
                        <span className="dot" />
                        {stem.name}
                      </span>
                      <button className="btn sm" onClick={() => addSignal(stem.key)}>
                        + add band
                      </button>
                    </div>
                    {sigs.length === 0 && (
                      <div className="track-empty">
                        no signals — add a frequency band to extract one
                      </div>
                    )}
                    <div className="signals">
                      {sigs.map((sg) => (
                        <SignalCard
                          key={sg.id}
                          signal={sg}
                          stems={stems}
                          segStart={activeSeg.start}
                          segEnd={activeSeg.end}
                          duration={duration}
                          jobId={job}
                          onChange={updateSignal}
                          onRemove={removeSignal}
                          registerAudio={registerAudio}
                          onSolo={handleSolo}
                          onPlayingChange={onPlayingChange}
                          groupClock={refAudio}
                          groupPlaying={allPlaying}
                        />
                      ))}
                    </div>
                  </div>
                );
              }
            )
          : activeSeg && (
              <AnimationCanvas
                key={activeSeg.id}
                segment={activeSeg}
                stems={stems}
                job={job}
                output={output}
                lyricLines={lyricLines}
                groupClock={refAudio}
                groupPlaying={allPlaying}
                isFullscreen={isFull}
                onToggleFullscreen={toggleFullscreen}
                onOpenOutput={() => setShowOutput(true)}
                onGraphChange={setActiveGraph}
              />
            )}

        {showOutput && (
          <OutputSettings
            output={output}
            onChange={setOutput}
            onClose={() => setShowOutput(false)}
          />
        )}

        <nav className="mode-bar">
          <button
            className={"mode-tab" + (tab === "signals" ? " on" : "")}
            onClick={() => setTab("signals")}
          >
            extract signals by track
          </button>
          <button
            className={"mode-tab" + (tab === "animation" ? " on" : "")}
            onClick={() => setTab("animation")}
          >
            create animation
          </button>
        </nav>
      </div>
    </div>
  );
}
