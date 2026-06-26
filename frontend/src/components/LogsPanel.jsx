import { useEffect, useRef, useState } from "react";
import * as logbus from "../lib/logbus.js";

// A right-side overlay drawer showing the unified frontend+backend log stream.
// Subscribes to the log bus; rows are sorted by timestamp (id as a stable
// tiebreaker) and filtered by level. Lives in-session (not a separate root like
// Docs) so it can show live logs while you work.
const LEVELS = ["info", "warn", "error"];

export default function LogsPanel({ open, onClose }) {
  const [entries, setEntries] = useState(logbus.getEntries());
  const [filter, setFilter] = useState({ info: true, warn: true, error: true });
  const bodyRef = useRef(null);
  const atBottom = useRef(true);

  useEffect(() => logbus.subscribe(setEntries), []);

  // Keep the view pinned to the newest row unless the user scrolled up.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [entries, open]);

  if (!open) return null;

  const rows = [...entries]
    .filter((e) => filter[e.level])
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));

  const fmtTime = (ts) => new Date(ts).toLocaleTimeString();
  const onScroll = (e) => {
    const el = e.currentTarget;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <div className="logs-overlay" onClick={onClose}>
      <aside
        className="logs-drawer"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Logs"
      >
        <header className="logs-head">
          <span
            className="logs-title"
            title="Live backend + browser logs for this session (newest at the bottom). Filter by level; nothing is persisted — the stream resets when the server restarts."
          >
            logs
          </span>
          <div className="logs-actions">
            {LEVELS.map((lv) => (
              <button
                key={lv}
                className={"logs-chip lv-" + lv + (filter[lv] ? " on" : "")}
                onClick={() => setFilter((f) => ({ ...f, [lv]: !f[lv] }))}
                title={`toggle ${lv}`}
              >
                {lv}
              </button>
            ))}
            <button className="btn sm" onClick={logbus.clear}>
              clear
            </button>
            <button className="btn sm" onClick={onClose} title="close">
              ✕
            </button>
          </div>
        </header>
        <div className="logs-body" ref={bodyRef} onScroll={onScroll}>
          {rows.length === 0 && <div className="logs-empty">no logs yet</div>}
          {rows.map((e) => (
            <div key={e.id} className={"logs-row lv-" + e.level}>
              <time className="logs-time">{fmtTime(e.ts)}</time>
              <span className={"logs-src src-" + e.source}>{e.source}</span>
              <span className="logs-lvl">{e.level}</span>
              <span className="logs-msg">{e.msg}</span>
              {e.trace && <pre className="logs-trace">{e.trace}</pre>}
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
