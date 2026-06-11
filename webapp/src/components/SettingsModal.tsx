// Settings: LLM provider + model + API keys (keys live server-side; the UI
// only ever sees whether one is set).
import { useEffect, useState } from "react";
import { api, Settings } from "../api";

const MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  gemini: "gemini-2.5-flash",
};

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [anthropicKey, setAnthropicKey] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("anthropic");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getSettings().then((x) => {
      setS(x);
      setProvider(x.llm_provider || "anthropic");
      setModel(x.llm_model || "");
    }).catch(() => {});
  }, []);

  const save = async () => {
    const body: any = { llm_provider: provider, llm_model: model };
    if (anthropicKey) body.anthropic_api_key = anthropicKey;
    if (geminiKey) body.gemini_api_key = geminiKey;
    setS(await api.putSettings(body));
    setAnthropicKey("");
    setGeminiKey("");
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        <h3>Settings</h3>
        <label className="field">Chat copilot provider</label>
        <select value={provider} onChange={(e) => {
          setProvider(e.target.value);
          setModel("");
        }}>
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="gemini">Google (Gemini)</option>
        </select>
        <label className="field">Model</label>
        <input type="text" value={model} placeholder={MODELS[provider] || ""}
          onChange={(e) => setModel(e.target.value)} />
        <label className="field">
          Anthropic API key {s?.anthropic_api_key === true && <span className="ok">set ✓</span>}
        </label>
        <input type="password" value={anthropicKey} placeholder="sk-ant-…"
          onChange={(e) => setAnthropicKey(e.target.value)} />
        <label className="field">
          Gemini API key {s?.gemini_api_key === true && <span className="ok">set ✓</span>}
        </label>
        <input type="password" value={geminiKey} placeholder="AIza…"
          onChange={(e) => setGeminiKey(e.target.value)} />
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button className="btn" onClick={save}>{saved ? "Saved ✓" : "Save"}</button>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Keys are stored locally on the server (.kaika/settings.json) and are
          never sent to the browser.
        </p>
      </div>
    </div>
  );
}
