import { useEffect, useRef, useState } from "react";
import { getSettings, putSettings, testRemote } from "../lib/api";
import type { AppSettings, RemoteHealth } from "../lib/api";
import Info from "../ui/Info";

// App-level ⚙ settings (opened from the header, any screen). One section today:
// REMOTE INFERENCE — run the heavy diffusion operations on a rented GPU box
// (backend/remote_app.py) instead of this machine, each operation toggleable.
// Every change saves immediately (PUT /settings — the backend is the store);
// generations pick the new routing up on their very next call, no restart.
export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [probe, setProbe] = useState<{ state: "idle" | "busy" | "ok" | "err"; msg: string }>({
    state: "idle",
    msg: "",
  });
  const seq = useRef(0); // last-write-wins guard for rapid toggle clicks

  useEffect(() => {
    getSettings().then(setSettings, (e) => setSaveErr(e.message));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const patch = (p: Partial<AppSettings["inference"]>) => {
    if (!settings) return;
    const next = { ...settings, inference: { ...settings.inference, ...p } };
    setSettings(next); // optimistic — the PUT echoes the merged truth back
    setSaveErr(null);
    const mySeq = ++seq.current;
    putSettings({ inference: next.inference }).then(
      (saved) => {
        if (seq.current === mySeq) setSettings(saved);
      },
      (e) => setSaveErr(e.message)
    );
  };

  const onTest = async () => {
    if (!settings) return;
    setProbe({ state: "busy", msg: "probing…" });
    try {
      const h: RemoteHealth = await testRemote(settings.inference.url, settings.inference.token);
      setProbe({ state: "ok", msg: `${h.device} · ${h.gpu} · torch ${h.torch} · ${h.latency_ms} ms` });
    } catch (e) {
      setProbe({ state: "err", msg: e instanceof Error ? e.message : "unreachable" });
    }
  };

  const inf = settings?.inference;
  const OPS: { key: keyof AppSettings["inference"]["ops"]; label: string; hint: string }[] = [
    { key: "stylize", label: "AI Stylize", hint: "the slowest one — HD ControlNet clips" },
    { key: "imagegen", label: "Image gen", hint: "the ✨ card + the export's HD images" },
    { key: "depth", label: "Extract depth", hint: "the Extract card's depth model" },
  ];

  return (
    <div className="anim-modal-scrim" onPointerDown={onClose}>
      <div
        className="anim-modal"
        role="dialog"
        aria-label="Settings"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="anim-modal-head">
          <span className="anim-modal-title">SETTINGS</span>
          <button className="iconbtn" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="anim-modal-body">
          {!inf ? (
            <div className="settings-note">{saveErr || "loading…"}</div>
          ) : (
            <>
              <div className="out-field">
                <span className="out-label">
                  remote inference
                  <Info
                    text="Run the heavy AI generation on a rented GPU server (RunPod & co) instead of this machine. Start backend/remote_app.py there, paste its URL here."
                    section="settings-remote"
                  />
                </span>
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={inf.enabled}
                    onChange={(e) => patch({ enabled: e.target.checked })}
                  />
                  <span>{inf.enabled ? "on — ops below run remotely" : "off — everything runs locally"}</span>
                </label>
              </div>

              <div className="out-field">
                <span className="out-label">server URL</span>
                <input
                  className="hz-input"
                  type="url"
                  placeholder="https://xxxxx-5100.proxy.runpod.net"
                  value={inf.url}
                  onChange={(e) => patch({ url: e.target.value })}
                />
              </div>

              <div className="out-field">
                <span className="out-label">
                  token
                  <Info
                    text="Must match the KAIKA_REMOTE_TOKEN the server was started with. Leave empty only if the server runs without one (private network)."
                    section="settings-remote"
                  />
                </span>
                <input
                  className="hz-input"
                  type="password"
                  placeholder="KAIKA_REMOTE_TOKEN"
                  value={inf.token}
                  onChange={(e) => patch({ token: e.target.value })}
                  autoComplete="off"
                />
              </div>

              <div className="out-field">
                <span className="out-label">&nbsp;</span>
                <div className="settings-test">
                  <button className="btn sm" onClick={onTest} disabled={probe.state === "busy" || !inf.url.trim()}>
                    test connection
                  </button>
                  {probe.state !== "idle" && (
                    <span className={"settings-probe " + probe.state}>{probe.msg}</span>
                  )}
                </div>
              </div>

              <div className="out-field">
                <span className="out-label">
                  run remotely
                  <Info
                    text="Per-operation switch: checked operations go to the server (when remote inference is on), the rest stay local. Applies to the next generation immediately."
                    section="settings-remote"
                  />
                </span>
                <div className="settings-ops">
                  {OPS.map((op) => (
                    <label key={op.key} className="settings-toggle" title={op.hint}>
                      <input
                        type="checkbox"
                        checked={inf.ops[op.key]}
                        onChange={(e) => patch({ ops: { ...inf.ops, [op.key]: e.target.checked } })}
                        disabled={!inf.enabled}
                      />
                      <span>{op.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {saveErr && <div className="anim-asset-err">save failed: {saveErr}</div>}
              <div className="settings-note">
                Fluid simulation, stem separation and rendering always run locally. If the server
                is unreachable, a generation fails with a clear error — nothing silently falls
                back to a slow local run.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
