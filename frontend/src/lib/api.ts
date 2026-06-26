// Thin fetch wrappers around the Flask API. Responses are dynamic JSON, so the
// payloads are typed as `any` at this boundary (callers shape them); the file-level
// disable keeps that intentional rather than scattering per-line exceptions.
/* eslint-disable @typescript-eslint/no-explicit-any */

import * as logbus from "./logbus";

async function jsonOrThrow(res: Response): Promise<any> {
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    // e.g. an HTML SPA-fallback page — surface it instead of silently failing.
    const text = await res.text().catch(() => "");
    const msg = `expected JSON from ${res.url} but got ${res.status} (${ct}). ${text.slice(0, 120)}`;
    logbus.error(msg, { logger: "api" });
    throw new Error(msg);
  }
  const data = await res.json();
  if (!res.ok) {
    const msg = data.detail || data.error || res.statusText;
    logbus.error(`${res.status} ${res.url}: ${msg}`, { logger: "api" });
    throw new Error(msg);
  }
  return data;
}

// Backend log feed for the Logs panel. Deliberately bypasses jsonOrThrow so a
// failed /logs request can't log an error (which the next poll would fetch — a
// runaway loop). Callers (useLogPoll) swallow rejections.
export async function getLogs(since = 0): Promise<any> {
  const res = await fetch(`/logs?since=${since}`);
  if (!res.ok) throw new Error(`/logs ${res.status}`);
  return res.json(); // { entries, seq }
}

// /upload and /segment now return { job_id } immediately and do the slow work
// in the background; poll the job to get the result. See pollJob below.
export async function uploadSong(formData: FormData): Promise<any> {
  return jsonOrThrow(await fetch("/upload", { method: "POST", body: formData }));
}

export async function segmentJob(jobId: string): Promise<any> {
  return jsonOrThrow(
    await fetch("/segment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId }),
    })
  );
}

export async function getJob(jobId: string): Promise<any> {
  return jsonOrThrow(await fetch(`/jobs/${jobId}`));
}

// Human-readable label per backend step (jobs.py / app.py worker `set_step`).
const STEP_LABELS: Record<string, string> = {
  downloading: "downloading audio from YouTube…",
  separating: "separating stems with demucs…",
  rendering: "rendering spectrograms…",
  analysing: "analysing structure (lyrics + vocal activity)…",
  done: "finishing up…",
};

// Poll a background job until it finishes; resolve with its result, throw on
// error. `onStep(label)` is called as the worker advances through its phases.
export async function pollJob(
  jobId: string,
  onStep?: (label: string) => void,
  intervalMs = 1000
): Promise<any> {
  for (;;) {
    const j = await getJob(jobId);
    if (onStep && j.step) onStep(STEP_LABELS[j.step] || j.step);
    if (j.state === "done") return j.result;
    if (j.state === "error") throw new Error(j.error || "job failed");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function extractSignal(params: Record<string, unknown>): Promise<any> {
  return jsonOrThrow(
    await fetch("/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    })
  );
}

export async function runFluid(params: Record<string, unknown>): Promise<any> {
  return jsonOrThrow(
    await fetch("/fluid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    })
  );
}

// Render an animation graph for one segment. The segment's signal defs ride in
// the request (Issue 1A) so the backend can resolve `signal` node references.
export async function renderGraph({
  job_id,
  segment,
  graph,
  output,
  output_id,
}: {
  job_id: string;
  segment: unknown;
  graph: unknown;
  output?: unknown;
  output_id?: unknown;
}): Promise<any> {
  return jsonOrThrow(
    await fetch("/animate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id, segment, graph, output, output_id }),
    })
  );
}

export async function listProjects(): Promise<any> {
  return jsonOrThrow(await fetch("/projects"));
}

export async function getProject(jobId: string): Promise<any> {
  return jsonOrThrow(await fetch(`/projects/${jobId}`));
}

export async function saveProject(jobId: string, payload: unknown): Promise<any> {
  return jsonOrThrow(
    await fetch(`/projects/${jobId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  );
}

export async function deleteProject(jobId: string): Promise<any> {
  return jsonOrThrow(await fetch(`/projects/${jobId}`, { method: "DELETE" }));
}
