// Web Audio engine: one shared AudioContext, a 24 dB/oct band-pass per track
// (two cascaded highpass + two cascaded lowpass biquads). The <audio> elements
// are owned by React; we attach a MediaElementSource to each exactly once.

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.tracks = new Map(); // uid -> { el, src, hp1, hp2, lp1, lp2, gain, min, max }
  }

  ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  // Build the filter chain for a track's <audio> element (idempotent).
  connect(uid, el, min, max, muted = false) {
    const ctx = this.ensureCtx();
    let t = this.tracks.get(uid);
    if (!t) {
      const src = ctx.createMediaElementSource(el);
      const hp1 = ctx.createBiquadFilter();
      hp1.type = "highpass";
      const hp2 = ctx.createBiquadFilter();
      hp2.type = "highpass";
      const lp1 = ctx.createBiquadFilter();
      lp1.type = "lowpass";
      const lp2 = ctx.createBiquadFilter();
      lp2.type = "lowpass";
      const gain = ctx.createGain();
      src.connect(hp1);
      hp1.connect(hp2);
      hp2.connect(lp1);
      lp1.connect(lp2);
      lp2.connect(gain);
      gain.connect(ctx.destination);
      t = { el, src, hp1, hp2, lp1, lp2, gain };
      this.tracks.set(uid, t);
    }
    this.setBand(uid, min, max);
    this.setMuted(uid, muted);
    return t;
  }

  setBand(uid, min, max) {
    const t = this.tracks.get(uid);
    if (!t) return;
    t.hp1.frequency.value = min;
    t.hp2.frequency.value = min;
    t.lp1.frequency.value = max;
    t.lp2.frequency.value = max;
  }

  setMuted(uid, muted) {
    const t = this.tracks.get(uid);
    if (!t) return;
    t.gain.gain.value = muted ? 0 : 1;
  }

  remove(uid) {
    const t = this.tracks.get(uid);
    if (!t) return;
    [t.src, t.hp1, t.hp2, t.lp1, t.lp2, t.gain].forEach((n) => {
      try {
        n.disconnect();
      } catch (e) {
        /* noop */
      }
    });
    this.tracks.delete(uid);
  }

  reset() {
    for (const uid of [...this.tracks.keys()]) this.remove(uid);
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}

export const engine = new AudioEngine();
