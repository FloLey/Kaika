import { useState } from "react";
import Studio from "./components/Studio";
import RenderView from "./components/RenderView";
import Gallery from "./components/Gallery";
import SettingsModal from "./components/SettingsModal";
import HelpLink from "./components/HelpLink";

type View = "studio" | "render" | "gallery";

export default function App() {
  const [view, setView] = useState<View>("studio");
  const [runId, setRunId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);

  const tab = (v: View, label: string) => (
    <button className={view === v ? "active" : ""} onClick={() => setView(v)}>
      {label}
    </button>
  );

  return (
    <div className="app">
      <header className="top">
        <span className="brand">Kaika <span className="kanji">開花</span></span>
        <nav className="tabs">
          {tab("studio", "Studio")}
          {tab("render", "Render")}
          {tab("gallery", "Gallery")}
        </nav>
        <HelpLink className="top" />
        <button className="gear" style={{ marginLeft: 0 }} title="Settings"
          onClick={() => setSettings(true)}>⚙</button>
      </header>

      {view === "studio" && (
        <Studio
          initialRunId={runId}
          onPreview={(rid, jid) => { setRunId(rid); setJobId(jid); setView("render"); }}
        />
      )}
      {view === "render" && (
        <RenderView runId={runId} jobId={jobId} onSeeGallery={() => setView("gallery")} />
      )}
      {view === "gallery" && (
        <Gallery onOpenInStudio={(rid) => { setRunId(rid); setView("studio"); }} />
      )}
      {settings && <SettingsModal onClose={() => setSettings(false)} />}
    </div>
  );
}
