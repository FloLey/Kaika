// The `upload` section of the in-app user guide. Split out of a single 1557-line
// Docs.tsx (cleanup step 13) — pure static JSX, no props, no shared state.
// The anchor id is load-bearing: every "?" in the UI deep-links to /?doc=upload,
// and paramHelp.test.tsx asserts the rendered ids match DOC_SECTION_IDS exactly.
export default function Upload() {
  return (
    <section id="upload">
      <h2>
        <span className="num">3</span>Upload — file, YouTube, lyrics &amp; stems
      </h2>
      <p>
        This is where a track enters the studio. You provide one source of audio, plus optional
        lyrics.
      </p>

      <h3>Audio source</h3>
      <ul>
        <li>
          <strong>Drop a file</strong> — drag an audio file onto the drop zone, or click to pick one
          (mp3, wav, flac, m4a, ogg…).
        </li>
        <li>
          <strong>YouTube URL</strong> — paste a link and the app downloads the audio. The video
          title becomes the project name. An optional <strong>clip range</strong> (start → end, as{" "}
          <code>SS</code>, <code>MM:SS</code> or <code>HH:MM:SS</code>) appears under the URL: only
          that section of the stream is downloaded — 20&nbsp;seconds of a 2-hour video fetches
          ~20&nbsp;seconds, not 2&nbsp;hours. Either bound can be left empty.
        </li>
      </ul>

      <h3>Lyrics (optional, but recommended)</h3>
      <p>
        Paste lyrics into the text box or upload a <code>.txt</code> or
        <code>.lrc</code> file. Lyrics dramatically improve the segment structure: the app aligns
        the words to the actual singing (using Whisper) so it can tell a repeated <em>chorus</em>{" "}
        from a unique <em>verse</em> and find the instrumental gaps between them. Plain text is fine
        — section markers like
        <code>[Chorus]</code> and ad-lib asides in parentheses are ignored automatically.
        Timestamped <code>.lrc</code> files are used as-is.
      </p>

      <h3>What happens next</h3>
      <p>
        When you submit, the app runs <strong>Demucs</strong> (on the Apple-Silicon GPU when
        available) to separate the song into stems, and renders a spectrogram for each. This is the
        slow step — expect a wait proportional to the track length. The five stems are:
      </p>
      <table>
        <tbody>
          <tr>
            <th>Stem</th>
            <th>What it is</th>
          </tr>
          <tr>
            <td>original</td>
            <td>The untouched full mix you uploaded.</td>
          </tr>
          <tr>
            <td>vocals</td>
            <td>Isolated lead and backing vocals.</td>
          </tr>
          <tr>
            <td>drums</td>
            <td>The drum kit — kick, snare, hats, cymbals, toms.</td>
          </tr>
          <tr>
            <td>bass</td>
            <td>Bass guitar / synth bass and low end.</td>
          </tr>
          <tr>
            <td>other</td>
            <td>Everything else — keys, guitars, strings, synths, FX.</td>
          </tr>
        </tbody>
      </table>
      <div className="note">
        The very first separation downloads the Demucs model weights (~80&nbsp;MB) and the first
        lyric alignment downloads a Whisper model. These one-time downloads happen automatically;
        later runs are faster.
      </div>
    </section>
  );
}
