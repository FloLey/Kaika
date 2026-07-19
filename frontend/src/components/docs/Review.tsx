// The `review` section of the in-app user guide. Split out of a single 1557-line
// Docs.tsx (cleanup step 13) — pure static JSX, no props, no shared state.
// The anchor id is load-bearing: every "?" in the UI deep-links to /?doc=review,
// and paramHelp.test.tsx asserts the rendered ids match DOC_SECTION_IDS exactly.
export default function Review() {
  return (
    <section id="review">
      <h2>
        <span className="num">4</span>Review — the segment structure
      </h2>
      <p>
        Before the studio, the app proposes a split of the song into labelled sections and lets you
        correct it. You see the full-mix spectrogram with the vocal-activity envelope and aligned
        lyrics drawn over it, plus coloured bands marking each proposed segment.
      </p>

      <h3>How the structure is proposed</h3>
      <p>The app combines several signals, in order of trust:</p>
      <ul>
        <li>
          <strong>Lyrics alignment</strong> — when you supplied lyrics, Whisper transcribes the
          vocals and the words are matched to your lyric lines, so cuts land at the instrumental
          gaps between sung lines and repeated choruses are recognised.
        </li>
        <li>
          <strong>Vocal activity</strong> — the loudness of the vocals stem over time; used to find
          where singing starts and stops when there are no lyrics.
        </li>
        <li>
          <strong>Timbre clustering</strong> — groups the song into sections that <em>sound</em>{" "}
          alike, even in purely instrumental passages.
        </li>
        <li>
          <strong>Beat grid + LLM labelling</strong> — the app builds a per-bar table of energy,
          per-stem levels and lyrics and asks a local language model to name each section. If the
          model isn't available, it falls back to a built-in heuristic — the result is still
          sensible.
        </li>
      </ul>
      <p>Sections are labelled with the usual song-structure terms:</p>
      <p>
        <span className="pill">intro</span> <span className="pill">verse</span>{" "}
        <span className="pill">pre-chorus</span> <span className="pill">chorus</span>{" "}
        <span className="pill">bridge</span> <span className="pill">drop</span>{" "}
        <span className="pill">build</span> <span className="pill">break</span>{" "}
        <span className="pill">outro</span>
      </p>

      <h3>Editing the split</h3>
      <ul>
        <li>
          <strong>Play / seek</strong> — press play or click anywhere on the timeline to move the
          playhead.
        </li>
        <li>
          <strong>Add a cut</strong> — click <strong>✂ split at playhead</strong>, or double-click
          the timeline, to split a segment in two.
        </li>
        <li>
          <strong>Move a boundary</strong> — drag the handle between two segments to slide where one
          ends and the next begins.
        </li>
        <li>
          <strong>Relabel</strong> — pick a different label from the dropdown on any segment row.
        </li>
        <li>
          <strong>Merge</strong> — merge a segment into the one before it to remove a boundary.
        </li>
        <li>
          <strong>Play a segment</strong> — the play button on a segment row starts playback from
          that segment's start.
        </li>
      </ul>
      <p>
        When the structure looks right, press <strong>✓ validate split</strong> to open the Studio.
        You can always come back to Review later.
      </p>
    </section>
  );
}
