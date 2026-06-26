// Segment labels and signal helpers. Segments are contiguous time ranges
// [start, end]; each segment owns a list of *signals* (a stem + frequency band
// + shaping -> a drawable curve that drives the simulation).
//
// These helpers munge dynamic, JSON-shaped signal/segment records (arbitrary
// shaping keys), so the working types are intentionally loose `any` records.
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Graph, Segment, Signal, StemInfo } from "./types";

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
  graph?: Graph | null;
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
// colliding item at once. UUIDs avoid that entirely.
function rid(prefix: string): string {
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

// Default signals seeded on a fresh segment. Every track gets full-band
// energy + onset + chroma; the full mix also gets bar & beat phase
// (track-independent).
// Drums and bass additionally get the bands where their key elements live, so
// you get kick / snare / hats and sub / low drivers out of the box. Each entry
// is {feature, label, minHz?, maxHz?, ...shaping} — omit the band for the full
// range. Bands are rough starting points; drag the spectrogram handles to refine.
//
// Each band ships in BOTH flavors: `energy` (band loudness — frequency selective,
// so kick/snare/hats follow their own element) and `onset` (a spike per hit).
// They read differently: a drum hit is a broadband transient, so the onset bands
// tend to fire together, while the energy bands separate the elements.
const FULL_BAND = [
  { feature: "energy", label: "energy" },
  { feature: "onset", label: "onset" },
  { feature: "chroma", label: "chroma" },
];
// energy + onset variants of one band, named "<label> energy" / "<label> onset".
const both = (label: string, minHz: number, maxHz: number, release?: number): AnyRec[] => [
  { feature: "energy", label: `${label} energy`, minHz, maxHz, release },
  { feature: "onset", label: `${label} onset`, minHz, maxHz },
];
const STEM_DEFAULTS: Record<string, AnyRec[]> = {
  original: [
    ...FULL_BAND,
    { feature: "bar", label: "bar phase" },
    { feature: "beat", label: "beat phase" },
  ],
  vocals: FULL_BAND,
  drums: [
    ...FULL_BAND,
    ...both("kick", 40, 120, 120),
    ...both("snare", 150, 800, 120),
    ...both("hats", 6000, 16000, 90),
  ],
  bass: [...FULL_BAND, ...both("sub", 30, 80), ...both("low", 80, 250)],
  other: FULL_BAND,
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
export function hydrateSegments(raw: RawSegment[] | null | undefined, stems: StemsMap): Segment[] {
  return (raw || []).map((s) => ({
    id: mkSegId(), // always fresh — never trust stored ids (avoids collisions)
    start: s.start,
    end: s.end,
    label: s.label,
    signals:
      s.signals && s.signals.length
        ? withDefaults(hydrateSignals(s.signals), stems)
        : defaultSignals(stems),
    // Keep the stored graph as-is. Its node ids stay stable too (each segment
    // owns its own graph, so they never collide across segments). null = no
    // animation built yet.
    graph: s.graph || null,
  }));
}

// Strip to the persisted shape for autosave.
export function serializeSegments(segments: Segment[]): RawSegment[] {
  return segments.map((s) => ({
    id: s.id,
    start: s.start,
    end: s.end,
    label: s.label,
    signals: serializeSignals(s.signals),
    // The graph is a plain JSON object — carry it untouched (null if absent).
    graph: s.graph || null,
  }));
}

// Deep-copy a pure-JSON graph (structuredClone with a JSON-roundtrip fallback
// for envs that lack it — graphs are pure JSON).
function cloneGraph(graph: Graph | null | undefined): Graph | null {
  if (!graph) return null;
  return typeof structuredClone === "function"
    ? structuredClone(graph)
    : (JSON.parse(JSON.stringify(graph)) as Graph);
}

// Copy a signal list with fresh ids (so a split's two halves are independent),
// also reporting the old->new id mapping so a copied graph can be remapped.
function cloneSignals(signals: Signal[] | null | undefined): {
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

// Rewrite a graph's signal-node references through an id map; deep-copy so the
// two halves of a split don't share one object. Unknown ids pass through (they
// will read as "missing" later — the executor treats them as a flat 0).
function remapGraphSignals(
  graph: Graph | null | undefined,
  idMap: Record<string, string>
): Graph | null {
  if (!graph) return null;
  const g = cloneGraph(graph) as Graph;
  for (const n of g.nodes) {
    if (n.type === "signal" && idMap[n.data.signalId]) {
      n.data.signalId = idMap[n.data.signalId];
    }
  }
  return g;
}

// Split the segment that contains `t` into two at `t` (no-op near an edge). The
// second half gets fresh signal ids (independent) and a graph remapped onto
// them; the first half keeps its ids but gets a DISTINCT graph object so the two
// halves never share-mutate (01 §3.8).
export function splitAt(segments: Segment[], t: number): Segment[] {
  const out: Segment[] = [];
  for (const s of segments) {
    if (t > s.start + 0.5 && t < s.end - 0.5) {
      out.push({ ...s, end: t, graph: cloneGraph(s.graph) });
      const { signals, idMap } = cloneSignals(s.signals);
      out.push({
        ...s,
        id: mkSegId(),
        start: t,
        signals,
        graph: remapGraphSignals(s.graph, idMap),
      });
    } else {
      out.push(s);
    }
  }
  return out;
}

// Merge segment `id` into its previous neighbor (delete the boundary before it).
// The earlier segment keeps its graph (its signals are unchanged, so its
// references stay valid); the later segment's graph falls away with the
// spliced-out segment. This is the defined behavior (01 §3.8) — no remap needed.
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
