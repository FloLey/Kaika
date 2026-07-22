import { useEffect } from "react";

import GettingStarted from "./docs/GettingStarted";
import Projects from "./docs/Projects";
import Upload from "./docs/Upload";
import Review from "./docs/Review";
import Studio from "./docs/Studio";
import Animation from "./docs/Animation";
import Export from "./docs/Export";
import SettingsRemote from "./docs/SettingsRemote";
import FluidLab from "./docs/FluidLab";
import Tips from "./docs/Tips";

// Every section/anchor id in this guide — the set a "?" deep-link (`/?doc=<id>`) can
// target. The per-argument help catalog (lib/paramHelp.ts) links into these, and a test
// (paramHelp.test.ts) asserts both that this list matches the ids actually rendered here
// AND that every section a "?" references is in it — so a link can never point nowhere.
export const DOC_SECTION_IDS = [
  "getting-started",
  "projects",
  "upload",
  "review",
  "studio",
  "studio-features",
  "studio-shaping",
  "animation",
  "animation-modulators",
  "animation-points",
  "animation-sources",
  "assets",
  "animation-generators",
  "animation-fx",
  "animation-combine",
  "animation-montage",
  "animation-compositions",
  "animation-transform",
  "animation-lookfx",
  "animation-stylize",
  "animation-output",
  "animation-output-hd",
  "export",
  "settings-remote",
  "fluid-lab",
  "fluid-source",
  "fluid-medium",
  "tips",
] as const;

// In-app user guide. Rendered as its own root (see main.tsx) when the URL has
// ?doc=<section>, so every "?" in the app can open it in a new tab scrolled to
// the relevant section. Section ids are referenced by Info badges and the header
// help link — keep them in sync (guarded by DOC_SECTION_IDS + paramHelp.test.ts).
export default function Docs({ section }: { section?: string }) {
  useEffect(() => {
    const id = section || (window.location.hash || "").replace(/^#/, "");
    if (!id) return;
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ block: "start" });
  }, [section]);

  return (
    <div className="docs">
      <header className="docs-head">
        <h1>
          Kaika <span className="kanji">開花</span>
        </h1>
        <span className="sub">user guide</span>
        <a className="back" href="/">
          ← back to the app
        </a>
      </header>

      <p className="lead">
        Kaika splits a song into musical <strong>segments</strong> (intro, verse, chorus…) and lets
        you rework each one independently. You upload audio (or a YouTube link) and optional lyrics;
        the app separates the stems, proposes a structure, and opens a studio where every segment
        gets its own per-stem, per-frequency-band <strong>signal extraction</strong>. Everything
        autosaves, so you can close the tab and resume later.
      </p>

      <nav className="toc">
        <div className="toc-title">Contents</div>
        <ol>
          <li>
            <a href="#getting-started">Getting started</a>
          </li>
          <li>
            <a href="#projects">Projects &amp; resuming</a>
          </li>
          <li>
            <a href="#upload">Upload — file, YouTube, lyrics &amp; stems</a>
          </li>
          <li>
            <a href="#review">Review — the segment structure</a>
          </li>
          <li>
            <a href="#studio">Studio — extracting signals</a>
          </li>
          <li>
            <a href="#animation">Create animation — the node graph</a>
          </li>
          <li>
            <a href="#export">Final export — the whole track in HD</a>
          </li>
          <li>
            <a href="#fluid-lab">Playground &amp; the fluid card</a>
          </li>
          <li>
            <a href="#tips">Tips &amp; troubleshooting</a>
          </li>
        </ol>
      </nav>

      <GettingStarted />

      <Projects />

      <Upload />

      <Review />

      <Studio />

      <Animation />

      <Export />

      <SettingsRemote />

      <FluidLab />

      <Tips />

      <footer className="docs-foot">
        Kaika — local stem separation, LLM-assisted segmentation, and per-segment signal extraction.{" "}
        <a href="/">← back to the app</a>
      </footer>
    </div>
  );
}
