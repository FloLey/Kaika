// The signal card's static catalogs: the selectable feature types and the help
// copy for each control. Plain data — kept out of SignalCard.tsx so the component
// stays focused on behavior.

// Feature types (must match signals.py `_RAW`) with a one-line explanation.
export const FEATURES = [
  { key: "energy", label: "energy", help: "Loudness of the band over time — the default driver." },
  {
    key: "onset",
    label: "onset",
    help: "A spike on each hit in the band (use release to add the decay). Great for discrete events.",
  },
  { key: "flux", label: "flux", help: "How fast the band is changing — its 'busy-ness'." },
  {
    key: "brightness",
    label: "brightness",
    help: "Where the energy sits in the band (low=dull, high=bright).",
  },
  {
    key: "harmonic",
    label: "harmonic",
    help: "Tonal/sustained share vs percussive/noisy in the band.",
  },
  {
    key: "chroma",
    label: "chroma",
    help: "Dominant pitch class in the band (stepped) — handy for driving color.",
  },
  {
    key: "beat",
    label: "beat phase",
    help: "A 0→1 ramp locked to each beat (sawtooth). The frequency band is ignored.",
  },
  {
    key: "bar",
    label: "bar phase",
    help: "A 0→1 ramp locked to each 4-beat bar. The frequency band is ignored.",
  },
];

export const FEATURE_HELP: Record<string, string> = Object.fromEntries(
  FEATURES.map((f) => [f.key, f.help])
);

export const HELP = {
  signal:
    "A signal = this track's loudness in the chosen frequency band, over this " +
    "segment, shaped into a 0–1 curve that drives the simulation. Drag the band " +
    "edges on the spectrogram; the curve below updates live.",
  attack:
    "How fast the curve RISES when the sound gets louder. Low = snaps up instantly on a hit; high = eases up slowly (a gentle swell).",
  release:
    "How fast the curve FALLS when the sound gets quieter. Low = drops instantly; high = long smooth tail (e.g. a kick that fades out).",
  gamma:
    "Contrast of the curve. >1 emphasizes peaks (only the loud moments register); <1 lifts the quiet detail.",
  thresh:
    "Gate: ignore everything below this level, so the signal reacts only to strong hits and not to background.",
  gain: "Scales the whole curve up/down (multiplies the value).",
  offset: "Shifts the whole curve up/down (adds a constant) — e.g. so it never reaches zero.",
  invert:
    "Flips the curve: loud → low instead of loud → high. Invert + slow attack + fast release = the sidechain pump.",
};
