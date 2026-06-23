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
