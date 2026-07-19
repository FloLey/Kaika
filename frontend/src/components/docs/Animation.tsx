// The `animation` section of the in-app user guide. Split out of a single 1557-line
// Docs.tsx (cleanup step 13) — pure static JSX, no props, no shared state.
// The anchor id is load-bearing: every "?" in the UI deep-links to /?doc=animation,
// and paramHelp.test.tsx asserts the rendered ids match DOC_SECTION_IDS exactly.
import Cards from "./animation/Cards";
import Modulators from "./animation/Modulators";
import Points from "./animation/Points";
import Sources from "./animation/Sources";
import Generators from "./animation/Generators";
import Fx from "./animation/Fx";
import Rendering from "./animation/Rendering";

export default function Animation() {
  return (
    <section id="animation">
      <h2>
        <span className="num">6</span>Create animation — the node graph
      </h2>
      <p>
        The Studio has two tabs, switched by the bar at the bottom of the workspace:{" "}
        <strong>extract signals by track</strong> (everything above) and{" "}
        <strong>create animation</strong>. The animation tab is a drag-and-drop
        <strong> playground</strong> where you wire a segment's signals into a fluid simulation to
        produce a looping video that reacts to the music. Each segment has its own graph, and it
        autosaves like everything else.
      </p>

      <Cards />
      <Modulators />
      <Points />
      <Sources />
      <Generators />
      <Fx />
      <Rendering />
    </section>
  );
}
