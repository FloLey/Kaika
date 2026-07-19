// Part of the guide's `animation` section (cleanup step 13 split an 842-line file).
// A fragment, not a <section>: the h3 anchor ids inside are deep-link targets that
// paramHelp.test.tsx checks against DOC_SECTION_IDS, so they must render unchanged.
export default function Points() {
  return (
    <>
      <h3 id="animation-points">Placing sources — the points card</h3>
      <p>
        By default a fluid emits from a single source in the centre. The
        <strong>points</strong> card lets you place sources wherever you like: drop a{" "}
        <strong>+ Points</strong> card, <strong>click</strong> its canvas to add a point,{" "}
        <strong>drag</strong> a dot to move it, <strong>double-click</strong>a dot to remove it.
        Then wire the card's output into a fluid's
        <strong> positions</strong> input (the dot on the fluid's left edge). The fluid now emits{" "}
        <strong>one source at every point</strong> — all sharing the fluid's colour, force, emit,
        etc. (and any signal modulation), just at different places. The card shows the project's
        aspect ratio so points land where you draw them.
      </p>
      <p>
        You don't have to place points by hand. Two more cards generate and transform a points set
        (wire them into a fluid's <strong>positions</strong> just like the points card):
      </p>
      <ul>
        <li>
          <strong>Pattern</strong> — a parametric layout (
          <em>circle, ring, grid, line, spiral, scatter</em>) with a count, radius and rotation.{" "}
          <em>offset x/y</em> shift the whole layout off-centre, so a figure needn't sit in the
          middle. The card previews the dots it makes.
        </li>
        <li>
          <strong>Animate points</strong> — takes a points set and moves it over the clip:{" "}
          <em>orbit</em> circles each source around the centre; <em>drift</em> slides them along a
          heading and loops back; <em>chase</em> keeps them put and runs a lit snake around the set.
        </li>
        <li>
          <strong>Merge points</strong> — concatenates two or more points sets into one. Wire a
          Pattern/Points/Animate card into each input (<strong>+ input</strong> for more) and its
          output into a fluid's <strong>positions</strong> — e.g. two offset Pattern rings combined
          into a single emitter set.
        </li>
      </ul>
      <div className="note">
        Chain them — e.g. <em>pattern → animate → fluid positions</em>, or{" "}
        <em>pattern + pattern → merge → fluid positions</em> — for richer source sets. A points
        pipeline is capped at 64 sources.
      </div>
    </>
  );
}
