// Installs global browser error capture into the log bus, so uncaught script
// errors and unhandled promise rejections show up in the Logs panel. Called once
// from main.jsx before render. We deliberately do NOT patch console.* — explicit
// capture only, to avoid noise and feedback loops.

import { error as logError } from "./logbus";

export function installGlobalCapture() {
  window.addEventListener("error", (ev: ErrorEvent) => {
    logError(ev.message || "script error", {
      logger: "window.onerror",
      trace: ev.error && ev.error.stack,
    });
  });
  window.addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
    const r = ev.reason;
    logError((r && r.message) || String(r), {
      logger: "unhandledrejection",
      trace: r && r.stack,
    });
  });
}
