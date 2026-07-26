// The app's location, as data.
//
// Today there is no router at all: the screen is a `useState` string, so browser
// back does nothing, nothing is linkable, and going to the export stage to check one
// number loses which segment you were on. `window.location` appears in exactly two
// files and neither is the app.
//
// This is ~70 lines rather than a dependency because the whole route space is one
// enum plus at most three ids, and the project ships with exactly two runtime deps
// (react, react-dom) — a router would be the third and by far the largest.
//
// The hash, not the path: no dev-server rewrite rules, and `?doc=` and `?ui=next`
// keep working untouched in the query string beside it.

export type Route =
  | { name: "projects" }
  | { name: "upload" }
  | { name: "review"; job: string }
  // `tab` is the studio's own two-tab split.
  //
  // NOT here yet: the breadcrumb descent into a child composition. It belongs in
  // this grammar — "back out of the montage I opened" is the clearest case for
  // history in the app — but it lives in Studio's nav stack, and a route field that
  // parses into nothing is worse than one that isn't there. It lands with the
  // Studio work, not before.
  | { name: "studio"; job: string; seg?: string; tab?: "signals" | "graph" }
  | { name: "export"; job: string };

export const HOME: Route = { name: "projects" };

// The always-present card demo, whose job id is fixed by the backend that seeds it
// (`backend/seed_card_demo.py`'s `JOB_ID`). It was compared against as a bare string in
// two places in Studio; the shell needs the same fact to build a route, and three
// copies of a literal that must match a Python constant is one too many.
export const PLAYGROUND_JOB = "playground";

// Which studio tab a project opens on. The Playground is ABOUT the cards, so it lands
// on the graph; a normal project opens on signals, because the flow is extract first,
// then animate.
//
// This lives here rather than in Studio because the URL is what chooses the tab now:
// Studio receives the answer, it no longer decides it. Leaving the rule in the
// component meant the shell hardcoded "signals" at every navigation and the Playground
// opened on an empty signals tab — a regression that nothing failed on, because the
// component that still knew the rule was no longer the component being asked.
export const defaultTab = (job: string): "signals" | "graph" =>
  job === PLAYGROUND_JOB ? "graph" : "signals";

// "#/p/j1/studio/s3/graph/c/comp-7" → the route above. Anything unrecognised falls
// back to projects rather than throwing: a hand-edited URL should land somewhere
// usable, not on a blank screen.
export function parseRoute(hash: string): Route {
  const parts = (hash || "").replace(/^#\/?/, "").split("/").filter(Boolean);
  if (!parts.length) return HOME;
  if (parts[0] === "upload") return { name: "upload" };
  if (parts[0] !== "p" || !parts[1]) return HOME;
  const job = decodeURIComponent(parts[1]);
  const stage = parts[2];
  if (stage === "review") return { name: "review", job };
  if (stage === "export") return { name: "export", job };
  if (stage === "studio") {
    const seg = parts[3] ? decodeURIComponent(parts[3]) : undefined;
    // …/studio/<seg>, …/studio/<seg>/graph and …/studio/<seg>/signals.
    //
    // A URL that names no tab means "this project's default tab" — NOT literally
    // signals. Hardcoding signals here is what made the Playground open on an empty
    // signals tab even after every `navigate()` call was fixed: the shell's reconcile
    // bails when the URL already names the right stage, and by then a bare
    // `#/p/playground/studio` had already been read as signals.
    const tab =
      parts[4] === "graph"
        ? ("graph" as const)
        : parts[4] === "signals"
          ? ("signals" as const)
          : defaultTab(job);
    return { name: "studio", job, seg, tab };
  }
  return HOME;
}

export function formatRoute(r: Route): string {
  const enc = encodeURIComponent;
  switch (r.name) {
    case "projects":
      return "#/";
    case "upload":
      return "#/upload";
    case "review":
      return `#/p/${enc(r.job)}/review`;
    case "export":
      return `#/p/${enc(r.job)}/export`;
    case "studio": {
      let out = `#/p/${enc(r.job)}/studio`;
      if (r.seg) out += `/${enc(r.seg)}`;
      // Whichever tab is NOT this project's default is named; the default stays
      // implicit, so the common link is the short one. Written against `defaultTab`
      // rather than against the literal "graph" so that it round-trips for the
      // Playground too — otherwise the Playground switched to signals would format to
      // a URL that reads back as graph.
      if (r.seg && r.tab && r.tab !== defaultTab(r.job)) out += `/${r.tab}`;
      return out;
    }
  }
}

// Navigate. `replace` for corrections the user did not ask for — landing on a
// project's saved step, say — so Back still goes where they came from.
export function navigate(r: Route, opts: { replace?: boolean } = {}): void {
  const url = formatRoute(r);
  if (url === window.location.hash) return;
  if (opts.replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
  // pushState/replaceState fire no event; the store below listens for this one.
  window.dispatchEvent(new Event("kaika:route"));
}

// --- the store the app subscribes to ----------------------------------------
// `useSyncExternalStore` needs a cached snapshot: returning a fresh object per call
// would re-render forever. Recomputed only when the hash actually changes.
let cachedHash: string | null = null;
let cachedRoute: Route = HOME;

export function currentRoute(): Route {
  const h = typeof window === "undefined" ? "" : window.location.hash;
  if (h !== cachedHash) {
    cachedHash = h;
    cachedRoute = parseRoute(h);
  }
  return cachedRoute;
}

export function subscribeRoute(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  window.addEventListener("popstate", onChange);
  window.addEventListener("kaika:route", onChange);
  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener("popstate", onChange);
    window.removeEventListener("kaika:route", onChange);
  };
}
