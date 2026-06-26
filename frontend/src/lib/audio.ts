// Web Audio engine: one shared AudioContext, a 24 dB/oct band-pass per track
// (two cascaded highpass + two cascaded lowpass biquads). The <audio> elements
// are owned by React; we attach a MediaElementSource to each exactly once.

interface Track {
  el: HTMLAudioElement;
  src: MediaElementAudioSourceNode;
  hp1: BiquadFilterNode;
  hp2: BiquadFilterNode;
  lp1: BiquadFilterNode;
  lp2: BiquadFilterNode;
  gain: GainNode;
}

class AudioEngine {
  ctx: AudioContext | null = null;
  tracks = new Map<string, Track>();

  ensureCtx(): AudioContext {
    if (!this.ctx) {
      // webkitAudioContext is the legacy Safari prefix, absent from lib.dom.
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  // Build the filter chain for a track's <audio> element (idempotent).
  connect(uid: string, el: HTMLAudioElement, min: number, max: number, muted = false): Track {
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

  setBand(uid: string, min: number, max: number) {
    const t = this.tracks.get(uid);
    if (!t) return;
    t.hp1.frequency.value = min;
    t.hp2.frequency.value = min;
    t.lp1.frequency.value = max;
    t.lp2.frequency.value = max;
  }

  setMuted(uid: string, muted: boolean) {
    const t = this.tracks.get(uid);
    if (!t) return;
    t.gain.gain.value = muted ? 0 : 1;
  }

  remove(uid: string) {
    const t = this.tracks.get(uid);
    if (!t) return;
    [t.src, t.hp1, t.hp2, t.lp1, t.lp2, t.gain].forEach((n) => {
      try {
        n.disconnect();
      } catch {
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
