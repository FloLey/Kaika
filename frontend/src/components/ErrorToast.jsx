import { useEffect, useRef, useState } from "react";
import * as logbus from "../lib/logbus.js";

// Pops a dismissible toast whenever a new error-level entry arrives (from either
// the frontend or the polled backend stream). Clicking a toast opens the Logs
// panel. Keeps only the most recent few; each auto-dismisses after a while.
const MAX = 3;
const TTL = 6000;

export default function ErrorToast({ onOpenLogs }) {
  const [toasts, setToasts] = useState([]); // { id, msg }
  const seen = useRef(null); // id of the last error we've already toasted

  useEffect(() => {
    return logbus.subscribe((entries) => {
      // Find the newest error; only toast if it's one we haven't shown.
      let latest = null;
      for (const e of entries) if (e.level === "error") latest = e;
      if (!latest || latest.id === seen.current) return;
      // On the very first subscribe call, adopt the latest without toasting a
      // backlog of pre-existing errors.
      if (seen.current === null) { seen.current = latest.id; return; }
      seen.current = latest.id;
      setToasts((ts) => [...ts, { id: latest.id, msg: latest.msg }].slice(-MAX));
    });
  }, []);

  useEffect(() => {
    if (toasts.length === 0) return undefined;
    const t = setTimeout(() => setToasts((ts) => ts.slice(1)), TTL);
    return () => clearTimeout(t);
  }, [toasts]);

  if (toasts.length === 0) return null;

  const dismiss = (id) => setToasts((ts) => ts.filter((t) => t.id !== id));

  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="toast toast-error"
          role="alert"
          onClick={() => { onOpenLogs?.(); dismiss(t.id); }}
          title="Open logs"
        >
          <span className="toast-icon">⚠</span>
          <span className="toast-msg">{t.msg}</span>
          <button
            className="toast-close"
            onClick={(e) => { e.stopPropagation(); dismiss(t.id); }}
            title="dismiss"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
