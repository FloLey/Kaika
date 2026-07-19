// The `tips` section of the in-app user guide. Split out of a single 1557-line
// Docs.tsx (cleanup step 13) — pure static JSX, no props, no shared state.
// The anchor id is load-bearing: every "?" in the UI deep-links to /?doc=tips,
// and paramHelp.test.tsx asserts the rendered ids match DOC_SECTION_IDS exactly.
export default function Tips() {
  return (
    <section id="tips">
      <h2>
        <span className="num">9</span>Tips &amp; troubleshooting
      </h2>
      <ul>
        <li>
          <strong>First run is slow.</strong> The first separation downloads the Demucs weights and
          the first lyric alignment downloads a Whisper model. After that, models are cached and
          only the audio processing takes time.
        </li>
        <li>
          <strong>Lyrics give the best structure.</strong> If the proposed segments look off, the
          single biggest improvement is adding lyrics on upload — even rough plain text.
        </li>
        <li>
          <strong>No language model? No problem.</strong> Section labelling prefers a local LLM
          (Ollama), but if it isn't running the app falls back to a heuristic and still proposes a
          full structure. You can always relabel by hand in Review.
        </li>
        <li>
          <strong>GPU.</strong> On Apple Silicon, separation uses the Metal (MPS) GPU automatically;
          elsewhere it runs on CPU (slower but identical results).
        </li>
        <li>
          <strong>Nothing is lost.</strong> Edits autosave continuously. Close the tab whenever you
          like and reopen the project from the Projects screen to pick up where you stopped.
        </li>
        <li>
          <strong>Deleting is permanent.</strong> Deleting a project also removes its audio, stems
          and spectrograms from disk — there's no undo.
        </li>
      </ul>
    </section>
  );
}
