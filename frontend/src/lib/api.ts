// Thin fetch wrappers around the Flask API, with a typed response per endpoint.
// The only `any` is inside jsonOrThrow — the genuine JSON parse boundary, where the
// envelope's error fields are read before the payload is cast to its declared type.

import * as logbus from "./logbus";
import type { BackendPayload } from "./logbus";
import type { Graph, OutputSettings, StemInfo } from "./types";
import type { RawSegment } from "./segments";

// ---- response shapes ---------------------------------------------------------
export interface JobAck {
  job_id: string;
}

export interface UploadResult {
  job_id: string;
  fmin?: number;
  duration?: number;
  has_lyrics?: boolean;
  title?: string;
  stems: Record<string, StemInfo>;
}

export interface SegmentProposal {
  segments: RawSegment[];
  vocal_envelope?: number[];
  envelope_times?: number[];
  lyric_lines?: unknown[];
  duration?: number;
}

export interface JobStatus {
  state: "running" | "done" | "error";
  step?: string;
  error?: string;
  result?: unknown;
}

export interface ProjectSummary {
  job_id: string;
  title?: string;
  step: string;
  duration?: number;
  has_lyrics?: boolean;
  updated_at?: string;
}

export interface Project {
  job_id: string;
  title?: string;
  duration?: number;
  fmin?: number;
  has_lyrics?: boolean;
  step?: string;
  stems?: Record<string, StemInfo>;
  segments?: RawSegment[];
  output?: Partial<OutputSettings>;
  vocal_envelope?: number[];
  envelope_times?: number[];
  lyric_lines?: unknown[];
}

export interface ExtractResult {
  curve: number[];
  times: number[];
}

export interface RenderResult {
  url: string;
}

export interface StreamStartResult {
  render_id: string;
}

// Live status of a progressive block render (see backend/render_jobs.py). While
// `running`, show `preview_url` (grows block by block); once `done`, use `url`.
export interface StreamStatus {
  state: "running" | "done" | "cancelled" | "error";
  frames_done: number;
  total: number;
  preview_url: string | null;
  url: string | null;
  error: string | null;
}

async function jsonOrThrow<T = unknown>(res: Response): Promise<T> {
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    // e.g. an HTML SPA-fallback page — surface it instead of silently failing.
    const text = await res.text().catch(() => "");
    const msg = `expected JSON from ${res.url} but got ${res.status} (${ct}). ${text.slice(0, 120)}`;
    logbus.error(msg, { logger: "api" });
    throw new Error(msg);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON parse boundary
  const data: any = await res.json();
  if (!res.ok) {
    const msg = data.detail || data.error || res.statusText;
    logbus.error(`${res.status} ${res.url}: ${msg}`, { logger: "api" });
    throw new Error(msg);
  }
  return data as T;
}

// Backend log feed for the Logs panel. Deliberately bypasses jsonOrThrow so a
// failed /logs request can't log an error (which the next poll would fetch — a
// runaway loop). Callers (useLogPoll) swallow rejections.
export async function getLogs(since = 0): Promise<BackendPayload> {
  const res = await fetch(`/logs?since=${since}`);
  if (!res.ok) throw new Error(`/logs ${res.status}`);
  return res.json(); // { entries, seq }
}

// /upload and /segment return { job_id } immediately and do the slow work in the
// background; poll the job to get the result (see pollJob).
export async function uploadSong(formData: FormData): Promise<JobAck> {
  return jsonOrThrow<JobAck>(await fetch("/upload", { method: "POST", body: formData }));
}

export async function segmentJob(jobId: string): Promise<JobAck> {
  return jsonOrThrow<JobAck>(
    await fetch("/segment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId }),
    })
  );
}

export async function getJob(jobId: string): Promise<JobStatus> {
  return jsonOrThrow<JobStatus>(await fetch(`/jobs/${jobId}`));
}

// Human-readable label per backend step (jobs.py / worker `set_step`).
const STEP_LABELS: Record<string, string> = {
  downloading: "downloading audio from YouTube…",
  separating: "separating stems with demucs…",
  rendering: "rendering spectrograms…",
  analysing: "analysing structure (lyrics + vocal activity)…",
  done: "finishing up…",
};

// Poll a background job until it finishes; resolve with its result, throw on
// error. The result shape depends on the job (upload vs segment), so callers pick
// the type: `pollJob<UploadResult>(...)`. `onStep(label)` fires as phases advance.
export async function pollJob<T = unknown>(
  jobId: string,
  onStep?: (label: string) => void,
  intervalMs = 1000
): Promise<T> {
  for (;;) {
    const j = await getJob(jobId);
    if (onStep && j.step) onStep(STEP_LABELS[j.step] || j.step);
    if (j.state === "done") return j.result as T;
    if (j.state === "error") throw new Error(j.error || "job failed");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function extractSignal(params: Record<string, unknown>): Promise<ExtractResult> {
  return jsonOrThrow<ExtractResult>(
    await fetch("/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    })
  );
}

// Resolve one value node's 0..1 curve for a segment+graph — the Scope card's live view.
export async function resolveCurve(params: {
  job_id: string;
  segment: unknown;
  graph: unknown;
  node_id: string;
}): Promise<ExtractResult> {
  return jsonOrThrow<ExtractResult>(
    await fetch("/resolve", {
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
  graph: Graph | unknown;
  output?: unknown;
  output_id?: unknown;
}): Promise<RenderResult> {
  return jsonOrThrow<RenderResult>(
    await fetch("/animate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id, segment, graph, output, output_id }),
    })
  );
}

// Progressive render: start a background block render and poll it. Renders the same
// clip as `renderGraph` but front-to-back in ~5s blocks, so the first seconds show
// in ~1/10th the time and the preview grows. The frontend cancels the previous
// render on every edit (see cancelStreamRender), so abandoned renders stop early.
export async function startStreamRender(body: {
  job_id: string;
  segment: unknown;
  graph: Graph | unknown;
  output?: unknown;
  output_id?: unknown;
}): Promise<StreamStartResult> {
  return jsonOrThrow<StreamStartResult>(
    await fetch("/animate/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

export async function getStreamStatus(renderId: string): Promise<StreamStatus> {
  return jsonOrThrow<StreamStatus>(await fetch(`/animate/stream/${renderId}`));
}

// Fire-and-forget: signal a render to stop after its current block. Swallows errors
// (the render may already be gone) so callers can call it freely on edit/unmount.
export async function cancelStreamRender(renderId: string): Promise<void> {
  await fetch(`/animate/stream/${renderId}/cancel`, { method: "POST" }).catch(() => {});
}

export async function listProjects(): Promise<ProjectSummary[]> {
  return jsonOrThrow<ProjectSummary[]>(await fetch("/projects"));
}

export async function getProject(jobId: string): Promise<Project> {
  return jsonOrThrow<Project>(await fetch(`/projects/${jobId}`));
}

// Ensure the always-present Playground project exists (built lazily on first call) and
// return its job id. Idempotent.
export async function ensurePlayground(): Promise<{ job_id: string }> {
  return jsonOrThrow<{ job_id: string }>(await fetch("/playground", { method: "POST" }));
}

export async function saveProject(jobId: string, payload: unknown): Promise<{ ok: boolean }> {
  return jsonOrThrow<{ ok: boolean }>(
    await fetch(`/projects/${jobId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  );
}

export async function deleteProject(jobId: string): Promise<{ ok: boolean }> {
  return jsonOrThrow<{ ok: boolean }>(await fetch(`/projects/${jobId}`, { method: "DELETE" }));
}
