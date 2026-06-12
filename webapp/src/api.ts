// Typed client for the Kaika API. Same origin in production; Vite proxies in dev.

export interface Section { start: number; end: number; label: string; energy?: number; }
export interface Beat { t: number; mag: number; }
export interface Segment {
  start: number; end: number; label: string;
  prompt: string;
  fluid: any; // partial config-tree overrides
}
export interface TimelineDirective {
  at?: number | string;           // seconds or "section:drop+4" / "beat:32" / "bar:8"
  between?: (number | string)[];
  action: "spawn" | "set" | "mute" | "unmute";
  emitter?: string;
  count?: number;
  mag?: number;
  placement?: any;
  color?: any;
  body?: any;
  set?: Record<string, number>;
  fade_s?: number;
}
export interface Analysis {
  tempo_bpm: number; duration_s: number; fps: number; n_frames: number;
  beats: Beat[]; onsets?: Record<string, number[]>;
  onset_counts: Record<string, number>; waveform: number[];
}
export interface Signals {
  n_frames: number; fps: number; duration_s: number;
  rms: number[]; flux: number[];
  bands: { low: number[]; mid: number[]; high: number[] };
  onsets: Record<string, number[]>; beats: number[]; sections: Section[];
}
export interface ProjectDoc {
  audio: string; fps: number; seconds: number | null; recipe: any;
  segments: Segment[]; timeline: TimelineDirective[]; ui_pins: string[];
}
export interface ProjectPayload {
  run_id: string; project: ProjectDoc; manifest: RunManifest;
  analysis?: Analysis; audio_url?: string | null;
}
export interface RecipeEntry { name: string; yaml: string; recipe: any; }
export interface JobState {
  id: string; status: string; stage: string | null;
  done: number; total: number; run_id: string | null; error: string | null; kind?: string;
}
export interface RunManifest {
  id: string; created: number; recipe: string; fps: number; n_frames: number;
  stage?: string; status: string; sync: { lag_frames: number; correlation: number } | null;
  final?: string; fluid_preview?: string; stages: Record<string, any>;
  warnings?: string[];
  window_preview?: { start: number; end: number; draft: boolean };
}
export interface Revision { index: number; time: number; note: string; }
export interface Settings {
  llm_provider: string; llm_model: string;
  anthropic_api_key: boolean | string; gemini_api_key: boolean | string;
}
export interface ChatEvent {
  type: "text" | "tool_call" | "tool_result" | "done" | "error";
  text?: string; name?: string; input?: any; result?: string;
  changes?: string[]; preview_job?: string | null;
  render_job?: string | null; error?: string;
}

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json() as Promise<T>;
}
const JSON_H = { "Content-Type": "application/json" };

export const api = {
  recipes: () => fetch("/api/recipes").then(j<RecipeEntry[]>),
  schema: () => fetch("/api/schema/recipe").then(j<any>),

  upload: (file: File, lyrics?: string) => {
    const fd = new FormData();
    fd.append("file", file);
    if (lyrics?.trim()) {
      fd.append("lyrics", new Blob([lyrics], { type: "text/plain" }),
        "lyrics.txt");
    }
    return fetch("/api/upload", { method: "POST", body: fd })
      .then(j<{ audio_id: string; name: string; has_lyrics?: boolean }>);
  },

  // ---- projects ----
  createProject: (body: { audio_id: string; recipe?: any; recipe_name?: string; seconds?: number }) =>
    fetch("/api/projects", { method: "POST", headers: JSON_H, body: JSON.stringify(body) })
      .then(j<ProjectPayload>),
  getProject: (runId: string) => fetch(`/api/projects/${runId}`).then(j<ProjectPayload>),
  updateProject: (runId: string, body: { segments?: Segment[]; recipe?: any; seconds?: number;
                                         timeline?: TimelineDirective[]; ui_pins?: string[] }) =>
    fetch(`/api/projects/${runId}`, { method: "PUT", headers: JSON_H, body: JSON.stringify(body) })
      .then(j<ProjectPayload>),
  patchRecipe: (runId: string, ops: { op: string; path: string; value?: any }[]) =>
    fetch(`/api/projects/${runId}/recipe`, { method: "PATCH", headers: JSON_H, body: JSON.stringify({ ops }) })
      .then(j<ProjectPayload>),
  setRecipe: (runId: string, recipe: any) =>
    fetch(`/api/projects/${runId}/recipe`, { method: "PATCH", headers: JSON_H, body: JSON.stringify({ recipe }) })
      .then(j<ProjectPayload>),
  patchTimeline: (runId: string, timeline: TimelineDirective[]) =>
    fetch(`/api/projects/${runId}/timeline`, { method: "PATCH", headers: JSON_H, body: JSON.stringify({ timeline }) })
      .then(j<ProjectPayload>),
  signals: (runId: string, px = 1600) =>
    fetch(`/api/projects/${runId}/signals?px=${px}`).then(j<Signals>),

  // ---- previews / renders ----
  previewProject: (runId: string, draft = false) =>
    fetch(`/api/projects/${runId}/preview`, { method: "POST", headers: JSON_H, body: JSON.stringify({ draft }) })
      .then(j<{ job_id: string }>),
  previewWindow: (runId: string, t0: number, t1: number, draft = true) =>
    fetch(`/api/projects/${runId}/preview_window`, { method: "POST", headers: JSON_H,
      body: JSON.stringify({ t0, t1, draft }) }).then(j<{ job_id: string }>),
  previewSegment: (runId: string, index: number, draft = true) =>
    fetch(`/api/projects/${runId}/preview_segment`, { method: "POST", headers: JSON_H, body: JSON.stringify({ index, draft }) })
      .then(j<{ job_id: string }>),
  generateProject: (runId: string) =>
    fetch(`/api/projects/${runId}/generate`, { method: "POST" }).then(j<{ job_id: string }>),

  // ---- revisions (undo) ----
  revisions: (runId: string) => fetch(`/api/projects/${runId}/revisions`).then(j<Revision[]>),
  restoreRevision: (runId: string, index: number) =>
    fetch(`/api/projects/${runId}/revisions/${index}/restore`, { method: "POST" })
      .then(j<ProjectPayload>),

  // ---- settings ----
  getSettings: () => fetch("/api/settings").then(j<Settings>),
  putSettings: (s: Partial<Settings>) =>
    fetch("/api/settings", { method: "PUT", headers: JSON_H, body: JSON.stringify(s) })
      .then(j<Settings>),

  // ---- chat (SSE over fetch) ----
  chatHistory: (runId: string) => fetch(`/api/projects/${runId}/chat`).then(j<any[]>),
  chat: async (runId: string, message: string, onEvent: (e: ChatEvent) => void,
               reset = false): Promise<void> => {
    const r = await fetch(`/api/projects/${runId}/chat`, {
      method: "POST", headers: JSON_H, body: JSON.stringify({ message, reset }),
    });
    if (!r.ok) throw new Error((await r.text()) || r.statusText);
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (chunk.startsWith("data: ")) onEvent(JSON.parse(chunk.slice(6)));
      }
    }
  },

  job: (id: string) => fetch(`/api/jobs/${id}`).then(j<JobState>),
  runs: () => fetch("/api/runs").then(j<RunManifest[]>),
  run: (id: string) => fetch(`/api/runs/${id}`).then(j<RunManifest>),
  finalUrl: (id: string) => `/api/runs/${id}/final`,
  previewUrl: (id: string) => `/api/runs/${id}/files/fluid_preview.mp4`,
  windowPreviewUrl: (id: string) => `/api/runs/${id}/files/window_preview.mp4`,
  posterUrl: (id: string) => `/api/runs/${id}/latest_frame`,
  fileUrl: (id: string, sub: string) => `/api/runs/${id}/files/${sub}`,

  watchJob: (id: string, onMsg: (s: JobState) => void): WebSocket => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/jobs/${id}`);
    ws.onmessage = (e) => onMsg(JSON.parse(e.data));
    return ws;
  },
};

export const STAGES = ["analyze", "simulate", "control", "diffuse", "post"];

// ---- helpers shared by the schema-driven inspector --------------------------

export function getPath(obj: any, path: string): any {
  let o = obj;
  for (const k of path.split(".")) {
    if (o == null) return undefined;
    o = o[k];
  }
  return o;
}

export function setPath(obj: any, path: string, value: any): any {
  const parts = path.split(".");
  const next = structuredClone(obj ?? {});
  let o = next;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (o[k] == null || typeof o[k] !== "object") o[k] = {};
    o = o[k];
  }
  o[parts[parts.length - 1]] = value;
  return next;
}
