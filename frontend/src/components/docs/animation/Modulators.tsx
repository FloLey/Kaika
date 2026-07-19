// Part of the guide's `animation` section (cleanup step 13 split an 842-line file).
// A fragment, not a <section>: the h3 anchor ids inside are deep-link targets that
// paramHelp.test.tsx checks against DOC_SECTION_IDS, so they must render unchanged.
export default function Modulators() {
  return (
    <>
      <h3 id="animation-modulators">Shaping &amp; generating signals — modulator cards</h3>
      <p>
        A <em>signal</em> card is the only source of a 0–1 curve, but the <strong>modulator</strong>{" "}
        cards let you build new curves from it (or from nothing) right in the graph — so you don't
        have to bake every choice into the studio. They all output a value you wire into a fluid
        port (or into another modulator).
      </p>
      <ul>
        <li>
          <strong>Math</strong> — combines two or more signals: <em>multiply</em> to gate one by
          another (e.g. vocals × the beat), <em>max</em> to floor a curve under an LFO,{" "}
          <em>add/subtract</em>, or <em>mix</em> to crossfade. Use <strong>+ input</strong> for
          more.
        </li>
        <li>
          <strong>LFO</strong> — a sine / triangle / saw / square oscillator that needs no audio:
          steady drift or pulsing. Set its rate in <em>cycles per clip</em> or <em>Hz</em>, plus a
          phase offset.
        </li>
        <li>
          <strong>Noise</strong> — smooth, organic random wander where an LFO would feel mechanical.
          It's <strong>seeded</strong>, so a given seed always renders the same.
        </li>
        <li>
          <strong>Shaper</strong> — re-curves one signal (attack/release, threshold, gamma,
          gain/offset, invert, and an output [lo, hi] remap) <em>per use</em>, so you can reuse a
          single studio signal sharply on one port and softly on another. The little graph on the
          card previews the shape. <em>Delay</em> slides the signal later in time (in ms): the
          exposed head is silent by default, or tick <em>wrap</em> to loop the tail back to the
          start. To build a <strong>heartbeat</strong>, fan one beat signal out — feed it straight
          into a <em>math</em> card set to <em>add</em>, and also through a shaper with a short{" "}
          <em>delay</em> and a lower <em>gain</em> into the same math card — the delayed, weaker
          copy lands just after each beat as the second thump.
        </li>
        <li>
          <strong>Gate</strong> — turns any signal into a clean <strong>0/1 switch</strong>: 1 while
          the input is above the <em>threshold</em>, 0 below it. The <em>hysteresis</em> band
          (centred on the threshold) keeps a hovering signal from flickering — the gate only
          releases once the input falls below the band. Two <strong>thinners</strong> cut down how
          often it spikes: <em>min gap</em> drops any spike that lands within N seconds of the last
          kept one (caps the rate by time), and <em>divide</em> keeps only every Nth spike (1/N — a
          divider off the input's own rate); combine them to, say, advance a slideshow at most once
          a second and only on every other beat. Use the gate to drive on/off-style ports: an image
          generator's <em>trigger</em>, a fluid's <em>emit</em>, a lyrics <em>opacity</em>.{" "}
          <em>invert</em> flips it.
        </li>
        <li>
          <strong>Change</strong> — measures how fast its input is <strong>moving</strong>: the
          output is the signal's rate of change (per second), smoothed with a fast <em>attack</em>{" "}
          and a slow <em>release</em> so a burst of movement becomes one clean bump. Where the gate
          asks «is the signal high?», change asks «is it <em>changing</em>?» — wire{" "}
          <em>signal → change → gate → montage trigger</em> and the{" "}
          <a href="#animation-montage">montage</a> cuts on musical transitions (verse→chorus, drops;
          on a <em>chroma</em> signal, chord changes) instead of on level. <em>direction</em> picks
          any movement, rises only, or falls only; <em>gain</em> scales the sensitivity. (For raw
          audio busy-ness, the <em>flux</em> and <em>onset</em> signal features measure spectral
          change directly — change generalises the idea to any curve in the graph.)
        </li>
        <li>
          <strong>Scope</strong> — a monitor: wire any value into it (an lfo, signal, noise, math…)
          and it shows that value on a live sparkline + pulse pad, exactly like the signal card. It{" "}
          <em>passes the value straight through</em>, so you can splice it inline (
          <em>lfo → scope → fluid</em>) or just hang it off a value to confirm it's moving.
        </li>
      </ul>
    </>
  );
}
