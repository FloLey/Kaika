import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ChangeEvent } from "react";
import SegmentRail from "./SegmentRail";
import SignalCard from "./SignalCard";
import TransportClock from "./TransportClock";
import AnimationCanvas from "../animation/AnimationCanvas";
import OutputSettings from "../animation/OutputSettings";
import AssetLibrary from "../assets/AssetLibrary";
import { defaultCardName } from "../animation/nodeInputs";
import { addAssetCard, emptyGraph } from "../../lib/graphModel";
import type { Asset as AssetT, LyricLine } from "../../lib/types";
import VolumeControl from "./VolumeControl";
import ConfirmDialog from "../../ui/ConfirmDialog";
import { useStudioPlayback } from "./useStudioPlayback";
import { engine } from "../../lib/audio";
import { STEM_META, seedSignal } from "../../lib/segments";
import { copyLayout, createComposition, refCounts as poolRefCounts } from "../../lib/compositions";
import type {
  CompositionPool,
  Graph,
  OutputSettings as OutputSettingsT,
  Segment,
  Signal,
  StemInfo,
} from "../../lib/types";

interface StudioProps {
  segments: Segment[];
  setSegments: (updater: (prev: Segment[]) => Segment[]) => void;
  compositions: CompositionPool;
  setCompositions: (updater: (prev: CompositionPool) => CompositionPool) => void;
  activeSegId?: string;
  setActiveSegId: (id: string) => void;
  stems: Record<string, StemInfo>;
  duration?: number;
  job?: string;
  output: OutputSettingsT;
  setOutput: (o: OutputSettingsT) => void;
  // The final-export settings — the Output cards' HD render uses exactly these.
  exportSettings?: import("../../lib/export").ExportSettings;
  assets?: import("../../lib/types").Asset[];
  lyricLines?: LyricLine[];
  onSaveLyricLines?: (lines: LyricLine[]) => Promise<void>;
  // Which mix the shared transport plays ("instrumental" while building a cover
  // keeps the old vocal from fighting the new words).
  audioMode?: "original" | "instrumental";
  onEditSplit?: () => void;
  onExport?: () => void;
  // Playground only: capture the live state into the committed fixture (💾 in the rail).
  onSaveFixture?: () => Promise<import("../../lib/api").FixtureExport>;
}

// Stage 3 — the studio. Owns all playback/ephemeral state (rail open, what's
// playing, the full-mix reference clock, the per-signal audio registry) and the
// per-segment signal edits. App owns the project (segments/activeSegId) and
// passes setters down. Unmounting (leaving the studio) tears the audio graph
// down via the cleanup effect, so App never reaches into these internals.
export default function Studio({
  segments,
  setSegments,
  compositions,
  setCompositions,
  activeSegId,
  setActiveSegId,
  stems,
  duration,
  job,
  output,
  setOutput,
  exportSettings,
  assets,
  lyricLines,
  onSaveLyricLines,
  audioMode,
  onEditSplit,
  onExport,
  onSaveFixture,
}: StudioProps) {
  const [railOpen, setRailOpen] = useState(true);
  // The Playground is about the cards, so it lands on the animation tab; a normal
  // project opens on signals (extract first, then animate).
  const [tab, setTab] = useState(job === "playground" ? "animation" : "signals"); // "signals" | "animation"
  const [showOutput, setShowOutput] = useState(false); // output-settings modal
  const [showAssets, setShowAssets] = useState(false); // asset-library manager modal

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

  // ---- composition navigation (the breadcrumb) --------------------------------
  // Exactly ONE composition is on screen: the segment's root, or — after "open"
  // on a montage extract — a child, any depth down. Each frame snapshots the
  // extract's absolute song WINDOW at entry (computed by the montage card from
  // its cut schedule): the child edits can't move the parent's cuts (the trigger
  // lives in the parent), so the snapshot stays true while you're inside, and the
  // transport/previews below simply follow the current window.
  interface NavFrame {
    // "comp" = a child composition's canvas; "montage" = the montage EDITOR over a
    // montage card of the frame's composition (same composition, richer surface).
    kind: "comp" | "montage";
    compositionId: string;
    montageNodeId?: string; // montage frames only
    label: string; // "extract 3 · clip name" / the montage's name — the breadcrumb text
    window: { start: number; end: number }; // absolute song seconds
  }
  const [navStack, setNavStack] = useState<NavFrame[]>([]);
  useEffect(() => setNavStack([]), [activeSegId]); // a new segment starts at its root
  const navFrame = navStack.length ? navStack[navStack.length - 1] : null;
  const currentCompId = navFrame?.compositionId ?? activeSeg?.rootCompositionId;
  const activeComp = (currentCompId && compositions[currentCompId]) || null;
  // A frame whose composition — or, for a montage frame, whose montage card —
  // vanished (deleted in another view) pops itself.
  useEffect(() => {
    if (!navFrame) return;
    const comp = compositions[navFrame.compositionId];
    const gone =
      !comp ||
      (navFrame.kind === "montage" &&
        !comp.graph.nodes.some((n) => n.id === navFrame.montageNodeId && n.type === "montage"));
    if (gone) setNavStack((s) => s.slice(0, -1));
  }, [navFrame, compositions]);

  // No segment selected → the window is the whole track, so the full mix can play
  // before any segment exists. Fall back to the audio element's own duration when
  // the `duration` prop isn't known yet (otherwise winEnd=0 loops instantly = silence).
  // Inside an extract, the window IS the extract's: the transport plays just that
  // slice of the song, so the live view scrubs against the right bars.
  const [mediaDuration, setMediaDuration] = useState(0);
  const winStart = navFrame ? navFrame.window.start : activeSeg ? activeSeg.start : 0;
  const winEnd = navFrame
    ? navFrame.window.end
    : activeSeg
      ? activeSeg.end
      : duration || mediaDuration || 0;
  const segLen = Math.max(0.001, winEnd - winStart);
  // "used ×N" per composition (segment roots + extracts) — the reuse picker's
  // indicator and the last-reference confirm read it through ctx.
  const compRefCounts = useMemo(
    () => poolRefCounts(compositions, segments),
    [compositions, segments]
  );

  // What the canvas edits: the host segment, re-windowed to the current frame —
  // every consumer (previews, render keys, signal resolution) reads start/end +
  // signals off ctx.segment, so re-windowing here drives them all at once.
  const viewSegment = useMemo(
    () => (activeSeg && navFrame ? { ...activeSeg, start: winStart, end: winEnd } : activeSeg),
    [activeSeg, navFrame, winStart, winEnd]
  );

  // The audio engine + transport (full-mix clock, per-signal registry, play/seek/
  // solo/volume) lives in this hook; Studio just wires its output into the view.
  const {
    refAudio,
    audioProps,
    allPlaying,
    subscribeClock,
    getClockT,
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

  const selectSegment = useCallback(
    (id: string) => {
      resetTransport();
      setNavStack([]); // back to the root even when re-clicking the same segment
      setActiveSegId(id);
    },
    [resetTransport, setActiveSegId]
  );

  // "Open" on a montage extract: descend into its child composition. The card
  // computes the window (it owns the cut schedule) and hands it over.
  const enterExtract = useCallback(
    (montageNodeId: string, extractId: string, window: { start: number; end: number }) => {
      const comp = activeComp;
      if (!comp) return;
      const mg = comp.graph.nodes.find((n) => n.id === montageNodeId && n.type === "montage");
      const extracts = mg?.type === "montage" ? mg.data.extracts : [];
      const idx = extracts.findIndex((x) => x.id === extractId);
      const child = idx >= 0 ? compositions[extracts[idx].compositionId] : undefined;
      if (!child) return;
      resetTransport();
      setNavStack((s) => [
        ...s,
        {
          kind: "comp",
          compositionId: child.id,
          label: `extract ${idx + 1} · ${child.name}`,
          window,
        },
      ]);
    },
    [activeComp, compositions, resetTransport]
  );

  // A montage card's compact body opens the MONTAGE EDITOR — its own breadcrumb
  // level over the SAME composition and window (the strip + live view + wiring
  // rail want the full canvas area, not a modal).
  const enterMontage = useCallback(
    (montageNodeId: string) => {
      const comp = activeComp;
      if (!comp) return;
      const mg = comp.graph.nodes.find((n) => n.id === montageNodeId && n.type === "montage");
      if (!mg) return;
      setNavStack((s) => [
        ...s,
        {
          kind: "montage",
          compositionId: comp.id,
          montageNodeId,
          label: mg.name || "montage",
          window: { start: winStart, end: winEnd },
        },
      ]);
    },
    [activeComp, winStart, winEnd]
  );

  // The breadcrumb: click the segment crumb (depth -1) or any ancestor frame to
  // pop back to it.
  const navTo = useCallback(
    (depth: number) => {
      resetTransport();
      setNavStack((s) => s.slice(0, Math.max(0, depth)));
    },
    [resetTransport]
  );

  // Double-click the CURRENT crumb to rename the open composition — a shared
  // composition's name is how the reuse picker and every referencing strip tile
  // identify it, so it's editable where you're already looking at it.
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const commitRename = useCallback(() => {
    const name = renameDraft?.trim();
    setRenameDraft(null);
    if (!name || !navFrame || navFrame.kind !== "comp" || !currentCompId) return;
    setCompositions((pool) =>
      pool[currentCompId] ? { ...pool, [currentCompId]: { ...pool[currentCompId], name } } : pool
    );
    // The frame label snapshots the name at entry — follow the rename.
    setNavStack((s) =>
      s.map((f, i) =>
        i === s.length - 1 ? { ...f, label: f.label.replace(/·[^·]*$/, `· ${name}`) } : f
      )
    );
  }, [renameDraft, navFrame, currentCompId, setCompositions]);

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

  // The animation graph lives on the CURRENT composition in the pool (the root, or
  // the child the breadcrumb points at); patch it and let App's autosave persist
  // pool + segments together. The FIRST edit of a segment with no animation creates
  // its root composition and points the segment at it — two state updates from one
  // discrete event (the reference and the entry must land together, and neither
  // setter can reach the other's state). A NESTED composition always exists (an
  // extract references it), so creation only ever happens at the root.
  const setActiveGraph = useCallback(
    (graph: Graph) => {
      if (currentCompId && compositions[currentCompId]) {
        setCompositions((pool) => ({
          ...pool,
          [currentCompId]: { ...pool[currentCompId], graph },
        }));
        return;
      }
      if (!activeSeg || navFrame) return;
      const comp = createComposition(activeSeg.label, graph);
      setCompositions((pool) => ({ ...pool, [comp.id]: comp }));
      setSegments((prev) =>
        prev.map((s) => (s.id === activeSeg.id ? { ...s, rootCompositionId: comp.id } : s))
      );
    },
    [activeSeg, navFrame, currentCompId, compositions, setCompositions, setSegments]
  );

  // Mark (or clear, with an empty id) the composition's "final" output — the one
  // the export stage renders (for the root) or the extract plays (for a child).
  // Lives on the composition (`outputId`), same autosave path as a graph edit. An
  // OutputNode toggles this via ctx.setFinalOutput.
  const setFinalOutput = useCallback(
    (nodeId: string) => {
      if (!currentCompId) return; // no composition yet — nothing to mark
      setCompositions((pool) =>
        pool[currentCompId]
          ? { ...pool, [currentCompId]: { ...pool[currentCompId], outputId: nodeId || undefined } }
          : pool
      );
    },
    [currentCompId, setCompositions]
  );

  // Copy the current segment's card layout (its root composition) onto an ADJACENT
  // segment (previous or next), so you can build once and reuse the pipeline up or
  // down the track. `copyLayout` clones the composition AND rewires its signal cards
  // onto the target segment's own signals (matching bands, cloning any it's missing)
  // — so the copy drives the right segment, never the source.
  const segIdx = useMemo(
    () => segments.findIndex((s) => s.id === activeSegId),
    [segments, activeSegId]
  );
  const prevSeg = segIdx > 0 ? segments[segIdx - 1] : null;
  const nextSeg = segIdx >= 0 && segIdx + 1 < segments.length ? segments[segIdx + 1] : null;
  const hasCards = !!activeComp?.graph.nodes?.length;
  const segHasCards = useCallback(
    (seg: Segment | null) =>
      !!(seg?.rootCompositionId && compositions[seg.rootCompositionId]?.graph.nodes?.length),
    [compositions]
  );
  const runCopyLayout = useCallback(
    (target: Segment) => {
      if (!activeSeg) return;
      const res = copyLayout(activeSeg, target, compositions);
      setCompositions(() => res.pool);
      setSegments((prev) => prev.map((s) => (s.id === target.id ? res.target : s)));
      selectSegment(target.id); // follow the copy onto the target segment
    },
    [activeSeg, compositions, setCompositions, setSegments, selectSegment]
  );
  // Clicking an asset in the library DROPS ITS CARD on the canvas, already pointing at
  // that file — the montage workflow is "pick twenty clips", and doing that through the
  // palette meant: add card, open its library, pick, repeat. The modal stays open so a
  // run of clips is a run of clicks; cards stack in a column under the existing graph so
  // nothing lands on top of anything.
  const [addedCount, setAddedCount] = useState(0);
  const dropAssetCard = useCallback(
    (asset: AssetT) => {
      if (!activeSeg) return;
      const base = activeComp?.graph || emptyGraph();
      setActiveGraph(addAssetCard(base, asset, defaultCardName(base, asset.kind)));
      setAddedCount((n) => n + 1);
      setTab("animation"); // the card lands on the canvas — show it
    },
    [activeSeg, activeComp, setActiveGraph]
  );

  // Overwriting a segment that already has cards asks first (the target's animation
  // is replaced wholesale); an empty target copies straight through.
  const [copyTarget, setCopyTarget] = useState<Segment | null>(null);
  const copyLayoutTo = useCallback(
    (target: Segment | null) => {
      if (!target || !hasCards) return;
      if (segHasCards(target)) setCopyTarget(target);
      else runCopyLayout(target);
    },
    [hasCards, segHasCards, runCopyLayout]
  );

  return (
    <div className={"studio" + (railOpen ? "" : " rail-collapsed")}>
      {railOpen ? (
        <SegmentRail
          segments={segments}
          activeSegId={activeSegId}
          onSelect={selectSegment}
          onCollapse={() => setRailOpen(false)}
          grouped={job === "playground"}
          onSaveFixture={onSaveFixture}
        />
      ) : (
        <button className="rail-reopen" title="Show segments" onClick={() => setRailOpen(true)}>
          ☰
        </button>
      )}
      <div className={"studio-main" + (isFull ? " full" : "")} ref={studioMainRef}>
        <audio
          ref={refAudio}
          src={
            job ? `/audio/${job}/${audioMode === "instrumental" ? "instrumental" : "original"}` : ""
          }
          preload="auto"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (isFinite(d)) setMediaDuration(d);
          }}
          {...audioProps}
        />
        <div className="results-head">
          <span className="section-title">
            {navStack.length ? (
              // The breadcrumb: segment ▸ extract 3 · clip ▸ … — every ancestor is a
              // click back up; exactly one composition's graph is on screen at a time.
              <span className="comp-breadcrumb">
                <button className="crumb" onClick={() => navTo(0)}>
                  {activeSeg?.label.toUpperCase()}
                </button>
                {navStack.map((f, i) => (
                  <span key={`${f.compositionId}-${i}`}>
                    {" ▸ "}
                    {i === navStack.length - 1 ? (
                      renameDraft != null && f.kind === "comp" ? (
                        <input
                          className="crumb-rename"
                          value={renameDraft}
                          autoFocus
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename();
                            if (e.key === "Escape") setRenameDraft(null);
                          }}
                        />
                      ) : (
                        <span
                          className="crumb-here"
                          title={
                            f.kind === "comp"
                              ? "double-click to rename this composition"
                              : undefined
                          }
                          onDoubleClick={() =>
                            f.kind === "comp" && setRenameDraft(activeComp?.name || "")
                          }
                        >
                          {f.label}
                        </span>
                      )
                    ) : (
                      <button className="crumb" onClick={() => navTo(i + 1)}>
                        {f.label}
                      </button>
                    )}
                  </span>
                ))}
                <button className="btn sm crumb-up" onClick={() => navTo(navStack.length - 1)}>
                  ↩ up
                </button>
              </span>
            ) : (
              <>
                {activeSeg ? activeSeg.label.toUpperCase() : "FULL TRACK"}
                {/* The active tab already names the mode, so only the (informative) "by
                    track" nuance of the signals tab is worth spelling out in the title. */}
                {tab === "signals" ? " · EXTRACT SIGNALS BY TRACK" : ""}
              </>
            )}
          </span>
          <div className="controls">
            {/* Segment ACTIONS — kept visually distinct from the transport cluster. */}
            <div className="rh-actions">
              <button className="btn sm edit-split" onClick={onEditSplit}>
                ↩ edit split
              </button>
              {onExport && (
                <button
                  className="btn sm final-export"
                  onClick={onExport}
                  title="Render the whole track in HD (mark a final output per segment first)"
                >
                  Final export ▸
                </button>
              )}
              {tab === "animation" && !navFrame && (
                // One segmented control: copy this segment's card layout onto the
                // previous / next neighbour. Each side disables at its end of the track.
                // Hidden inside an extract — copying is a segment-root affair.
                <span className="rh-copy" role="group" aria-label="copy layout to a neighbour">
                  <span className="rh-copy-label">⧉ copy</span>
                  <button
                    className="btn sm rh-copy-btn"
                    onClick={() => copyLayoutTo(prevSeg)}
                    disabled={!(prevSeg && hasCards)}
                    title={
                      prevSeg
                        ? `Copy these cards to the previous segment (${prevSeg.label})`
                        : "No previous segment to copy to"
                    }
                  >
                    ‹ prev
                  </button>
                  <button
                    className="btn sm rh-copy-btn"
                    onClick={() => copyLayoutTo(nextSeg)}
                    disabled={!(nextSeg && hasCards)}
                    title={
                      nextSeg
                        ? `Copy these cards to the next segment (${nextSeg.label})`
                        : "No next segment to copy to"
                    }
                  >
                    next ›
                  </button>
                </span>
              )}
            </div>
            {/* TRANSPORT — grows to fill the row so the timeline stretches. */}
            <div className="rh-transport">
              <button
                className="btn on seg-play"
                onClick={playAll}
                title={allPlaying ? "Pause" : "Play segment"}
                aria-label={allPlaying ? "Pause" : "Play segment"}
              >
                {allPlaying ? "❚❚" : "▶"}
              </button>
              <TransportClock
                subscribe={subscribeClock}
                getClockT={getClockT}
                segLen={segLen}
                seek={seek}
              />
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
          : activeSeg &&
            viewSegment && (
              <AnimationCanvas
                // Keyed per COMPOSITION: entering an extract remounts the canvas
                // (fresh selection/undo — history is per composition).
                key={currentCompId || activeSeg.id}
                segment={viewSegment}
                graph={activeComp?.graph ?? null}
                finalOutputId={activeComp?.outputId}
                compositions={compositions}
                compositionId={currentCompId}
                refCounts={compRefCounts}
                updateCompositions={setCompositions}
                enterExtract={enterExtract}
                enterMontage={enterMontage}
                montageEditorNodeId={
                  navFrame?.kind === "montage" ? navFrame.montageNodeId : undefined
                }
                stems={stems}
                job={job}
                output={output}
                exportSettings={exportSettings}
                assets={assets}
                lyricLines={lyricLines}
                onSaveLyricLines={onSaveLyricLines}
                groupClock={refAudio}
                groupPlaying={allPlaying}
                isFullscreen={isFull}
                onToggleFullscreen={toggleFullscreen}
                onOpenOutput={() => setShowOutput(true)}
                onGraphChange={setActiveGraph}
                setFinalOutput={setFinalOutput}
              />
            )}

        {showOutput && (
          <OutputSettings
            output={output}
            onChange={setOutput}
            onClose={() => setShowOutput(false)}
          />
        )}
        {showAssets && (
          <AssetLibrary
            jobId={job}
            onPick={activeSeg ? dropAssetCard : undefined}
            pickLabel={
              addedCount ? `${addedCount} card${addedCount === 1 ? "" : "s"} added` : undefined
            }
            onClose={() => {
              setShowAssets(false);
              setAddedCount(0);
            }}
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
          <button className="mode-tab mode-tab-assets" onClick={() => setShowAssets(true)}>
            📚 assets
          </button>
        </nav>
      </div>

      <ConfirmDialog
        open={!!copyTarget}
        message={`Replace “${copyTarget?.label}”'s animation with this segment's layout?`}
        confirmLabel="Replace"
        danger
        onConfirm={() => {
          if (copyTarget) runCopyLayout(copyTarget);
          setCopyTarget(null);
        }}
        onCancel={() => setCopyTarget(null)}
      />
    </div>
  );
}
