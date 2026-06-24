// Thin fetch wrappers around the Flask API.

async function jsonOrThrow(res) {
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    // e.g. an HTML SPA-fallback page — surface it instead of silently failing.
    const text = await res.text().catch(() => "");
    throw new Error(
      `expected JSON from ${res.url} but got ${res.status} (${ct}). ${text.slice(0, 120)}`
    );
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || data.error || res.statusText);
  return data;
}

// /upload and /segment now return { job_id } immediately and do the slow work
// in the background; poll the job to get the result. See pollJob below.
export async function uploadSong(formData) {
  return jsonOrThrow(await fetch("/upload", { method: "POST", body: formData }));
}

export async function segmentJob(jobId) {
  return jsonOrThrow(
    await fetch("/segment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId }),
    })
  );
}

export async function getJob(jobId) {
  return jsonOrThrow(await fetch(`/jobs/${jobId}`));
}

// Human-readable label per backend step (jobs.py / app.py worker `set_step`).
const STEP_LABELS = {
  downloading: "downloading audio from YouTube…",
  separating: "separating stems with demucs…",
  rendering: "rendering spectrograms…",
  analysing: "analysing structure (lyrics + vocal activity)…",
  done: "finishing up…",
};

// Poll a background job until it finishes; resolve with its result, throw on
// error. `onStep(label)` is called as the worker advances through its phases.
export async function pollJob(jobId, onStep, intervalMs = 1000) {
  for (;;) {
    const j = await getJob(jobId);
    if (onStep && j.step) onStep(STEP_LABELS[j.step] || j.step);
    if (j.state === "done") return j.result;
    if (j.state === "error") throw new Error(j.error || "job failed");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function extractSignal(params) {
  return jsonOrThrow(
    await fetch("/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    })
  );
}

export async function runFluid(params) {
  return jsonOrThrow(
    await fetch("/fluid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    })
  );
}

export async function listProjects() {
  return jsonOrThrow(await fetch("/projects"));
}

export async function getProject(jobId) {
  return jsonOrThrow(await fetch(`/projects/${jobId}`));
}

export async function saveProject(jobId, payload) {
  return jsonOrThrow(
    await fetch(`/projects/${jobId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  );
}

export async function deleteProject(jobId) {
  return jsonOrThrow(await fetch(`/projects/${jobId}`, { method: "DELETE" }));
}
