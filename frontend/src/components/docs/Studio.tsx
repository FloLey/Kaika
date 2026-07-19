// The `studio` section of the in-app user guide. Split out of a single 1557-line
// Docs.tsx (cleanup step 13) — pure static JSX, no props, no shared state.
// The anchor id is load-bearing: every "?" in the UI deep-links to /?doc=studio,
// and paramHelp.test.tsx asserts the rendered ids match DOC_SECTION_IDS exactly.
export default function Studio() {
  return (
    <section id="studio">
      <h2>
        <span className="num">5</span>Studio — extracting signals
      </h2>
      <p>
        The Studio is where the real work happens. The idea: for any segment, pick a stem, isolate a{" "}
        <strong>frequency band</strong> inside it, and turn its movement into a clean{" "}
        <strong>0–1 curve</strong> — a “signal” you can shape precisely. One song can carry many
        signals (a low-end thump from the bass, a vocal shimmer, a hi-hat tick…), each scoped to a
        single segment.
      </p>

      <h3>Layout</h3>
      <ul>
        <li>
          <strong>Segment rail</strong> (left) — every segment as a clickable chip with its time
          range and duration. Pick one to edit it; the rail can be collapsed to widen the workspace.
        </li>
        <li>
          <strong>Signal cards</strong> (main area) — grouped per stem. Each card is one signal: its
          spectrogram band selector, the extracted curve, a live pulse pad, and the shaping
          controls.
        </li>
      </ul>

      <h3>Choosing the band</h3>
      <p>
        Each card shows that stem's spectrogram for the current segment. Drag the two horizontal
        handles to set the low and high edge of the band you care about. The curve underneath
        updates live as you drag. (For the
        <em>beat phase</em> and <em>bar phase</em> features the band is ignored.)
      </p>

      <h3 id="studio-features">Feature — what the signal measures</h3>
      <p>
        The <strong>feature</strong> dropdown decides <em>what</em> about the band becomes the
        curve:
      </p>
      <table>
        <tbody>
          <tr>
            <th>Feature</th>
            <th>What it tracks</th>
          </tr>
          <tr>
            <td>energy</td>
            <td>Loudness of the band over time — the default driver.</td>
          </tr>
          <tr>
            <td>onset</td>
            <td>
              A spike on each hit in the band (add a tail with <em>release</em>). Great for discrete
              events.
            </td>
          </tr>
          <tr>
            <td>flux</td>
            <td>How fast the band is changing — its “busy-ness”.</td>
          </tr>
          <tr>
            <td>brightness</td>
            <td>Where the energy sits in the band (low = dull, high = bright).</td>
          </tr>
          <tr>
            <td>harmonic</td>
            <td>Tonal / sustained share vs percussive / noisy content.</td>
          </tr>
          <tr>
            <td>chroma</td>
            <td>Dominant pitch class in the band (stepped) — handy for driving colour.</td>
          </tr>
          <tr>
            <td>beat phase</td>
            <td>A 0→1 ramp locked to each beat (sawtooth). The band is ignored.</td>
          </tr>
          <tr>
            <td>bar phase</td>
            <td>A 0→1 ramp locked to each 4-beat bar. The band is ignored.</td>
          </tr>
        </tbody>
      </table>

      <h3 id="studio-shaping">Shaping the curve</h3>
      <p>
        Once the feature is chosen, these controls sculpt the raw signal into exactly the motion you
        want:
      </p>
      <table>
        <tbody>
          <tr>
            <th>Control</th>
            <th>Effect</th>
          </tr>
          <tr>
            <td>attack</td>
            <td>
              How fast the curve <em>rises</em> when the sound gets louder. Low = snaps up
              instantly; high = a gentle swell.
            </td>
          </tr>
          <tr>
            <td>release</td>
            <td>
              How fast the curve <em>falls</em> when the sound quietens. Low = drops instantly; high
              = a long smooth tail.
            </td>
          </tr>
          <tr>
            <td>gamma</td>
            <td>
              Contrast. Above 1 emphasises peaks (only the loud moments register); below 1 lifts the
              quiet detail.
            </td>
          </tr>
          <tr>
            <td>thresh</td>
            <td>
              Gate: ignore everything below this level so the signal reacts only to strong hits, not
              background.
            </td>
          </tr>
          <tr>
            <td>gain</td>
            <td>Scales the whole curve up or down (multiplies the value).</td>
          </tr>
          <tr>
            <td>offset</td>
            <td>
              Shifts the whole curve up or down (adds a constant) — e.g. so it never quite reaches
              zero.
            </td>
          </tr>
          <tr>
            <td>invert</td>
            <td>
              Flips it: loud → low instead of loud → high. Invert + slow attack + fast release gives
              the classic sidechain pump (drops on the kick, swells between).
            </td>
          </tr>
        </tbody>
      </table>

      <h3>Hearing &amp; seeing it</h3>
      <ul>
        <li>
          <strong>Curve view</strong> — the shaped 0–1 signal drawn over the segment, with a
          playhead. Click it to seek.
        </li>
        <li>
          <strong>Pulse pad</strong> — a live square whose dot scales and glows with the curve's
          value at the playhead, so you can <em>feel</em> the motion.
        </li>
        <li>
          <strong>Play one signal</strong> — the play button on a card auditions just that band;
          playing one pauses the others (solo).
        </li>
        <li>
          <strong>Play the whole segment</strong> — plays the full mix for the segment while every
          pulse pad animates together off the same clock.
        </li>
      </ul>
      <p>
        Add as many signals per stem as you need, remove the ones you don't, and move between
        segments using the rail. Every change autosaves.
      </p>
    </section>
  );
}
