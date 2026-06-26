// Slaney mel scale — matches librosa.hz_to_mel / mel_to_hz exactly, so the
// frequency overlays line up with the rendered mel spectrogram.
const F_SP = 200 / 3; // linear region slope below 1000 Hz
const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = MIN_LOG_HZ / F_SP;
const LOGSTEP = Math.log(6.4) / 27;

export function hzToMel(f) {
  if (f >= MIN_LOG_HZ) return MIN_LOG_MEL + Math.log(f / MIN_LOG_HZ) / LOGSTEP;
  return f / F_SP;
}

export function melToHz(m) {
  if (m >= MIN_LOG_MEL) return MIN_LOG_HZ * Math.exp(LOGSTEP * (m - MIN_LOG_MEL));
  return F_SP * m;
}

// fraction 0..1 measured from the BOTTOM of the spectrogram (lo) to the TOP (hi)
export function freqToFrac(f, lo, hi) {
  return (hzToMel(f) - hzToMel(lo)) / (hzToMel(hi) - hzToMel(lo));
}

// inverse: a fraction-from-bottom back to Hz
export function fracToFreq(frac, lo, hi) {
  const mel = hzToMel(lo) + frac * (hzToMel(hi) - hzToMel(lo));
  return melToHz(mel);
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(v, hi));
}

export function fmtTime(t) {
  if (!isFinite(t)) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

export function fmtHz(hz) {
  if (hz >= 1000) return (hz / 1000).toFixed(hz >= 10000 ? 1 : 2) + " kHz";
  return Math.round(hz) + " Hz";
}
