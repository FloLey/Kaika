import { useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { listProjects, deleteProject } from "../lib/api";
import { fmtTime } from "../lib/mel";
import ConfirmDialog from "../ui/ConfirmDialog";

// Start screen: resume a saved project or begin a new one.
interface Project {
  job_id: string;
  title?: string;
  step: string;
  duration?: number;
  has_lyrics?: boolean;
  updated_at?: string;
}

interface ProjectListProps {
  onNew: () => void;
  onOpen: (id: string) => void;
  onPlayground: () => void;
}

export default function ProjectList({ onNew, onOpen, onPlayground }: ProjectListProps) {
  const [projects, setProjects] = useState<Project[] | null>(null); // null = loading
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);

  async function refresh() {
    try {
      setProjects(await listProjects());
    } catch (e) {
      setError((e as Error).message);
      setProjects([]);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  // Deleting is irreversible (audio + stems + spectrograms go with it), so it goes
  // through the app's own confirm rather than the blocking native one.
  function askRemove(e: MouseEvent, p: Project) {
    e.stopPropagation();
    setPendingDelete(p);
  }

  async function confirmRemove() {
    const p = pendingDelete;
    setPendingDelete(null);
    if (!p) return;
    await deleteProject(p.job_id).catch(() => {});
    refresh();
  }

  return (
    <div className="step projects-step">
      <div className="results-head">
        <span className="section-title">PROJECTS</span>
        <div className="controls">
          <button className="btn sm" onClick={onPlayground}>
            🎮 playground
          </button>
          <button className="btn on" onClick={onNew}>
            + new track
          </button>
        </div>
      </div>

      {error && <div className="error">Error: {error}</div>}

      {projects && projects.length === 0 && !error && (
        <div className="empty">No projects yet — start a new track.</div>
      )}

      <div className="project-grid">
        {(projects || []).map((p) => (
          <div
            key={p.job_id}
            className="project-card"
            role="button"
            tabIndex={0}
            onClick={() => onOpen(p.job_id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(p.job_id);
              }
            }}
          >
            <div className="project-title">{p.title || p.job_id}</div>
            <div className="project-meta">
              <span className={"pill pill-" + p.step}>{p.step}</span>
              <span>{fmtTime(p.duration || 0)}</span>
              {p.has_lyrics && <span className="pill pill-lyr">lyrics</span>}
            </div>
            <div className="project-sub">
              {(p.updated_at || "").replace("T", " ").replace("Z", "")}
            </div>
            <span
              className="project-del"
              title="Delete"
              role="button"
              onClick={(e) => askRemove(e, p)}
            >
              ✕
            </span>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={!!pendingDelete}
        message={`Delete “${pendingDelete?.title || pendingDelete?.job_id}” and its audio, stems and spectrograms? This can't be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={confirmRemove}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
