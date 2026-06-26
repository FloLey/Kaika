import { useEffect, useRef } from "react";
import * as logbus from "./logbus";
import { getLogs } from "./api";

// Poll the backend log feed on an interval and merge new entries into the log
// bus. An in-flight guard prevents request pile-up on a slow server. The catch
// is intentionally empty: a failed /logs poll must NEVER log (it would create an
// entry the next poll fetches — a runaway loop).
export function useLogPoll(intervalMs: number) {
  const inFlight = useRef(false);
  useEffect(() => {
    let stopped = false;
    async function tick() {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const data = await getLogs(logbus.backendCursor());
        if (!stopped) logbus.ingestBackend(data);
      } catch {
        /* swallow — never log a failed log-poll */
      } finally {
        inFlight.current = false;
      }
    }
    tick(); // immediate first fetch
    const t = setInterval(tick, intervalMs);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [intervalMs]);
}
