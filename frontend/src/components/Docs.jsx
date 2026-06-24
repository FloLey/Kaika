import { useEffect } from "react";

// In-app user guide. Rendered as its own root (see main.jsx) when the URL has
// ?doc=<section>, so every "?" in the app can open it in a new tab scrolled to
// the relevant section. Section ids are referenced by Info badges and the header
// help link — keep them in sync.
export default function Docs({ section }) {
  useEffect(() => {
    const id = section || (window.location.hash || "").replace(/^#/, "");
    if (!id) return;
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ block: "start" });
  }, [section]);

  return (
    <div className="docs">
      <header className="docs-head">
        <h1>DEMUCS.STUDIO</h1>
        <span className="sub">user guide</span>
        <a className="back" href="/">← back to the app</a>
      </header>

      <p className="lead">
        Demucs Studio splits a song into musical <strong>segments</strong> (intro,
        verse, chorus…) and lets you rework each one independently. You upload audio
        (or a YouTube link) and optional lyrics; the app separates the stems,
        proposes a structure, and opens a studio where every segment gets its own
        per-stem, per-frequency-band <strong>signal extraction</strong>. Everything
        autosaves, so you can close the tab and resume later.
      </p>

      <nav className="toc">
        <div className="toc-title">Contents</div>
        <ol>
          <li><a href="#getting-started">Getting started</a></li>
          <li><a href="#projects">Projects &amp; resuming</a></li>
          <li><a href="#upload">Upload — file, YouTube, lyrics &amp; stems</a></li>
          <li><a href="#review">Review — the segment structure</a></li>
          <li><a href="#studio">Studio — extracting signals</a></li>
          <li><a href="#fluid-lab">Fluid Lab</a></li>
          <li><a href="#tips">Tips &amp; troubleshooting</a></li>
        </ol>
      </nav>

      <section id="getting-started">
        <h2><span className="num">1</span>Getting started</h2>
        <p>
          Demucs Studio runs locally. Once it's installed (see the project
          <code>README.md</code>), one command starts everything: <code>make dev</code>.
          That launches Postgres, the Flask API on <code>:5000</code>, and the web
          UI on <code>:5173</code>. Open <code>http://localhost:5173</code> and you'll
          land on the <strong>Projects</strong> screen.
        </p>
        <p>The workflow has three stages, always in this order:</p>
        <ul>
          <li><span className="stage">1</span><strong>Upload</strong> — bring in audio + optional lyrics; the app separates stems.</li>
          <li><span className="stage">2</span><strong>Review</strong> — check and edit the proposed segment structure.</li>
          <li><span className="stage">3</span><strong>Studio</strong> — extract and shape a signal from each stem, per segment.</li>
        </ul>
        <div className="note">
          The <strong>?</strong> in the app's top-right corner opens this guide at
          the section for whatever screen you're on. The smaller <span className="pill">?</span>
          badges next to individual controls show a one-line explanation on hover,
          and clicking one jumps straight to the matching part of this guide.
        </div>
      </section>

      <section id="projects">
        <h2><span className="num">2</span>Projects &amp; resuming</h2>
        <p>
          The Projects screen lists every track you've worked on, most recent first.
          Each row shows the title, source, and how far you got (Review or Studio).
        </p>
        <ul>
          <li><strong>+ new track</strong> — start a fresh upload.</li>
          <li><strong>Open a project</strong> — click a row to jump back to where you left off; your segments and per-segment edits load exactly as you saved them.</li>
          <li><strong>Delete</strong> — removes the project <em>and</em> its audio, stems, and spectrograms from disk. This can't be undone.</li>
          <li><strong>🌀 fluid lab</strong> — opens the standalone <a href="#fluid-lab">Fluid Lab</a> playground.</li>
        </ul>
        <p>Work is saved automatically as you go, so there is no “save” button — just leave when you're done.</p>
      </section>

      <section id="upload">
        <h2><span className="num">3</span>Upload — file, YouTube, lyrics &amp; stems</h2>
        <p>This is where a track enters the studio. You provide one source of audio, plus optional lyrics.</p>

        <h3>Audio source</h3>
        <ul>
          <li><strong>Drop a file</strong> — drag an audio file onto the drop zone, or click to pick one (mp3, wav, flac, m4a, ogg…).</li>
          <li><strong>YouTube URL</strong> — paste a link and the app downloads the audio. The video title becomes the project name.</li>
        </ul>

        <h3>Lyrics (optional, but recommended)</h3>
        <p>
          Paste lyrics into the text box or upload a <code>.txt</code> or
          <code>.lrc</code> file. Lyrics dramatically improve the segment structure:
          the app aligns the words to the actual singing (using Whisper) so it can
          tell a repeated <em>chorus</em> from a unique <em>verse</em> and find the
          instrumental gaps between them. Plain text is fine — section markers like
          <code>[Chorus]</code> and ad-lib asides in parentheses are ignored
          automatically. Timestamped <code>.lrc</code> files are used as-is.
        </p>

        <h3>What happens next</h3>
        <p>
          When you submit, the app runs <strong>Demucs</strong> (on the
          Apple-Silicon GPU when available) to separate the song into stems, and
          renders a spectrogram for each. This is the slow step — expect a wait
          proportional to the track length. The five stems are:
        </p>
        <table>
          <tbody>
            <tr><th>Stem</th><th>What it is</th></tr>
            <tr><td>original</td><td>The untouched full mix you uploaded.</td></tr>
            <tr><td>vocals</td><td>Isolated lead and backing vocals.</td></tr>
            <tr><td>drums</td><td>The drum kit — kick, snare, hats, cymbals, toms.</td></tr>
            <tr><td>bass</td><td>Bass guitar / synth bass and low end.</td></tr>
            <tr><td>other</td><td>Everything else — keys, guitars, strings, synths, FX.</td></tr>
          </tbody>
        </table>
        <div className="note">
          The very first separation downloads the Demucs model weights (~80&nbsp;MB)
          and the first lyric alignment downloads a Whisper model. These one-time
          downloads happen automatically; later runs are faster.
        </div>
      </section>

      <section id="review">
        <h2><span className="num">4</span>Review — the segment structure</h2>
        <p>
          Before the studio, the app proposes a split of the song into labelled
          sections and lets you correct it. You see the full-mix spectrogram with
          the vocal-activity envelope and aligned lyrics drawn over it, plus
          coloured bands marking each proposed segment.
        </p>

        <h3>How the structure is proposed</h3>
        <p>The app combines several signals, in order of trust:</p>
        <ul>
          <li><strong>Lyrics alignment</strong> — when you supplied lyrics, Whisper transcribes the vocals and the words are matched to your lyric lines, so cuts land at the instrumental gaps between sung lines and repeated choruses are recognised.</li>
          <li><strong>Vocal activity</strong> — the loudness of the vocals stem over time; used to find where singing starts and stops when there are no lyrics.</li>
          <li><strong>Timbre clustering</strong> — groups the song into sections that <em>sound</em> alike, even in purely instrumental passages.</li>
          <li><strong>Beat grid + LLM labelling</strong> — the app builds a per-bar table of energy, per-stem levels and lyrics and asks a local language model to name each section. If the model isn't available, it falls back to a built-in heuristic — the result is still sensible.</li>
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
          <li><strong>Play / seek</strong> — press play or click anywhere on the timeline to move the playhead.</li>
          <li><strong>Add a cut</strong> — click <strong>✂ split at playhead</strong>, or double-click the timeline, to split a segment in two.</li>
          <li><strong>Move a boundary</strong> — drag the handle between two segments to slide where one ends and the next begins.</li>
          <li><strong>Relabel</strong> — pick a different label from the dropdown on any segment row.</li>
          <li><strong>Merge</strong> — merge a segment into the one before it to remove a boundary.</li>
          <li><strong>Play a segment</strong> — the play button on a segment row starts playback from that segment's start.</li>
        </ul>
        <p>
          When the structure looks right, press <strong>✓ validate split</strong> to
          open the Studio. You can always come back to Review later.
        </p>
      </section>

      <section id="studio">
        <h2><span className="num">5</span>Studio — extracting signals</h2>
        <p>
          The Studio is where the real work happens. The idea: for any segment, pick
          a stem, isolate a <strong>frequency band</strong> inside it, and turn its
          movement into a clean <strong>0–1 curve</strong> — a “signal” you can
          shape precisely. One song can carry many signals (a low-end thump from the
          bass, a vocal shimmer, a hi-hat tick…), each scoped to a single segment.
        </p>

        <h3>Layout</h3>
        <ul>
          <li><strong>Segment rail</strong> (left) — every segment as a clickable chip with its time range and duration. Pick one to edit it; the rail can be collapsed to widen the workspace.</li>
          <li><strong>Signal cards</strong> (main area) — grouped per stem. Each card is one signal: its spectrogram band selector, the extracted curve, a live pulse pad, and the shaping controls.</li>
        </ul>

        <h3>Choosing the band</h3>
        <p>
          Each card shows that stem's spectrogram for the current segment. Drag the
          two horizontal handles to set the low and high edge of the band you care
          about. The curve underneath updates live as you drag. (For the
          <em>beat phase</em> and <em>bar phase</em> features the band is ignored.)
        </p>

        <h3 id="studio-features">Feature — what the signal measures</h3>
        <p>The <strong>feature</strong> dropdown decides <em>what</em> about the band becomes the curve:</p>
        <table>
          <tbody>
            <tr><th>Feature</th><th>What it tracks</th></tr>
            <tr><td>energy</td><td>Loudness of the band over time — the default driver.</td></tr>
            <tr><td>onset</td><td>A spike on each hit in the band (add a tail with <em>release</em>). Great for discrete events.</td></tr>
            <tr><td>flux</td><td>How fast the band is changing — its “busy-ness”.</td></tr>
            <tr><td>brightness</td><td>Where the energy sits in the band (low = dull, high = bright).</td></tr>
            <tr><td>harmonic</td><td>Tonal / sustained share vs percussive / noisy content.</td></tr>
            <tr><td>chroma</td><td>Dominant pitch class in the band (stepped) — handy for driving colour.</td></tr>
            <tr><td>beat phase</td><td>A 0→1 ramp locked to each beat (sawtooth). The band is ignored.</td></tr>
            <tr><td>bar phase</td><td>A 0→1 ramp locked to each 4-beat bar. The band is ignored.</td></tr>
          </tbody>
        </table>

        <h3 id="studio-shaping">Shaping the curve</h3>
        <p>Once the feature is chosen, these controls sculpt the raw signal into exactly the motion you want:</p>
        <table>
          <tbody>
            <tr><th>Control</th><th>Effect</th></tr>
            <tr><td>attack</td><td>How fast the curve <em>rises</em> when the sound gets louder. Low = snaps up instantly; high = a gentle swell.</td></tr>
            <tr><td>release</td><td>How fast the curve <em>falls</em> when the sound quietens. Low = drops instantly; high = a long smooth tail.</td></tr>
            <tr><td>gamma</td><td>Contrast. Above 1 emphasises peaks (only the loud moments register); below 1 lifts the quiet detail.</td></tr>
            <tr><td>thresh</td><td>Gate: ignore everything below this level so the signal reacts only to strong hits, not background.</td></tr>
            <tr><td>gain</td><td>Scales the whole curve up or down (multiplies the value).</td></tr>
            <tr><td>offset</td><td>Shifts the whole curve up or down (adds a constant) — e.g. so it never quite reaches zero.</td></tr>
            <tr><td>invert</td><td>Flips it: loud → low instead of loud → high. Invert + slow attack + fast release gives the classic sidechain pump (drops on the kick, swells between).</td></tr>
          </tbody>
        </table>

        <h3>Hearing &amp; seeing it</h3>
        <ul>
          <li><strong>Curve view</strong> — the shaped 0–1 signal drawn over the segment, with a playhead. Click it to seek.</li>
          <li><strong>Pulse pad</strong> — a live square whose dot scales and glows with the curve's value at the playhead, so you can <em>feel</em> the motion.</li>
          <li><strong>Play one signal</strong> — the play button on a card auditions just that band; playing one pauses the others (solo).</li>
          <li><strong>Play the whole segment</strong> — plays the full mix for the segment while every pulse pad animates together off the same clock.</li>
        </ul>
        <p>Add as many signals per stem as you need, remove the ones you don't, and move between segments using the rail. Every change autosaves.</p>
      </section>

      <section id="fluid-lab">
        <h2><span className="num">6</span>Fluid Lab</h2>
        <p>
          The Fluid Lab is a standalone visual playground (reach it from the Projects
          screen). It runs a small real-time fluid simulation: a central source
          injects coloured dye and pushes the fluid around, and the result is
          rendered to a short looping video — a sandbox for visuals the extracted
          signals can eventually drive.
        </p>

        <h3 id="fluid-source">The source — the dye emitter</h3>
        <table>
          <tbody>
            <tr><th>Control</th><th>Effect</th></tr>
            <tr><td>colour (R/G/B)</td><td>The dye colour the source releases.</td></tr>
            <tr><td>intensity</td><td>Brightness of the dye (an HDR multiplier — higher glows harder).</td></tr>
            <tr><td>opacity</td><td>How strongly the dye shows over the background (lower = fainter).</td></tr>
            <tr><td>emit</td><td>How much dye the source releases each frame.</td></tr>
            <tr><td>radius</td><td>Size of the source splat (as a fraction of the canvas).</td></tr>
            <tr><td>force</td><td>Strength of the jet the source pushes into the fluid.</td></tr>
            <tr><td>angle</td><td>Direction the jet pushes (0° = right, 90° = down, 270° = up). Ignored when <em>radial</em> is on.</td></tr>
            <tr><td>radial</td><td>Push outward in all directions from the centre instead of one heading.</td></tr>
            <tr><td>rotation</td><td>Spin the jet direction over time (speed and acceleration).</td></tr>
          </tbody>
        </table>

        <h3 id="fluid-path">The path — moving the source</h3>
        <p>
          The source can travel along a path instead of staying put. Click the stage
          to add points, drag markers to move them, and double-click a marker to
          remove it.
        </p>
        <table>
          <tbody>
            <tr><th>Control</th><th>Effect</th></tr>
            <tr><td>path speed</td><td>How many full trips along the points the source makes over the clip (0 = stay on the first point).</td></tr>
            <tr><td>closed</td><td>Link the last point back to the first so it loops round and round.</td></tr>
            <tr><td>ping-pong</td><td>Travel back and forth along the points instead of looping (ignored when closed).</td></tr>
          </tbody>
        </table>

        <h3 id="fluid-medium">The medium — how the fluid behaves</h3>
        <table>
          <tbody>
            <tr><th>Control</th><th>Effect</th></tr>
            <tr><td>dissipation</td><td>How fast the dye fades (lower = fades faster).</td></tr>
            <tr><td>velocity dissipation</td><td>How fast the flow loses momentum (lower = calms faster).</td></tr>
            <tr><td>viscosity</td><td>Thickness — smooths the velocity field (higher = gooier).</td></tr>
            <tr><td>vorticity</td><td>Swirl — re-energises little vortices (higher = more curl).</td></tr>
          </tbody>
        </table>
        <p>
          Set the clip length, render, and you get a seamless looping video.
          Identical settings are cached, so re-rendering the same look is instant.
        </p>
      </section>

      <section id="tips">
        <h2><span className="num">7</span>Tips &amp; troubleshooting</h2>
        <ul>
          <li><strong>First run is slow.</strong> The first separation downloads the Demucs weights and the first lyric alignment downloads a Whisper model. After that, models are cached and only the audio processing takes time.</li>
          <li><strong>Lyrics give the best structure.</strong> If the proposed segments look off, the single biggest improvement is adding lyrics on upload — even rough plain text.</li>
          <li><strong>No language model? No problem.</strong> Section labelling prefers a local LLM (Ollama), but if it isn't running the app falls back to a heuristic and still proposes a full structure. You can always relabel by hand in Review.</li>
          <li><strong>GPU.</strong> On Apple Silicon, separation uses the Metal (MPS) GPU automatically; elsewhere it runs on CPU (slower but identical results).</li>
          <li><strong>Nothing is lost.</strong> Edits autosave continuously. Close the tab whenever you like and reopen the project from the Projects screen to pick up where you stopped.</li>
          <li><strong>Deleting is permanent.</strong> Deleting a project also removes its audio, stems and spectrograms from disk — there's no undo.</li>
        </ul>
      </section>

      <footer className="docs-foot">
        Demucs Studio — local stem separation, LLM-assisted segmentation, and
        per-segment signal extraction. <a href="/">← back to the app</a>
      </footer>
    </div>
  );
}
