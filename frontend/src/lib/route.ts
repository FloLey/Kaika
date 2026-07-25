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
    // …/studio/<seg>  and  …/studio/<seg>/graph
    const tab = parts[4] === "graph" ? ("graph" as const) : ("signals" as const);
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
      // The graph tab is in the URL; `signals` is the default and stays implicit, so
      // the common link is the short one.
      if (r.seg && r.tab === "graph") out += "/graph";
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
