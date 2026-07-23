// Thin fetch wrappers around the Flask API, with a typed response per endpoint.
// The only `any` is inside jsonOrThrow — the genuine JSON parse boundary, where the
// envelope's error fields are read before the payload is cast to its declared type.

import * as logbus from "./logbus";
import type { BackendPayload } from "./logbus";
import type { Asset, Graph, LyricLine, OutputSettings, StemInfo } from "./types";
import type { ExportSettings } from "./export";
import type { RawSegment } from "./segments";
import type { RawCompositionPool } from "./compositions";

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
  lyric_lines?: LyricLine[];
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
  compositions?: RawCompositionPool;
  output?: Partial<OutputSettings>;
  export?: Partial<ExportSettings>;
  assets?: Asset[];
  vocal_envelope?: number[];
  envelope_times?: number[];
  lyric_lines?: LyricLine[];
}

export interface ExtractResult {
  curve: number[];
  times: number[];
  fps?: number; // the sampling rate of `curve` (the /resolve default is 30)
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
  // Which step a job is on when the work happens OUTSIDE the frame loop —
  // "assets" (HD image/stylize regeneration), "render", "audio" (muxing). Lets a
  // long HD job explain why it's still at 0% instead of looking hung.
  phase?: string | null;
  // "2/4 · verse" — which segment a WHOLE-SONG export is on. Its frame counter only
  // advances once per segment (one long jump each), so this is what tells you it is
  // working rather than hung. Absent on single-segment renders.
  segment?: string | null;
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
async function postJson<T>(
  url: string,
  body: unknown,
  method: "POST" | "PUT" = "POST"
): Promise<T> {
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
// in `data.assetUrl`, and which the library lists. `folder` (a relative path, e.g. from a
// folder upload's webkitRelativePath) is kept as display metadata the library groups by.
export async function uploadAsset(jobId: string, file: File, folder?: string): Promise<Asset> {
  const form = new FormData();
  form.append("file", file);
  if (folder) form.append("folder", folder);
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
// poll it (pollJob) for the resulting Asset. Optional start/end timestamps (SS, MM:SS or
// HH:MM:SS) download ONLY that section of the video, not the whole file.
export async function assetFromYoutube(
  jobId: string,
  url: string,
  start?: string,
  end?: string
): Promise<JobAck> {
  return postJson<JobAck>(`/asset-from-youtube/${jobId}`, {
    url,
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
  });
}

// Generate image(s) locally (the Image gen card's ✨). Async — returns a job id;
// poll it (pollJob) for `{assets: Asset[]}` (runs on the GPU job queue, so a
// generation waits politely behind a running separation).
export async function generateImage(
  jobId: string,
  prompts: string[],
  seed: number,
  model?: string
): Promise<JobAck> {
  return postJson<JobAck>(`/generate-image/${jobId}`, { prompts, seed, model });
}

export async function segmentJob(jobId: string): Promise<JobAck> {
  return postJson<JobAck>("/segment", { job_id: jobId });
}

// AI Stylize card: diffuse the upstream fluid clip (img2img / inpaint) into an mp4
// asset. Async — returns a job id; poll it for `{assets: Asset[]}` (the generated clip).
export async function stylizeClip(
  jobId: string,
  body: { graph: unknown; segment: unknown; output: unknown; node_id: string }
): Promise<JobAck> {
  return postJson<JobAck>(`/stylize/${jobId}`, body);
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
  generating: "generating images…",
  stylizing: "stylizing frames with diffusion…",
  done: "finishing up…",
};

// Poll a background job until it finishes; resolve with its result, throw on
// error. The result shape depends on the job (upload vs segment), so callers pick
// the type: `pollJob<UploadResult>(...)`. `onStep(label)` fires as phases advance.
// Pass a `signal` (AbortController) so an unmounting component can stop the loop —
// otherwise a forgotten poll keeps hitting /jobs and calling setState forever.
export async function pollJob<T = unknown>(
  jobId: string,
  onStep?: (label: string) => void,
  intervalMs = 1000,
  signal?: AbortSignal
): Promise<T> {
  for (;;) {
    if (signal?.aborted) throw new DOMException("poll aborted", "AbortError");
    const j = await getJob(jobId);
    if (signal?.aborted) throw new DOMException("poll aborted", "AbortError");
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
// `fps` samples the curve on the caller's timeline (the montage passes the project fps
// so its frame→seconds conversions match the render); the response echoes it back.
export async function resolveCurve(params: {
  job_id: string;
  segment: unknown;
  graph: unknown;
  node_id: string;
  fps?: number;
}): Promise<ExtractResult> {
  return postJson<ExtractResult>("/resolve", params);
}

// Resolve one points node's positions for a segment+graph — the points cards' preview.
export async function resolvePoints(params: {
  job_id: string;
  segment: unknown;
  graph: unknown;
  node_id: string;
}): Promise<{ points: [number, number][] }> {
  return postJson<{ points: [number, number][] }>("/resolve-points", params);
}

// Progressive render: start a background block render and poll it. Produces the same
// clip the old one-shot `/animate` client did, but front-to-back in ~5s blocks, so the
// first seconds show in ~1/10th the time and the preview grows. The frontend cancels the
// previous render on every edit (see cancelStreamRender), so abandoned renders stop early.
// This superseded `renderGraph`, which sat unused until cleanup step 11 removed it.
export async function startStreamRender(body: {
  job_id: string;
  segment: unknown;
  graph: Graph;
  output?: unknown;
  output_id?: string;
  // The reachable slice of the composition pool (montage extracts) — undefined
  // when the graph references none.
  compositions?: RawCompositionPool;
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

// Cut [start, end] (seconds) out of a finished master (its /fluid/... url) — the
// platform-length trim. Synchronous re-encode server-side (frame-accurate), cached:
// an identical re-cut returns instantly.
export async function trimExport(
  url: string,
  start: number,
  end: number
): Promise<{ url: string }> {
  return postJson<{ url: string }>("/export/trim", { url, start, end });
}

// HD render of ONE segment, at the final export's settings (an Output card's "HD"
// button). The segment + graph travel in the body — autosave is debounced, so the
// DB copy can lag what's on screen and this must render exactly what the user sees;
// the HD settings (size/fps/grid/audio) come from the project's saved export block.
// Polled and cancelled through the SAME endpoints as the whole-song export.
// Throws with the backend's message on 409 (an HD render is already running).
export async function startSegmentHdRender(body: {
  job_id: string;
  segment: unknown;
  graph: unknown;
  output_id?: string;
  hdStylize?: boolean;
  compositions?: RawCompositionPool;
}): Promise<StreamStartResult> {
  return postJson<StreamStartResult>("/export/segment", body);
}

// Has this exact segment already been rendered in HD? Stateless on the backend: it
// hashes what you send (the same key the render writes under) and looks in the render
// cache. `{url: null}` when nothing matches — an edited graph hashes differently, so
// the answer goes stale on its own. Lets a reloaded editor offer the finished file
// instead of re-rendering it; the in-memory job registry is gone after a reload, the
// FILE is not.
export async function findSegmentHdRender(body: {
  job_id: string;
  segment: unknown;
  graph: unknown;
  output_id?: string;
  compositions?: RawCompositionPool;
}): Promise<{ url: string | null; audio?: boolean }> {
  return postJson<{ url: string | null; audio?: boolean }>("/export/segment/cached", body);
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

// ---- app-level settings (⚙ modal) -------------------------------------------------
// Remote inference: which diffusion operations run on a rented GPU box
// (backend/remote_app.py) instead of locally. Stored server-side in data/settings.json.
export interface AppSettings {
  inference: {
    enabled: boolean;
    url: string;
    token: string;
    ops: { stylize: boolean; imagegen: boolean; depth: boolean };
  };
}

export async function getSettings(): Promise<AppSettings> {
  return jsonOrThrow<AppSettings>(await fetch("/settings"));
}

export async function putSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  return postJson<AppSettings>("/settings", patch, "PUT");
}

// Probe the remote box's /health from the backend (token stays server-side).
// Returns device/GPU/latency, or throws with the backend's clean error message.
export interface RemoteHealth {
  ok: boolean;
  device: string;
  gpu: string;
  torch: string;
  latency_ms: number;
}

export async function testRemote(url?: string, token?: string): Promise<RemoteHealth> {
  return postJson<RemoteHealth>("/settings/test-remote", { url, token });
}

// Playground 💾 save-fixture: capture the live Playground into the committed fixture
// (backend/playground_pipelines.json) so the next seed starts from the current state.
// `missing` non-empty = a card lost its demo (CI would fail) — surface as a warning.
export interface FixtureExport {
  exported: number;
  skipped: string[];
  missing: string[];
}

export async function exportPlaygroundFixture(): Promise<FixtureExport> {
  return jsonOrThrow<FixtureExport>(await fetch("/playground/export", { method: "POST" }));
}
