// A tiny framework-free log bus: a capped, in-memory list of log entries plus a
// pub/sub so any code (api.js, global error capture, components) can push and the
// Logs panel / error badge can subscribe. It also merges the backend's polled
// entries (GET /logs) into the same timeline, keyed by the backend's monotonic
// sequence so nothing is shown twice.
//
// entry: { id, ts (ms epoch), level: "info"|"warn"|"error",
//          source: "frontend"|"backend", logger, msg, trace? }

const CAP = 500; // max entries kept in memory (oldest drop off)

let _id = 0; // local monotonic id for frontend entries
let _entries = []; // newest-last
let _backendSeq = 0; // cursor for GET /logs?since=
let _maxBackendSeq = 0; // highest backend seq actually appended (hard dedupe)
const _subs = new Set();

function _emit() {
  for (const fn of _subs) fn(_entries);
}

function _push(entry) {
  _entries.push(entry);
  if (_entries.length > CAP) _entries = _entries.slice(-CAP);
  _emit();
}

export function log(level, msg, opts = {}) {
  _push({
    id: `f${++_id}`,
    ts: Date.now(),
    level,
    source: "frontend",
    logger: opts.logger || "app",
    msg: String(msg),
    trace: opts.trace,
  });
}

export const info = (m, o) => log("info", m, o);
export const warn = (m, o) => log("warn", m, o);
export const error = (m, o) => log("error", m, o);

// Subscribe to changes; called immediately with the current list. Returns an
// unsubscribe function.
export function subscribe(fn) {
  _subs.add(fn);
  fn(_entries);
  return () => _subs.delete(fn);
}

export function getEntries() {
  return _entries;
}

export function clear() {
  _entries = [];
  // Forget which backend rows we've shown so they could appear again, but DON'T
  // touch the poll cursor (_backendSeq) — otherwise the next poll would re-fetch
  // and re-populate everything we just cleared.
  _maxBackendSeq = 0;
  _emit();
}

export function errorCount() {
  let n = 0;
  for (const e of _entries) if (e.level === "error") n++;
  return n;
}

// --- backend merge ---------------------------------------------------------
export function backendCursor() {
  return _backendSeq;
}

// Ingest a `{ entries, seq }` payload from GET /logs. Advances the cursor and
// appends new backend rows (keyed by their server seq so a retry can't dup).
export function ingestBackend(payload) {
  if (!payload) return;
  if (typeof payload.seq === "number") _backendSeq = payload.seq;
  for (const e of payload.entries || []) {
    if (e.seq <= _maxBackendSeq) continue; // already appended (retry/overlap)
    _maxBackendSeq = e.seq;
    _push({
      id: `b${e.seq}`,
      ts: e.ts * 1000, // epoch s -> ms (same unit as frontend Date.now())
      level: e.level,
      source: "backend",
      logger: e.logger,
      msg: e.msg,
      trace: e.trace,
    });
  }
}
