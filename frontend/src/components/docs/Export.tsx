// The `export` section of the in-app user guide. Split out of a single 1557-line
// Docs.tsx (cleanup step 13) — pure static JSX, no props, no shared state.
// The anchor id is load-bearing: every "?" in the UI deep-links to /?doc=export,
// and paramHelp.test.tsx asserts the rendered ids match DOC_SECTION_IDS exactly.
export default function Export() {
  return (
    <section id="export">
      <h2>
        <span className="num">7</span>Final export — the whole track in HD
      </h2>
      <p>
        When every segment's animation is ready, render the <strong>whole track</strong> as one
        continuous HD video (with the original audio muxed in). Two steps:
      </p>
      <ul>
        <li>
          <strong>Mark each segment's final output.</strong> On the animation tab, every output card
          carries a <strong>☆ mark final</strong> button — click it (it turns{" "}
          <strong>★ final</strong>) on the output you want exported for that segment. One per
          segment; the export screen shows a checklist of any segment still unmarked —{" "}
          <strong>click a ⚠ row</strong> to jump straight to that segment in the Studio.
        </li>
        <li>
          <strong>Render.</strong> The <strong>Final export ▸</strong> button (top of the Studio)
          opens the export stage. Set the <em>size</em> — its{" "}
          <strong>aspect ratio is locked to your canvas</strong> (the editor's ⚙ output
          orientation), so you only pick the resolution and the export keeps the exact shape you
          built for; editing one side scales the other. Also set <em>fps</em>,{" "}
          <em>detail / grid</em> (simulation cells — higher is sharper and slower), and the{" "}
          <em>audio</em>: the <strong>original</strong> full mix, or <strong>instrumental</strong> —
          the original with the separated vocal subtracted, for covers and karaoke (the studio
          transport follows the same choice, so you build against the track you'll ship). Note the
          instrumental removes everything the separation model classifies as vocal — lead{" "}
          <em>and</em> backing vocals, harmonies, vocal chops. If it takes out too much of your
          track's character, re-upload with <code>DEMUCS_MODEL=htdemucs_ft</code> set (a finer
          separation model, ~4× slower to separate) — it keeps more instrument content out of the
          vocal stem. Then generate: the render streams progressively — a growing preview plays
          while it works — and finishes with a <strong>download</strong> link.
        </li>
      </ul>
      <div className="note">
        <strong>The export is encoded at a higher quality than the editor's previews.</strong> Cards
        and segment previews are re-encoded on every edit and only ever watched at card size, so
        they stay light; the final render is archived and watched full-screen, so it gets a
        noticeably higher bitrate. Expect an export file roughly <strong>twice the size</strong> of
        what the same segment's preview would suggest — that is the quality, not a bug.
      </div>
      <div className="note">
        The export is <strong>not</strong> the segment previews stitched together: the fluid
        simulation runs <strong>continuously across segment boundaries</strong> (each layer's
        velocity and dye carry through the cut; only the wiring rules swap), so transitions are
        seamless. Cards that share a <em>layer</em> number across segments continue into each other;
        a layer absent in a segment keeps drifting and fades. Like the previews, un-dyed pixels are
        black — backdrops are layers.
      </div>
    </section>
  );
}
