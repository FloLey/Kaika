// The signal card's layout: three bands of disclosure.
//
// It replaced a card that put ~19 interactive things on screen at once when expanded —
// six sliders, a toggle, two number inputs, a select, a draggable spectrogram, two
// seekable views — with no hierarchy and no summary, so four bands on `drums` were four
// identical blocks you opened one at a time to tell apart, stacked in a single column
// so telling them apart also meant scrolling.
//
// Presentation only, and that split stays: `SignalCard` keeps every piece of logic (the
// audio element, the band-pass, the curve extraction, the shared clock) and hands the
// built views down. One implementation of the hard part, and a layout that can be
// reworked without touching it.

import { useState } from "react";
import type { ChangeEvent, CSSProperties, ReactNode } from "react";
import Ctl, { Toggle } from "../../ui/Ctl";
import Info from "../../ui/Info";
import { FEATURES, FEATURE_HELP, HELP } from "./signalCatalog";
import { shapeWords, summariseSignal } from "./signalSummary";
import type { Signal } from "../../lib/types";

export interface SignalCardViewProps {
  signal: Signal;
  patch: (p: Partial<Signal>) => void;
  onRemove: (id: string) => void;
  color: string;
  nyq: number;
  bandIgnored: boolean;
  playing: boolean;
  onTogglePlay: () => void;
  setBandMin: (v: string) => void;
  setBandMax: (v: string) => void;
  // Built by SignalCard so the wiring lives in one place.
  spectrogram: ReactNode;
  curveView: ReactNode;
  pulsePad: ReactNode;
}

function Section({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string;
  summary?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className={"sig-sec" + (open ? " open" : "")}>
      <button className="sig-sec-head" onClick={onToggle} aria-expanded={open}>
        <span className="sig-sec-caret">{open ? "▾" : "▸"}</span>
        <span className="sig-sec-title">{title}</span>
        {/* Closed sections still say what they hold — a disclosure that hides its
            own state just moves the problem. */}
        {!open && summary && <span className="sig-sec-summary">{summary}</span>}
      </button>
      {open && <div className="sig-sec-body">{children}</div>}
    </div>
  );
}

export default function SignalCardView({
  signal,
  patch,
  onRemove,
  color,
  nyq,
  bandIgnored,
  playing,
  onTogglePlay,
  setBandMin,
  setBandMax,
  spectrogram,
  curveView,
  pulsePad,
}: SignalCardViewProps) {
  // All closed by default: the curve and the pulse below the header are what you
  // read most of the time, and they are never hidden.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  const feature = FEATURES.find((f) => f.key === signal.feature);
  const words = shapeWords(signal);

  return (
    <div className="signal sig-next" style={{ "--accent": color } as CSSProperties}>
      <div className="sig-next-head">
        <button className="play" onClick={onTogglePlay} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <div className="sig-next-id">
          <input
            className="signal-name"
            value={signal.name}
            onChange={(e: ChangeEvent<HTMLInputElement>) => patch({ name: e.target.value })}
            placeholder="signal name"
          />
          {/* The whole card in one line, derived — what makes four bands on one
              stem distinguishable without opening any of them. */}
          <span className="sig-next-summary" title={summariseSignal(signal)}>
            {summariseSignal(signal)}
          </span>
        </div>
        <button className="iconbtn" title="Remove signal" onClick={() => onRemove(signal.id)}>
          ✕
        </button>
      </div>

      {/* Always visible: the curve is the thing the card exists to produce. */}
      <div className="sig-next-live">
        <div className="sig-next-curve">{curveView}</div>
        {pulsePad}
      </div>

      <Section
        title="band"
        summary={
          bandIgnored
            ? "ignored for this feature"
            : `${Math.round(signal.minHz)}–${Math.round(signal.maxHz)} Hz`
        }
        open={!!open.band}
        onToggle={() => toggle("band")}
      >
        <div className="band-edit">
          <input
            type="number"
            className="hz-input"
            value={Math.round(signal.minHz)}
            min={0}
            max={nyq}
            step={10}
            disabled={bandIgnored}
            aria-label="band low"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setBandMin(e.target.value)}
          />
          <span className="hz-dash">–</span>
          <input
            type="number"
            className="hz-input"
            value={Math.round(signal.maxHz)}
            min={0}
            max={nyq}
            step={10}
            disabled={bandIgnored}
            aria-label="band high"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setBandMax(e.target.value)}
          />
          <span className="hz-unit">Hz</span>
          {bandIgnored && <span className="hz-note">band ignored for {signal.feature} phase</span>}
        </div>
        <div className={"signal-graphs" + (bandIgnored ? " band-ignored" : "")}>{spectrogram}</div>
      </Section>

      <Section
        title="feature"
        summary={feature?.label || signal.feature}
        open={!!open.feature}
        onToggle={() => toggle("feature")}
      >
        <div className="sig-feature-row">
          <select
            className="anim-select"
            value={signal.feature}
            aria-label="feature"
            onChange={(e: ChangeEvent<HTMLSelectElement>) => patch({ feature: e.target.value })}
          >
            {FEATURES.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
          <Info text={FEATURE_HELP[signal.feature] || HELP.signal} section="studio-features" />
        </div>
        <p className="sig-feature-help">{FEATURE_HELP[signal.feature] || HELP.signal}</p>
      </Section>

      <Section
        title="shape"
        summary={words.length ? words.join(", ") : "unshaped"}
        open={!!open.shape}
        onToggle={() => toggle("shape")}
      >
        <div className="signal-ctls">
          <Ctl
            label="attack"
            value={signal.attack}
            min={0}
            max={1000}
            step={1}
            onChange={(v: number) => patch({ attack: v })}
            fmt={(v: number) => v + "ms"}
            help={HELP.attack}
          />
          <Ctl
            label="release"
            value={signal.release}
            min={0}
            max={2000}
            step={5}
            onChange={(v: number) => patch({ release: v })}
            fmt={(v: number) => v + "ms"}
            help={HELP.release}
          />
          <Ctl
            label="gamma"
            value={signal.gamma}
            min={0.2}
            max={4}
            step={0.05}
            onChange={(v: number) => patch({ gamma: v })}
            fmt={(v: number) => v.toFixed(2)}
            help={HELP.gamma}
          />
          <Ctl
            label="thresh"
            value={signal.threshold}
            min={0}
            max={0.9}
            step={0.02}
            onChange={(v: number) => patch({ threshold: v })}
            fmt={(v: number) => v.toFixed(2)}
            help={HELP.thresh}
          />
          <Ctl
            label="gain"
            value={signal.gain}
            min={0}
            max={2}
            step={0.05}
            onChange={(v: number) => patch({ gain: v })}
            fmt={(v: number) => v.toFixed(2)}
            help={HELP.gain}
          />
          <Ctl
            label="offset"
            value={signal.offset}
            min={-0.5}
            max={0.5}
            step={0.02}
            onChange={(v: number) => patch({ offset: v })}
            fmt={(v: number) => v.toFixed(2)}
            help={HELP.offset}
          />
          {/* The shared primitive, instead of the hand-rolled `.btn` the classic
              card uses — `Toggle` has existed for exactly this and six node cards
              already use it. */}
          <Toggle
            label="invert"
            value={signal.invert}
            onChange={(v) => patch({ invert: v })}
            help={HELP.invert}
          />
        </div>
      </Section>
    </div>
  );
}
