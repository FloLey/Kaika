// ONE audio transport for the whole app.
//
// Today there are three, and only one of them is good. Studio's keeps the playhead
// outside React state and subscribes the readout narrowly, so a 4 Hz `timeupdate`
// doesn't re-render the editor. Review hand-rolls a `setCur` on every tick and
// re-renders its whole tree for it — the exact cost Studio's own comment warns
// against. Export has no transport at all, just a muted `<video>`. Nothing is
// shared, so moving between stages stops the music and loses the position.
//
// The fix is not a fourth implementation: it is Studio's, hoisted above the screen
// switch. The `<audio>` element is created here and never enters the React tree, so
// no unmount can stop it — that is what makes "play in review, step to studio, keep
// listening" possible at all.
//
// Two stores, deliberately: POSITION changes ~4×/s and is read by one component
// (the clock), so it never becomes React state; everything else (playing, volume,
// the loop window) changes on user gestures and is a normal snapshot.
//
// Safe to share with the Web Audio engine: `lib/audio.ts` attaches a
// MediaElementSource to the per-signal STEM elements only — never to the full mix —
// so the "one MediaElementSource per element" rule is untouched.

export interface TransportState {
  src: string;
  playing: boolean;
  volume: number;
  loop: boolean;
  // The playable window in SONG seconds: a segment while editing one, the whole
  // track otherwise. Playback loops (or stops) at `end`.
  windowStart: number;
  windowEnd: number;
}

const INITIAL: TransportState = {
  src: "",
  playing: false,
  volume: 1,
  loop: true,
  windowStart: 0,
  windowEnd: 0,
};

let state: TransportState = INITIAL;
let el: HTMLAudioElement | null = null;

const stateSubs = new Set<() => void>();
const posSubs = new Set<() => void>();
let position = 0; // song-absolute seconds

const emitState = () => stateSubs.forEach((fn) => fn());
const emitPos = () => posSubs.forEach((fn) => fn());

function patch(next: Partial<TransportState>) {
  const merged = { ...state, ...next };
  // Referential equality is the subscribe contract — a snapshot that changes
  // identity without changing value would re-render every consumer per tick.
  if ((Object.keys(next) as (keyof TransportState)[]).every((k) => state[k] === merged[k])) return;
  state = merged;
  emitState();
}

// The element, created on first use and kept for the life of the page. Not
// appended to the document: an <audio> plays perfectly well detached, and leaving
// it out of the DOM means no stylesheet or layout pass can ever touch it.
export function audioEl(): HTMLAudioElement | null {
  if (typeof document === "undefined") return null;
  if (el) return el;
  el = document.createElement("audio");
  el.preload = "auto";
  el.addEventListener("play", () => patch({ playing: true }));
  el.addEventListener("pause", () => patch({ playing: false }));
  el.addEventListener("ended", () => patch({ playing: false }));
  el.addEventListener("timeupdate", onTick);
  return el;
}

function onTick() {
  const a = el;
  if (!a) return;
  const { windowEnd, windowStart, loop } = state;
  if (windowEnd > 0 && a.currentTime >= windowEnd) {
    if (loop) a.currentTime = windowStart;
    else {
      a.pause();
      a.currentTime = windowEnd;
    }
  }
  position = a.currentTime;
  emitPos();
}

export function setSource(src: string) {
  const a = audioEl();
  if (!a || src === state.src) return;
  a.src = src;
  a.load();
  patch({ src, playing: false });
  position = 0;
  emitPos();
}

// The loop window. `reseek` pulls the playhead inside it — right when switching to
// a segment, wrong when merely widening the window under a playing head.
export function setWindow(start: number, end: number, opts: { reseek?: boolean } = {}) {
  const changed = start !== state.windowStart || end !== state.windowEnd;
  patch({ windowStart: start, windowEnd: end });
  if (changed && opts.reseek) seekSong(start);
}

export function setLoop(loop: boolean) {
  patch({ loop });
}

export function setVolume(volume: number) {
  const a = audioEl();
  if (a) a.volume = volume;
  patch({ volume });
}

export function seekSong(t: number) {
  const a = audioEl();
  if (!a) return;
  const hi = state.windowEnd > 0 ? state.windowEnd : Number.MAX_SAFE_INTEGER;
  const clamped = Math.min(Math.max(t, state.windowStart), hi);
  a.currentTime = clamped;
  position = clamped;
  emitPos();
}

export function play() {
  const a = audioEl();
  if (!a) return;
  // Outside the window (a fresh segment, or a finished one) — start at its head
  // rather than wherever the previous window left the playhead.
  if (
    a.currentTime < state.windowStart ||
    (state.windowEnd > 0 && a.currentTime >= state.windowEnd - 0.02)
  ) {
    a.currentTime = state.windowStart;
  }
  // The full mix is compressed and may not be buffered on the first play; waiting
  // for `canplay` beats starting silent.
  if (a.readyState >= 2) void a.play().catch(() => {});
  else a.addEventListener("canplay", () => void a.play().catch(() => {}), { once: true });
}

export function pause() {
  audioEl()?.pause();
}

export function toggle() {
  if (state.playing) pause();
  else play();
}

// Stop and rewind to the window head — what switching segments should do.
export function reset() {
  const a = audioEl();
  if (a) {
    a.pause();
    a.currentTime = state.windowStart;
  }
  position = state.windowStart;
  emitPos();
}

export const snapshot = (): TransportState => state;
export const positionSong = (): number => position;
// Seconds into the current window — what a per-segment view wants.
export const positionInWindow = (): number => Math.max(0, position - state.windowStart);

export function subscribe(fn: () => void): () => void {
  stateSubs.add(fn);
  return () => void stateSubs.delete(fn);
}
export function subscribePosition(fn: () => void): () => void {
  posSubs.add(fn);
  return () => void posSubs.delete(fn);
}

// Test seam: drop every listener and go back to the initial state.
export function __resetForTest() {
  el?.pause();
  el = null;
  state = INITIAL;
  position = 0;
  stateSubs.clear();
  posSubs.clear();
}
