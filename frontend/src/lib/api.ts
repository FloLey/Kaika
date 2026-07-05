// Thin fetch wrappers around the Flask API, with a typed response per endpoint.
// The only `any` is inside jsonOrThrow — the genuine JSON parse boundary, where the
// envelope's error fields are read before the payload is cast to its declared type.

import * as logbus from "./logbus";
import type { BackendPayload } from "./logbus";
import type { Asset, Graph, OutputSettings, StemInfo } from "./types";
import type { ExportSettings } from "./export";
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
  export?: Partial<ExportSettings>;
  assets?: Asset[];
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

// Live status of a progressive block render (see backend/render_jobs.py) — the same
// shape for a single-segment stream render AND the final full-track export. While
// `running`, show `preview_url` (grows block by block); once `done`, use `url`.
export interface RenderStatus {
  // "gone" = the backend no longer knows this render_id (e.g. its in-memory job was
  // dropped when the dev server hot-reloaded). Benign — the caller just stops quietly.
  state: "running" | "done" | "cancelled" | "error" | "gone";
  frames_done: number;
  total: number;
  preview_url: string | null;
  url: string | null;
  error: string | null;
}

// The historical per-endpoint names, kept as aliases for existing importers.
export type StreamStatus = RenderStatus;
export type ExportStatus = RenderStatus;

const GONE_STATUS: RenderStatus = {
  state: "gone",
  frames_done: 0,
  total: 0,
  preview_url: null,
  url: null,
  error: null,
};

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

// The two dominant call shapes, so each endpoint wrapper is one line: send a JSON
// body (POST unless overridden) / plain GET, and parse the JSON response through
// jsonOrThrow. Endpoints with a different shape (FormData, DELETE, raw 404
// handling) still call fetch + jsonOrThrow directly.
async function postJson<T>(url: string, body: unknown, method: "POST" | "PUT" = "POST"): Promise<T> {
  return jsonOrThrow<T>(
    await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

async function getJson<T>(url: string): Promise<T> {
  return jsonOrThrow<T>(await fetch(url));
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

// Upload an image/video file to the project's asset library. Synchronous (no ingestion
// job) — returns the stored asset (with its served URL) which the Image/Video node stores
// in `data.assetUrl`, and which the library lists.
export async function uploadAsset(jobId: string, file: File): Promise<Asset> {
  const form = new FormData();
  form.append("file", file);
  return jsonOrThrow(await fetch(`/upload-asset/${jobId}`, { method: "POST", body: form }));
}

// The project's asset library (`data.assets`).
export async function listAssets(jobId: string): Promise<Asset[]> {
  return getJson<Asset[]>(`/assets/${jobId}`);
}

// Remove a library asset by id (unlinks the file + drops the entry).
export async function deleteAsset(jobId: string, assetId: string): Promise<{ ok: boolean }> {
  return jsonOrThrow(await fetch(`/assets/${jobId}/${assetId}`, { method: "DELETE" }));
}

// Import a YouTube video into the library (Video card action). Async — returns a job id;
// poll it (pollJob) for the resulting Asset.
export async function assetFromYoutube(jobId: string, url: string): Promise<JobAck> {
  return postJson<JobAck>(`/asset-from-youtube/${jobId}`, { url });
}

// Generate image(s) locally (the Image gen card's ✨). Async — returns a job id;
// poll it (pollJob) for `{assets: Asset[]}` (runs on the GPU job queue, so a
// generation waits politely behind a running separation).
export async function generateImage(
  jobId: string,
  prompt: string,
  seed: number,
  count = 1
): Promise<JobAck> {
  return postJson<JobAck>(`/generate-image/${jobId}`, { prompt, seed, count });
}

export async function segmentJob(jobId: string): Promise<JobAck> {
  return postJson<JobAck>("/segment", { job_id: jobId });
}

export async function getJob(jobId: string): Promise<JobStatus> {
  return getJson<JobStatus>(`/jobs/${jobId}`);
}

// Human-readable label per backend step (jobs.py / worker `set_step`).
const STEP_LABELS: Record<string, string> = {
  downloading: "downloading audio from YouTube…",
  extracting: "extracting audio from video…",
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
  return postJson<ExtractResult>("/extract", params);
}

// Resolve one value node's 0..1 curve for a segment+graph — the Scope card's live view.
export async function resolveCurve(params: {
  job_id: string;
  segment: unknown;
  graph: unknown;
  node_id: string;
}): Promise<ExtractResult> {
  return postJson<ExtractResult>("/resolve", params);
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
  return postJson<RenderResult>("/animate", { job_id, segment, graph, output, output_id });
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
  return postJson<StreamStartResult>("/animate/stream", body);
}

// Poll a progressive render (stream or export). A 404 means the render_id is unknown
// (typically the dev server reloaded and dropped the in-memory job). Report it as
// "gone" — a benign stop — instead of throwing/logging.
async function getRenderStatus(url: string): Promise<RenderStatus> {
  const res = await fetch(url);
  if (res.status === 404) return GONE_STATUS;
  return jsonOrThrow<RenderStatus>(res);
}

export async function getStreamStatus(renderId: string): Promise<RenderStatus> {
  return getRenderStatus(`/animate/stream/${renderId}`);
}

// Fire-and-forget: signal a render to stop after its current block. Swallows errors
// (the render may already be gone) so callers can call it freely on edit/unmount.
export async function cancelStreamRender(renderId: string): Promise<void> {
  await fetch(`/animate/stream/${renderId}/cancel`, { method: "POST" }).catch(() => {});
}

// Final export: kick off the full-track HD render (every segment's marked output,
// stitched) and poll it the same way as a stream render. 400s if any segment lacks
// a final output (the message lists the missing segment ids).
export async function startExport(jobId: string): Promise<StreamStartResult> {
  return postJson<StreamStartResult>("/export/stream", { job_id: jobId });
}

export async function getExportStatus(renderId: string): Promise<RenderStatus> {
  return getRenderStatus(`/export/stream/${renderId}`);
}

// Fire-and-forget: signal the export to stop after its current block. Swallows
// errors (the render may already be gone) so callers can call it freely on
// cancel/unmount.
export async function cancelExport(renderId: string): Promise<void> {
  await fetch(`/export/stream/${renderId}/cancel`, { method: "POST" }).catch(() => {});
}

export async function listProjects(): Promise<ProjectSummary[]> {
  return getJson<ProjectSummary[]>("/projects");
}

export interface FontOption {
  key: string;
  label: string;
}

// The bundled lyric fonts for the lyrics card's font picker.
export async function listFonts(): Promise<FontOption[]> {
  return getJson<FontOption[]>("/fonts");
}

export async function getProject(jobId: string): Promise<Project> {
  return getJson<Project>(`/projects/${jobId}`);
}

// Ensure the always-present Playground project exists (built lazily on first call) and
// return its job id. Idempotent.
export async function ensurePlayground(): Promise<{ job_id: string }> {
  return jsonOrThrow<{ job_id: string }>(await fetch("/playground", { method: "POST" }));
}

export async function saveProject(jobId: string, payload: unknown): Promise<{ ok: boolean }> {
  return postJson<{ ok: boolean }>(`/projects/${jobId}`, payload, "PUT");
}

export async function deleteProject(jobId: string): Promise<{ ok: boolean }> {
  return jsonOrThrow<{ ok: boolean }>(await fetch(`/projects/${jobId}`, { method: "DELETE" }));
}
