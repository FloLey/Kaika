// Segment labels and signal helpers. Segments are contiguous time ranges
// [start, end]; each segment owns a list of *signals* (a stem + frequency band
// + shaping -> a drawable curve that drives the simulation).

export const LABELS = [
  "intro", "verse", "pre-chorus", "chorus", "bridge", "build", "drop", "break", "outro",
];

export const LABEL_COLOR = {
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

export function labelColor(label) {
  return LABEL_COLOR[label] || "#60A5FA";
}

// The stems demucs produces (+ the original mix), with display name and color.
export const STEM_META = [
  { key: "original", name: "FULL MIX", color: "#60A5FA" },
  { key: "vocals", name: "VOCALS", color: "#FBBF24" },
  { key: "drums", name: "DRUMS", color: "#F87171" },
  { key: "bass", name: "BASS", color: "#C084FC" },
  { key: "other", name: "OTHER", color: "#34D399" },
];

export function stemColor(stemKey) {
  return (STEM_META.find((m) => m.key === stemKey) || {}).color || "#60A5FA";
}

// Globally-unique ids. A plain session counter is NOT safe here: it resets on
// every page load / HMR while stored ids persist, so a freshly added item would
// collide with a resumed one — and an id collision makes edits hit every
// colliding item at once. UUIDs avoid that entirely.
function rid(prefix) {
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
const SIGNAL_DEFAULTS = {
  feature: "energy",
  attack: 5,
  release: 250,
  invert: false,
  gamma: 1,
  gain: 1,
  offset: 0,
  threshold: 0,
};

const SIGNAL_FIELDS = [
  "id", "name", "stemKey", "minHz", "maxHz",
  ...Object.keys(SIGNAL_DEFAULTS),
];

// A fresh signal on a given stem (full band by default).
export function seedSignal(stems, name, stem) {
  const stemKey = stem || (stems?.original ? "original" : Object.keys(stems || {})[0] || "original");
  const sr = stems?.[stemKey]?.sr || 44100;
  return {
    id: mkSigId(),
    name: name || "signal",
    stemKey,
    minHz: 20,
    maxHz: Math.round(sr / 2),
    ...SIGNAL_DEFAULTS,
  };
}

// Rebuild signals from saved ones (fill defaults + a fresh id if missing).
function hydrateSignals(stored) {
  return (stored || []).map((s) => ({
    id: mkSigId(), // always fresh — never trust stored ids (avoids collisions)
    name: s.name || "signal",
    stemKey: s.stemKey || "original",
    minHz: s.minHz ?? 20,
    maxHz: s.maxHz ?? 20000,
    ...SIGNAL_DEFAULTS,
    ...Object.fromEntries(
      Object.keys(SIGNAL_DEFAULTS).map((k) => [k, s[k] ?? SIGNAL_DEFAULTS[k]])
    ),
  }));
}

function serializeSignals(signals) {
  return (signals || []).map((s) =>
    Object.fromEntries(SIGNAL_FIELDS.map((k) => [k, s[k]]))
  );
}

// Defaults on a fresh segment: energy + onset on every track, plus bar & beat
// phase ONCE on the full mix (they're track-independent).
const PER_TRACK = ["energy", "onset"];
const ON_FULLMIX = ["bar", "beat"];

export function defaultSignals(stems) {
  const out = [];
  for (const m of STEM_META) {
    if (!stems || !stems[m.key]) continue;
    const feats = m.key === "original" ? [...PER_TRACK, ...ON_FULLMIX] : PER_TRACK;
    for (const f of feats) {
      const name = f === "bar" ? "bar phase"
        : f === "beat" ? "beat phase"
        : `${m.name.toLowerCase()} ${f}`;
      const sig = seedSignal(stems, name, m.key);
      sig.feature = f;
      out.push(sig);
    }
  }
  return out;
}

// Add any default (stem, feature) signals that aren't already present, keeping
// the user's existing/custom signals — so existing projects gain the defaults.
function withDefaults(existing, stems) {
  const have = new Set(existing.map((s) => s.stemKey + "|" + s.feature));
  const missing = defaultSignals(stems).filter(
    (d) => !have.has(d.stemKey + "|" + d.feature)
  );
  return [...existing, ...missing];
}

// Hydrate a server/proposal segment list (each gets a stable id + signals).
// A fresh segment gets all the per-track defaults; an existing one keeps its
// saved signals and gains any missing defaults.
export function hydrateSegments(raw, stems) {
  return (raw || []).map((s) => ({
    id: mkSegId(), // always fresh — never trust stored ids (avoids collisions)
    start: s.start,
    end: s.end,
    label: s.label,
    signals: (s.signals && s.signals.length)
      ? withDefaults(hydrateSignals(s.signals), stems)
      : defaultSignals(stems),
  }));
}

// Strip to the persisted shape for autosave.
export function serializeSegments(segments) {
  return segments.map((s) => ({
    id: s.id,
    start: s.start,
    end: s.end,
    label: s.label,
    signals: serializeSignals(s.signals),
  }));
}

// Copy a signal list with fresh ids (so a split's two halves are independent).
function cloneSignals(signals) {
  return (signals || []).map((s) => ({ ...s, id: mkSigId() }));
}

// Split the segment that contains `t` into two at `t` (no-op near an edge).
export function splitAt(segments, t) {
  const out = [];
  for (const s of segments) {
    if (t > s.start + 0.5 && t < s.end - 0.5) {
      out.push({ ...s, end: t });
      out.push({ ...s, id: mkSegId(), start: t, signals: cloneSignals(s.signals) });
    } else {
      out.push(s);
    }
  }
  return out;
}

// Merge segment `id` into its previous neighbor (delete the boundary before it).
export function mergeWithPrev(segments, id) {
  const i = segments.findIndex((s) => s.id === id);
  if (i <= 0) return segments;
  const out = segments.slice();
  out[i - 1] = { ...out[i - 1], end: out[i].end };
  out.splice(i, 1);
  return out;
}

// Move the boundary between segment i-1 and i to time `t`, keeping order.
export function moveBoundary(segments, i, t) {
  if (i <= 0 || i >= segments.length) return segments;
  const lo = segments[i - 1].start + 0.5;
  const hi = segments[i].end - 0.5;
  const clamped = Math.max(lo, Math.min(t, hi));
  const out = segments.slice();
  out[i - 1] = { ...out[i - 1], end: clamped };
  out[i] = { ...out[i], start: clamped };
  return out;
}
