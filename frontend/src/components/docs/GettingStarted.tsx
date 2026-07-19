// The `getting-started` section of the in-app user guide. Split out of a single 1557-line
// Docs.tsx (cleanup step 13) — pure static JSX, no props, no shared state.
// The anchor id is load-bearing: every "?" in the UI deep-links to /?doc=getting-started,
// and paramHelp.test.tsx asserts the rendered ids match DOC_SECTION_IDS exactly.
export default function GettingStarted() {
  return (
    <section id="getting-started">
      <h2>
        <span className="num">1</span>Getting started
      </h2>
      <p>
        Kaika runs locally. Once it's installed (see the project
        <code>README.md</code>), one command starts everything: <code>make dev</code>. That launches
        Postgres, the Flask API on <code>:5000</code>, and the web UI on <code>:5173</code>. Open{" "}
        <code>http://localhost:5173</code> and you'll land on the <strong>Projects</strong> screen.
      </p>
      <p>The workflow has three stages, always in this order:</p>
      <ul>
        <li>
          <span className="stage">1</span>
          <strong>Upload</strong> — bring in audio + optional lyrics; the app separates stems.
        </li>
        <li>
          <span className="stage">2</span>
          <strong>Review</strong> — check and edit the proposed segment structure.
        </li>
        <li>
          <span className="stage">3</span>
          <strong>Studio</strong> — extract and shape a signal from each stem, per segment.
        </li>
      </ul>
      <div className="note">
        The <strong>?</strong> in the app's top-right corner opens this guide at the section for
        whatever screen you're on. The smaller <span className="pill">?</span>
        badges next to individual controls show a one-line explanation on hover, and clicking one
        jumps straight to the matching part of this guide.
      </div>
    </section>
  );
}
