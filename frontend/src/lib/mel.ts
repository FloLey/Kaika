// Slaney mel scale — matches librosa.hz_to_mel / mel_to_hz exactly, so the
// frequency overlays line up with the rendered mel spectrogram.
const F_SP = 200 / 3; // linear region slope below 1000 Hz
const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = MIN_LOG_HZ / F_SP;
const LOGSTEP = Math.log(6.4) / 27;

export function hzToMel(f: number): number {
  if (f >= MIN_LOG_HZ) return MIN_LOG_MEL + Math.log(f / MIN_LOG_HZ) / LOGSTEP;
  return f / F_SP;
}

export function melToHz(m: number): number {
  if (m >= MIN_LOG_MEL) return MIN_LOG_HZ * Math.exp(LOGSTEP * (m - MIN_LOG_MEL));
  return F_SP * m;
}

// fraction 0..1 measured from the BOTTOM of the spectrogram (lo) to the TOP (hi)
export function freqToFrac(f: number, lo: number, hi: number): number {
  return (hzToMel(f) - hzToMel(lo)) / (hzToMel(hi) - hzToMel(lo));
}

// inverse: a fraction-from-bottom back to Hz
export function fracToFreq(frac: number, lo: number, hi: number): number {
  const mel = hzToMel(lo) + frac * (hzToMel(hi) - hzToMel(lo));
  return melToHz(mel);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

export function fmtTime(t: number): string {
  if (!isFinite(t)) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

// `m:ss.cc` with two decimals of a second — the editable form for lyric timings,
// where sub-second precision matters when nudging a line onto the vocal. Round-
// trips with parseTimecode.
export function fmtTimecode(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

// Parse a timecode back to seconds. Accepts `m:ss.cc` (any minutes, seconds < 60)
// or a bare number of seconds ("83.5"). Returns null on anything unparseable so
// callers can flag the field instead of silently coercing to 0.
export function parseTimecode(s: string): number | null {
  const str = s.trim();
  if (!str) return null;
  if (str.includes(":")) {
    const parts = str.split(":");
    if (parts.length !== 2) return null;
    const mins = Number(parts[0]);
    const secs = Number(parts[1]);
    if (!isFinite(mins) || !isFinite(secs) || mins < 0 || secs < 0 || secs >= 60) return null;
    return mins * 60 + secs;
  }
  const n = Number(str);
  return isFinite(n) && n >= 0 ? n : null;
}

export function fmtHz(hz: number): string {
  if (hz >= 1000) return (hz / 1000).toFixed(hz >= 10000 ? 1 : 2) + " kHz";
  return Math.round(hz) + " Hz";
}
