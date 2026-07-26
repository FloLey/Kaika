// Segment labels and signal helpers. Segments are contiguous time ranges
// [start, end]; each segment owns a list of *signals* (a stem + frequency band
// + shaping -> a drawable curve that drives the simulation).
//
// These helpers munge dynamic, JSON-shaped signal/segment records (arbitrary
// shaping keys), so the working types are intentionally loose `any` records.
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Segment, Signal, StemInfo } from "./types";

type AnyRec = Record<string, any>;
type StemsMap = Record<string, StemInfo> | null | undefined;

// The persisted JSON shapes (what the backend sends / autosave writes) — looser
// than the in-memory Signal/Segment; hydrate* turns them into the canonical types.
export interface RawSignal {
  id?: string;
  name?: string;
  stemKey?: string;
  minHz?: number;
  maxHz?: number;
  feature?: string;
  [k: string]: unknown;
}
export interface RawSegment {
  id?: string;
  label: string;
  start: number;
  end: number;
  signals?: RawSignal[];
  rootCompositionId?: string;
}

export const LABELS = [
  "intro",
  "verse",
  "pre-chorus",
  "chorus",
  "bridge",
  "build",
  "drop",
  "break",
  "outro",
];

export const LABEL_COLOR: Record<string, string> = {
  intro: "#60A5FA",
  verse: "#34D399",
  "pre-chorus": "#22D3EE",
  chorus: "#FBBF24",
  bridge: "#F472B6",
  build: "#C084FC",
  drop: "#F87171",
  break: "#A3A3A3",
  outro: "#94A3B8",
};

export function labelColor(label?: string): string {
  return LABEL_COLOR[label ?? ""] || "#60A5FA";
}

// The stems demucs produces (+ the original mix), with display name and color.
export const STEM_META = [
  { key: "original", name: "FULL MIX", color: "#60A5FA" },
  { key: "vocals", name: "VOCALS", color: "#FBBF24" },
  { key: "drums", name: "DRUMS", color: "#F87171" },
  { key: "bass", name: "BASS", color: "#C084FC" },
  { key: "other", name: "OTHER", color: "#34D399" },
];

export function stemColor(stemKey?: string): string {
  return (STEM_META.find((m) => m.key === stemKey) || {}).color || "#60A5FA";
}

// Globally-unique ids. A plain session counter is NOT safe here: it resets on
// every page load / HMR while stored ids persist, so a freshly added item would
// collide with a resumed one — and an id collision makes edits hit every
// colliding item at once. UUIDs avoid that entirely. (Exported for the other id
// families — compositions.ts mints `comp-…` with it.)
export function rid(prefix: string): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function mkSegId() {
  return rid("seg");
}

export function mkSigId() {
  return rid("sig");
}

// Default shaping for a fresh signal: a kick-style snap (fast up, slow fade).
const SIGNAL_DEFAULTS: AnyRec = {
  feature: "energy",
  attack: 5,
  release: 250,
  invert: false,
  gamma: 1,
  gain: 1,
  offset: 0,
  threshold: 0,
};

const SIGNAL_FIELDS = ["id", "name", "stemKey", "minHz", "maxHz", ...Object.keys(SIGNAL_DEFAULTS)];

// A fresh signal on a given stem (full band by default).
export function seedSignal(stems: StemsMap, name?: string, stem?: string): Signal {
  const stemKey =
    stem || (stems?.original ? "original" : Object.keys(stems || {})[0] || "original");
  const sr = stems?.[stemKey]?.sr || 44100;
  return {
    id: mkSigId(),
    name: name || "signal",
    stemKey,
    minHz: 20,
    maxHz: Math.round(sr / 2),
    ...SIGNAL_DEFAULTS,
  } as Signal;
}

// Rebuild signals from saved ones (fill defaults + a fresh id if missing).
// Issue 2A: PRESERVE the stored id — graph `signalId` references depend on ids
// surviving a reload. Only mint a new id when one is absent or (defensively)
// duplicated. Safe because ids are UUIDs (a fresh signal can't collide with a
// resumed one). Regenerating every id here used to orphan every graph reference.
function hydrateSignals(stored: RawSignal[] | null | undefined): Signal[] {
  const seen = new Set();
  return (stored || []).map((s) => {
    let id = s.id;
    if (!id || seen.has(id)) id = mkSigId(); // keep stored id; mint only when absent/dup
    seen.add(id);
    return {
      id,
      name: s.name || "signal",
      stemKey: s.stemKey || "original",
      minHz: s.minHz ?? 20,
      maxHz: s.maxHz ?? 20000,
      ...SIGNAL_DEFAULTS,
      ...Object.fromEntries(
        Object.keys(SIGNAL_DEFAULTS).map((k) => [k, s[k] ?? SIGNAL_DEFAULTS[k]])
      ),
    };
  }) as Signal[];
}

function serializeSignals(signals: Signal[] | null | undefined): RawSignal[] {
  return (signals || []).map(
    (s) => Object.fromEntries(SIGNAL_FIELDS.map((k) => [k, (s as AnyRec)[k]])) as RawSignal
  );
}

// Default signals seeded on a fresh segment. Each entry is
// {feature, label, minHz?, maxHz?, ...shaping} — omit the band for the full range.
// Bands are rough starting points; drag the spectrogram handles to refine.
//
// FIFTEEN, down from 27. Every one of them has to be describable in one sentence
// of what you HEAR, because a signal you can't name is a signal you won't wire —
// and at 27 per segment (216 on an eight-segment track) the list was mostly noise
// you had to read past. Three rules produced this set:
//
//   - NO `chroma`. It is `argmax` over twelve pitch bins: a stepped curve saying
//     which note dominates. On `drums` that is meaningless — a kit is noise, so
//     the argmax of a snare is arbitrary and the curve just jumps around — and on
//     the full mix it is the argmax of everything at once. It only reads on
//     pitched, isolated material, which is a choice to make per project, not a
//     default on five tracks.
//   - ONE onset per stem, full-band. A drum hit is a BROADBAND transient, so
//     `kick onset` / `snare onset` / `hats onset` fire on very nearly the same
//     frames — three copies of `drums onset`. It is the ENERGY bands that
//     separate the elements, because those are frequency-selective.
//   - Bands only where the elements genuinely live apart: kick / snare / hats,
//     sub / low. Their sum is the stem's own loudness, so a full-band energy
//     beside them would be a fourth copy of the same thing.
//
// Everything dropped is still one click away under "+ add band" — including
// `flux` and `brightness`, which are easier to hear than chroma ever was.
const ENERGY = { feature: "energy", label: "energy" };
const ONSET = { feature: "onset", label: "onset" };
// Brightness MUST be seeded with a band, and this is the one thing about it that
// is easy to get wrong. `raw_brightness` restricts the centroid to [min,max]
// correctly, but then maps it LINEARLY across that range — while musical energy is
// roughly logarithmic in frequency. So a full-band (20 Hz–22 kHz) brightness puts
// a centroid that really sits around 1–2 kHz at ~0.05, and it moves by ~0.04 over
// a whole segment: a flat line you would have to crank `gain` to ~20 to see.
//
// Measured over 30 s on four real stems (useful swing = max−min of the curve):
//
//   band            other/A  vocals/A  other/B  other/C
//   full            0.043    0.477     0.158    0.094
//   300–4000 Hz     0.224    0.681     0.275    0.254
//
// 300–4000 Hz is the presence region — guitars, synths and keys live there, and it
// is where a filter opening up is actually audible. It was the only band with no
// dead stem in the sample.
const BRIGHTNESS = { feature: "brightness", label: "brightness", minHz: 300, maxHz: 4000 };
// One band's LOUDNESS, named "<label> energy". Frequency-selective, so each of
// kick/snare/hats follows its own element.
const band = (label: string, minHz: number, maxHz: number, release?: number): AnyRec => ({
  feature: "energy",
  label: `${label} energy`,
  minHz,
  maxHz,
  release,
});
const STEM_DEFAULTS: Record<string, AnyRec[]> = {
  // The full mix carries the tempo grid: bar/beat are track-independent ramps and
  // have nowhere else to live.
  original: [
    ENERGY,
    ONSET,
    { feature: "bar", label: "bar phase" },
    { feature: "beat", label: "beat phase" },
  ],
  vocals: [ENERGY, ONSET],
  drums: [
    ONSET,
    band("kick", 40, 120, 120),
    band("snare", 150, 800, 120),
    band("hats", 6000, 16000, 90),
  ],
  bass: [ONSET, band("sub", 30, 80), band("low", 80, 250)],
  // `other` is whatever the separation couldn't name — guitars, synths, keys — so
  // it is often where the hook lives, and one loudness curve is a thin description
  // of it. Brightness is the cheapest second dimension: energy says how much, this
  // says how open.
  other: [ENERGY, BRIGHTNESS],
};

// Shaping fields a default entry may override on top of SIGNAL_DEFAULTS.
const DEFAULT_SHAPE_KEYS = ["attack", "release", "gamma", "gain", "offset", "threshold", "invert"];

function defaultName(meta: AnyRec, def: AnyRec): string {
  if (def.feature === "bar") return "bar phase";
  if (def.feature === "beat") return "beat phase";
  return `${meta.name.toLowerCase()} ${def.label}`;
}

export function defaultSignals(stems: StemsMap): Signal[] {
  const out: Signal[] = [];
  for (const m of STEM_META) {
    if (!stems || !stems[m.key]) continue;
    const nyq = Math.round((stems[m.key].sr || 44100) / 2);
    for (const def of STEM_DEFAULTS[m.key] || []) {
      const sig: AnyRec = seedSignal(stems, defaultName(m, def), m.key);
      sig.feature = def.feature;
      if (def.minHz != null) sig.minHz = Math.min(def.minHz, nyq);
      if (def.maxHz != null) sig.maxHz = Math.min(def.maxHz, nyq);
      for (const k of DEFAULT_SHAPE_KEYS) if (def[k] != null) sig[k] = def[k];
      out.push(sig as Signal);
    }
  }
  return out;
}

// Identity of a default signal: stem + feature + band. Including the band lets a
// stem carry several defaults on the same feature (e.g. drums kick/snare/hats).
const defaultKey = (s: AnyRec): string =>
  `${s.stemKey}|${s.feature}|${Math.round(s.minHz)}|${Math.round(s.maxHz)}`;

// Add any default signals that aren't already present, keeping the user's
// existing/custom signals — so existing projects gain the new defaults.
function withDefaults(existing: Signal[], stems: StemsMap): Signal[] {
  const have = new Set(existing.map(defaultKey));
  const missing = defaultSignals(stems).filter((d) => !have.has(defaultKey(d)));
  return [...existing, ...missing];
}

// Hydrate a server/proposal segment list (each gets a stable id + signals).
// A fresh segment gets all the per-track defaults; an existing one keeps its
// saved signals and gains any missing defaults.
//
// Ids are PRESERVED across a reload — `serializeSegments` has always written them,
// and this used to throw them away and re-mint ("never trust stored ids (avoids
// collisions)"). The concern was real but the remedy was too broad: it also made a
// segment un-addressable from outside the session, so nothing could link to one.
// The collision it guarded against is checked directly instead — a duplicate or
// missing id re-mints, everything else survives. This is the `hydrateSignals` /
// `hydrateCompositions` precedent, not `hydrateSegments`' old fresh-mint.
export function hydrateSegments(raw: RawSegment[] | null | undefined, stems: StemsMap): Segment[] {
  const seen = new Set<string>();
  return (raw || []).map((s) => {
    const id = s.id && !seen.has(s.id) ? s.id : mkSegId();
    seen.add(id);
    return {
      id,
      start: s.start,
      end: s.end,
      label: s.label,
      signals:
        s.signals && s.signals.length
          ? withDefaults(hydrateSignals(s.signals), stems)
          : defaultSignals(stems),
      // The composition reference survives the reload verbatim — composition ids
      // are stable (compositions.ts), so the pool entry it names still exists.
      // undefined = no animation built yet.
      rootCompositionId: s.rootCompositionId,
    };
  });
}

// Strip to the persisted shape for autosave.
export function serializeSegments(segments: Segment[]): RawSegment[] {
  return segments.map((s) => ({
    id: s.id,
    start: s.start,
    end: s.end,
    label: s.label,
    signals: serializeSignals(s.signals),
    // Persist the composition reference (undefined until an animation exists);
    // the graph itself autosaves with the pool.
    rootCompositionId: s.rootCompositionId,
  }));
}

// Copy a signal list with fresh ids (so a split's two halves are independent),
// also reporting the old->new id mapping so a copied graph can be remapped.
// (Exported for compositions.ts, whose split/copy clone a composition onto them.)
export function cloneSignals(signals: Signal[] | null | undefined): {
  signals: Signal[];
  idMap: Record<string, string>;
} {
  const idMap: Record<string, string> = {};
  const out = (signals || []).map((s) => {
    const id = mkSigId();
    idMap[s.id] = id;
    return { ...s, id };
  });
  return { signals: out, idMap };
}

// Merge segment `id` into its previous neighbor (delete the boundary before it).
// The earlier segment keeps its composition (its signals are unchanged, so its
// references stay valid); the later segment's composition reference falls away
// with the spliced-out segment — the pool entry lingers as an orphan until the
// pool prune (compositions wave step 07) collects it. No remap needed.
export function mergeWithPrev(segments: Segment[], id: string): Segment[] {
  const i = segments.findIndex((s) => s.id === id);
  if (i <= 0) return segments;
  const out = segments.slice();
  out[i - 1] = { ...out[i - 1], end: out[i].end };
  out.splice(i, 1);
  return out;
}

// Move the boundary between segment i-1 and i to time `t`, keeping order.
export function moveBoundary(segments: Segment[], i: number, t: number): Segment[] {
  if (i <= 0 || i >= segments.length) return segments;
  const lo = segments[i - 1].start + 0.5;
  const hi = segments[i].end - 0.5;
  const clamped = Math.max(lo, Math.min(t, hi));
  const out = segments.slice();
  out[i - 1] = { ...out[i - 1], end: clamped };
  out[i] = { ...out[i], start: clamped };
  return out;
}
