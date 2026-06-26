import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ChangeEvent } from "react";
import SegmentRail from "./SegmentRail";
import SignalCard from "./SignalCard";
import type { Signal } from "./SignalCard";
import AnimationCanvas from "../animation/AnimationCanvas";
import OutputSettings from "../animation/OutputSettings";
import VolumeControl from "./VolumeControl";
import { useStudioPlayback } from "./useStudioPlayback";
import { engine } from "../../lib/audio.js";
import { STEM_META, seedSignal } from "../../lib/segments.js";
import { fmtTime } from "../../lib/mel.js";
import type { Graph, OutputSettings as OutputSettingsT } from "../../lib/types";
import type { NodeCtx } from "../animation/nodes/nodeProps";

// AnimationCanvas reads the segment through the loose NodeCtx carrier (signals as
// the index-signature `SignalDef`); our concrete `Signal` is a valid instance of
// that, so bridge it at the boundary rather than weakening `Signal` itself.
type AnimSegment = NonNullable<NodeCtx["segment"]> & { graph?: Graph };

type StemInfo = { sr?: number; spectrogram?: string; audio?: string };

export interface Segment {
  id: string;
  label: string;
  start: number;
  end: number;
  signals: Signal[];
  graph?: Graph;
}

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
  onEditSplit,
}: StudioProps) {
  const [railOpen, setRailOpen] = useState(true);
  const [tab, setTab] = useState("signals"); // "signals" | "animation"
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
  const winStart = activeSeg ? activeSeg.start : 0;
  const winEnd = activeSeg ? activeSeg.end : (duration ?? 0);
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

  return (
    <div className={"studio" + (railOpen ? "" : " rail-collapsed")}>
      {railOpen ? (
        <SegmentRail
          segments={segments}
          activeSegId={activeSegId}
          onSelect={selectSegment}
          onCollapse={() => setRailOpen(false)}
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
          {...audioProps}
        />
        <div className="results-head">
          <span className="section-title">
            {activeSeg ? activeSeg.label.toUpperCase() : "SEGMENT"} ·{" "}
            {tab === "signals" ? "EXTRACT SIGNALS BY TRACK" : "CREATE ANIMATION"}
          </span>
          <div className="controls">
            <button className="btn sm edit-split" onClick={onEditSplit}>
              ↩ edit split
            </button>
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
                segment={activeSeg as unknown as AnimSegment}
                stems={stems}
                job={job}
                output={output}
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
