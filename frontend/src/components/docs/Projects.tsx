// The `projects` section of the in-app user guide. Split out of a single 1557-line
// Docs.tsx (cleanup step 13) — pure static JSX, no props, no shared state.
// The anchor id is load-bearing: every "?" in the UI deep-links to /?doc=projects,
// and paramHelp.test.tsx asserts the rendered ids match DOC_SECTION_IDS exactly.
export default function Projects() {
  return (
    <section id="projects">
      <h2>
        <span className="num">2</span>Projects &amp; resuming
      </h2>
      <p>
        The Projects screen lists every track you've worked on, most recent first. Each row shows
        the title, source, and how far you got (Review or Studio).
      </p>
      <ul>
        <li>
          <strong>+ new track</strong> — start a fresh upload.
        </li>
        <li>
          <strong>Open a project</strong> — click a row to jump back to where you left off; your
          segments and per-segment edits load exactly as you saved them.
        </li>
        <li>
          <strong>⧉ Duplicate</strong> — an instant, fully <em>independent</em> copy of the project
          (title gets “(copy)”): segments, animations, assets, everything. Duplicate before a risky
          experiment, or to fork variants of the same track; the copy survives even if the original
          is later deleted.
        </li>
        <li>
          <strong>Delete</strong> — removes the project <em>and</em> its audio, stems, and
          spectrograms from disk. This can't be undone.
        </li>
        <li>
          <strong>🎮 playground</strong> — opens the always-present{" "}
          <a href="#fluid-lab">Playground</a> sandbox (one segment per card). When new cards ship,
          their demo segments are appended automatically the next time you open it — your own edits
          and experiments stay untouched.
        </li>
      </ul>
      <p>
        Work is saved automatically as you go, so there is no “save” button — just leave when you're
        done.
      </p>
    </section>
  );
}
