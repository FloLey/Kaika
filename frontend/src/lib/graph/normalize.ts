// normalizeGraph: upgrade a (possibly older) persisted graph to the current
// GRAPH_VERSION. The per-type field coercion is driven by a schema table (one
// row per field: coerce-or-default), with the genuinely special cases — fluid
// ports, combine slots, colour stops, the video `speed` migration — kept as
// explicit branches. Idempotent + returns the same object when nothing changed.

import { FLUID_PARAM_KEYS } from "../fluidParams.js";
import { slideshowKind } from "../imageCount";
import { NODE_PARAMS } from "../nodeParams";
import { FLUID_PARAMS, coercePorts, mkInputId, mkSlotId } from "./core";
import { COLOR_STOPS_DEFAULT, COMBINE_MEDIUM, GRAPH_VERSION, combineSlot } from "./factories";
import type {
  Binding,
  ColorData,
  CombineNode,
  CombineSlot,
  FluidPort,
  Graph,
  GraphNode,
  SlideshowData,
  SlideshowItem,
  VideoData,
} from "../types";

type Point = [number, number];

// Every node type the editor still knows how to create/render. normalizeGraph drops
// any node whose type isn't here (a retired card — v7) so old saves stay valid. Kept
// local (not derived from the registry) to honour the no-import-from-registry rule.
const KNOWN_NODE_TYPES = new Set<string>([
  "signal",
  "fluid",
  "points",
  "combine",
  "montage",
  "output",
  "math",
  "lfo",
  "noise",
  "shaper",
  "gate",
  "change",
  "scope",
  "pattern",
  "animate-points",
  "merge-points",
  "color",
  "lyrics",
  "image",
  "imagegen",
  "slideshow",
  "video",
  "backdrop",
  "waves",
  "lightning",
  "fire",
  "aurora",
  "rain",
  "clouds",
  "transform",
  "stylize",
  "extract",
  "echo",
  "colorgrade",
]);

// ---- field coercers (the schema-table vocabulary) ------------------------------
type Coerce = (v: unknown) => unknown;
const num =
  (def: number): Coerce =>
  (v) =>
    typeof v === "number" ? v : def;
const str =
  (def: string): Coerce =>
  (v) =>
    typeof v === "string" ? v : def;
const orDefault =
  (def: string): Coerce =>
  (v) =>
    v || def; // truthy passes (legacy semantics)
const bool: Coerce = (v) => !!v;
const boolDefaultTrue: Coerce = (v) => v !== false;
const oneOf =
  (values: string[], def: string): Coerce =>
  (v) =>
    values.includes(v as string) ? v : def;
const hexColor =
  (def: string): Coerce =>
  (v) =>
    /^#[0-9a-fA-F]{6}$/.test((v as string) || "") ? v : def;
const intClamp =
  (lo: number, hi: number, def: number): Coerce =>
  (v) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : def;
const idList: Coerce = (v) => (Array.isArray(v) && v.length ? v : [mkInputId(), mkInputId()]);
const strList: Coerce = (v) =>
  Array.isArray(v) ? v.filter((u): u is string => typeof u === "string") : [];
// A slideshow's own items: [{url, kind, start?}]. Drops malformed rows; re-infers a
// missing/invalid `kind` from the URL extension; keeps `start` only when a finite
// number. (Legacy `assetUrls: string[]` is migrated into this shape in the slideshow
// branch below.)
const slideItems: Coerce = (v) =>
  Array.isArray(v)
    ? v
        .filter(
          (it): it is { url: string } => !!it && typeof (it as { url?: unknown }).url === "string"
        )
        .map((it) => {
          const r = it as { url: string; kind?: unknown; start?: unknown };
          const kind = r.kind === "image" || r.kind === "video" ? r.kind : slideshowKind(r.url);
          const item: SlideshowItem = { url: r.url, kind };
          if (kind === "video" && typeof r.start === "number" && Number.isFinite(r.start)) {
            item.start = r.start;
          }
          return item;
        })
    : [];
const portsFor =
  (type: string): Coerce =>
  (v) =>
    coercePorts(type, v as Record<string, FluidPort> | undefined);
// Montage extracts: ordered {id, compositionId, span?, inPoint?} references into the
// composition pool. Keep saved ids (stable identity for the UI/cache); drop rows
// without a composition reference (they render nothing and hash as dangling).
// `span` survives only when a whole number ≥ 2, `inPoint` only when > 0 — the
// defaults stay ABSENT so untouched graphs keep their exact shape (and output hash).
const montageExtracts: Coerce = (v) =>
  Array.isArray(v)
    ? v
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .filter((r) => typeof r.compositionId === "string" && r.compositionId)
        .map((r) => {
          const span =
            typeof r.span === "number" && Number.isFinite(r.span) && Math.round(r.span) >= 2
              ? Math.min(16, Math.round(r.span))
              : undefined;
          const inPoint =
            typeof r.inPoint === "number" && Number.isFinite(r.inPoint) && r.inPoint > 0
              ? r.inPoint
              : undefined;
          return {
            id: typeof r.id === "string" && r.id ? r.id : mkSlotId(),
            compositionId: r.compositionId as string,
            ...(span ? { span } : {}),
            ...(inPoint ? { inPoint } : {}),
          };
        })
    : [];

// Manual breakpoints: {id, t} rows in composition-local seconds, kept sorted so the
// timeline and the hash see one canonical order.
const manualBreakpoints: Coerce = (v) =>
  Array.isArray(v)
    ? v
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .filter((r) => typeof r.t === "number" && Number.isFinite(r.t) && r.t > 0)
        .map((r) => ({
          id: typeof r.id === "string" && r.id ? r.id : mkSlotId(),
          t: r.t as number,
        }))
        .sort((a, b) => a.t - b.t)
    : [];

const numberList: Coerce = (v) =>
  Array.isArray(v)
    ? v
        .filter((x): x is number => typeof x === "number" && Number.isFinite(x))
        .sort((a, b) => a - b)
    : [];

// One row per node type whose data is a flat field bag: field -> coercer. A saved
// field passes through when valid, else the default; unknown saved fields are
// DROPPED (the table defines the exact shape).
const DATA_SCHEMAS: Record<string, Record<string, Coerce>> = {
  math: { op: orDefault("multiply"), inputs: idList, mix: num(0.5) },
  lfo: {
    shape: orDefault("sine"),
    rateMode: orDefault("cycles"),
    rate: num(4),
    phase: num(0),
    duty: num(0.5),
  },
  noise: { rate: num(1), seed: num(1), octaves: num(2) },
  shaper: {
    delay: num(0),
    wrap: bool,
    attack: num(5),
    release: num(250),
    invert: bool,
    threshold: num(0),
    gamma: num(1),
    gain: num(1),
    offset: num(0),
    lo: num(0),
    hi: num(1),
  },
  pattern: {
    layout: orDefault("circle"),
    count: num(6),
    radius: num(0.3),
    rotation: num(0),
    seed: num(1),
    offsetX: num(0),
    offsetY: num(0),
  },
  "animate-points": {
    mode: orDefault("orbit"),
    amount: num(0.15),
    rate: num(1),
    angle: num(0),
    count: num(3),
    fade: num(1),
  },
  "merge-points": { inputs: idList },
  gate: { threshold: num(0.5), hysteresis: num(0.1), minGap: num(0), divide: num(1), invert: bool },
  change: {
    gain: num(1),
    attack: num(5),
    release: num(400),
    direction: oneOf(["both", "rise", "fall"], "both"),
  },
  lyrics: {
    font: str("inter"),
    align: orDefault("center"),
    case: orDefault("none"),
    reveal: orDefault("word"),
    box_x: num(0.05),
    box_y: num(0.08),
    box_w: num(0.9),
    box_h: num(0.84),
    outline: boolDefaultTrue,
    outlineWidth: num(0.12),
    ports: portsFor("lyrics"),
  },
  image: {
    assetUrl: str(""),
    box_x: num(0),
    box_y: num(0),
    box_w: num(1),
    box_h: num(1),
    fit: oneOf(["cover", "contain", "stretch"], "cover"),
    ports: portsFor("image"),
  },
  video: {
    assetUrl: str(""),
    box_x: num(0),
    box_y: num(0),
    box_w: num(1),
    box_h: num(1),
    fit: oneOf(["cover", "contain", "stretch"], "cover"),
    sync: oneOf(["segment"], "song"),
    start: num(0),
    loop: boolDefaultTrue,
    crop_x: num(0),
    crop_y: num(0),
    crop_w: num(1),
    crop_h: num(1),
    ports: portsFor("video"),
  },
  slideshow: {
    items: slideItems,
    box_x: num(0),
    box_y: num(0),
    box_w: num(1),
    box_h: num(1),
    fit: oneOf(["cover", "contain", "stretch"], "cover"),
    threshold: num(0.5),
    hysteresis: num(0.1),
    ports: portsFor("slideshow"),
  },
  montage: {
    extracts: montageExtracts,
    manualBreakpoints,
    disabledCuts: numberList,
    threshold: num(0.5),
    hysteresis: num(0.1),
    ports: portsFor("montage"),
  },
  imagegen: {
    prompts: (v) => (Array.isArray(v) && v.length ? v.filter((x) => typeof x === "string") : [""]),
    seed: num(1),
    assetUrls: strList,
    model: (v) => (typeof v === "string" && v ? v : "stabilityai/sd-turbo"),
    activeCount: (v) => (typeof v === "number" && v >= 0 ? v : undefined),
  },
  backdrop: { color: hexColor("#101418"), ports: portsFor("backdrop") },
  waves: {
    palette: oneOf(["ocean", "tropical", "storm", "sunset"], "ocean"),
    seed: num(1),
    ports: portsFor("waves"),
  },
  lightning: {
    palette: oneOf(["electric", "violet", "white-hot", "ember"], "electric"),
    seed: num(1),
    ports: portsFor("lightning"),
  },
  fire: {
    palette: oneOf(["flame", "blue-fire", "green-fire", "ghost"], "flame"),
    seed: num(1),
    ports: portsFor("fire"),
  },
  // v26: aurora/rain/clouds join the schema table (they previously passed
  // through UNcoerced — stale data/ports survived forever on those types).
  aurora: {
    palette: oneOf(["aurora", "solar", "ice", "spectrum"], "aurora"),
    seed: num(1),
    ports: portsFor("aurora"),
  },
  rain: {
    palette: oneOf(["downpour", "silver", "neon", "monsoon"], "downpour"),
    seed: num(1),
    ports: portsFor("rain"),
  },
  clouds: {
    palette: oneOf(["sky", "nebula", "ink", "dust"], "sky"),
    seed: num(1),
    ports: portsFor("clouds"),
  },
  transform: {
    mode: oneOf(["transform", "mirror", "kaleidoscope"], "transform"),
    segments: intClamp(2, 12, 6),
    wrap: bool,
    ports: portsFor("transform"),
  },
  stylize: {
    model: oneOf(["draft", "hd"], "draft"),
    inpaint: bool,
    prompt: str("flowers, blooming roses and peonies, lush colorful petals, dark background"),
    assetUrl: str(""),
    ports: portsFor("stylize"),
  },
  extract: {
    kind: oneOf(["canny", "soft", "density", "depth"], "canny"),
    ports: portsFor("extract"),
  },
  echo: { mode: oneOf(["ghost", "bright", "dark"], "ghost"), ports: portsFor("echo") },
  colorgrade: {
    mode: oneOf(["thermal", "duotone", "neon"], "thermal"),
    map: oneOf(["turbo", "inferno", "jet", "ocean"], "turbo"),
    colorA: hexColor("#0b1030"),
    colorB: hexColor("#ff5ac8"),
    ports: portsFor("colorgrade"),
  },
};

const coerceBySchema = (schema: Record<string, Coerce>, d: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(schema).map(([k, fn]) => [k, fn(d[k])]));

// Upgrade a (possibly older) persisted graph to the current GRAPH_VERSION. Every
// fluid node is coerced to EXACTLY the current FLUID_PARAMS ports (a param added
// since the save gets a default port; a removed one + its dangling edges are
// dropped), combine/points get any missing fields, nodes of a retired type are
// dropped (+ their edges), and the result is re-stamped to GRAPH_VERSION. Idempotent
// + returns the same object when nothing changed (safe to run on every load). For a
// future breaking change, add a targeted step keyed on the incoming version before
// the shape pass, then bump GRAPH_VERSION.
export function normalizeGraph(graph: Graph): Graph {
  if (!graph || !Array.isArray(graph.nodes)) return graph;
  let changed = false;
  // v8: a pre-v8 `color` node was the grade FX card (later renamed `color` -> `grade`,
  // freeing `color` for the dye card). The grade card is gone as of v10, so rename these
  // legacy nodes to `grade` — an unknown type now — and the filter below drops them,
  // rather than mis-coercing old grade data into a dye card.
  const legacy = (graph.version ?? 0) < 8;
  // v15: the old combined imagegen card becomes the slideshow card (the generator
  // half moved to the NEW imagegen type); prompt/seed are dropped — any generated
  // images are already in assetUrls, so nothing user-visible is lost.
  const preSplit = (graph.version ?? 0) < 15;
  // v21: `transform` is a KNOWN type again (re-added with a new data shape), so the
  // unknown-type filter no longer removes the pre-v10 FX cards. Rename them to a
  // retired sentinel and let the filter drop them — a v5 transform's data would
  // otherwise be mis-coerced into the new card.
  const preFxRemoval = (graph.version ?? 0) < 10;
  // v30: the montage rebuilt on composition extracts. A pre-v30 montage carries the
  // slot-ports shape (wired video inputs), which cannot be lifted — the slots' upstream
  // chains live in the same flat graph, not in the pool. The v21 precedent: rename to a
  // retired sentinel and let the unknown-type filter drop it (edges included). Decision
  // 2 (specs/compositions) allows the loss; the app opens clean instead of half-broken.
  const preExtracts = (graph.version ?? 0) < 30;
  const mapped = graph.nodes.map((node): GraphNode => {
    let n =
      legacy && node.type === "color" ? ({ ...node, type: "grade" } as unknown as GraphNode) : node;
    if (preSplit && n.type === "imagegen") {
      n = { ...n, type: "slideshow" } as unknown as GraphNode;
    }
    if (preFxRemoval && n.type === "transform") {
      n = { ...n, type: "transform-legacy" } as unknown as GraphNode;
    }
    if (preExtracts && n.type === "montage") {
      n = { ...n, type: "montage-legacy" } as unknown as GraphNode;
    }
    // v29: the detailed view is gone, so per-view compact coords (cx/cy, v20) fold into
    // the one canonical x/y. A card last arranged in compact keeps that layout; one only
    // ever seen in detailed (no cx/cy) keeps its x/y. Idempotent — cx/cy is absent after.
    const pv = n as GraphNode & { cx?: number; cy?: number };
    if (pv.cx != null || pv.cy != null) {
      const { cx, cy, ...rest } = pv;
      n = { ...rest, x: cx ?? pv.x, y: cy ?? pv.y } as GraphNode;
      changed = true;
    }
    if (n !== node) changed = true;
    const d = (n.data || {}) as Record<string, unknown>;

    if (n.type === "points") {
      const pts = Array.isArray(n.data?.points) ? n.data.points : ([[0.5, 0.5]] as Point[]);
      if (pts !== n.data?.points) changed = true;
      return { ...n, data: { ...n.data, points: pts } };
    }
    if (n.type === "combine") {
      // Ensure a combine carries mode / inputs / medium (older/partial saves).
      const cd = d as Partial<CombineNode["data"]>;
      const inputs: CombineSlot[] =
        Array.isArray(cd.inputs) && cd.inputs.length
          ? cd.inputs.map((s) => ({ id: s.id || mkSlotId(), opacity: s.opacity ?? 1 }))
          : [combineSlot(), combineSlot()];
      const data: CombineNode["data"] = {
        mode: cd.mode || "merge",
        inputs,
        medium: { ...COMBINE_MEDIUM, ...(cd.medium || {}) },
      };
      if (JSON.stringify(data) !== JSON.stringify(cd)) changed = true;
      return { ...n, data };
    }
    if (n.type === "color") {
      const cd = d as Partial<ColorData>;
      const stops =
        Array.isArray(cd.stops) && cd.stops.length
          ? cd.stops.map((s) => ({
              t: typeof s?.t === "number" ? s.t : 0,
              color: typeof s?.color === "string" ? s.color : "#ffffff",
            }))
          : COLOR_STOPS_DEFAULT.map((s) => ({ ...s }));
      const data: ColorData = {
        mode: cd.mode === "rgb" || cd.mode === "gradient" ? cd.mode : "swatch",
        stops,
        ports: coercePorts("color", cd.ports),
      };
      if (JSON.stringify(data) !== JSON.stringify(cd)) changed = true;
      return { ...n, data };
    }
    if (n.type === "video") {
      const data = coerceBySchema(DATA_SCHEMAS.video, d) as unknown as VideoData;
      // Migration: `speed` used to be a static field; carry a legacy value into its new
      // port binding (unless the save already has a wired/const speed port).
      const savedPorts = d.ports as Record<string, FluidPort> | undefined;
      if (typeof d.speed === "number" && !savedPorts?.speed) {
        data.ports.speed = { binding: { kind: "const", value: d.speed } };
      }
      if (JSON.stringify(data) !== JSON.stringify(d)) changed = true;
      return { ...n, data };
    }
    if (n.type === "slideshow") {
      const data = coerceBySchema(DATA_SCHEMAS.slideshow, d) as unknown as SlideshowData;
      // v23 migration: the card's own picks moved from `assetUrls: string[]` to
      // `items: SlideshowItem[]`. If a legacy save has assetUrls and no items yet, map
      // each url to an image/video item (kind inferred from the extension).
      if (!data.items.length && Array.isArray(d.assetUrls)) {
        data.items = (d.assetUrls as unknown[])
          .filter((u): u is string => typeof u === "string" && !!u)
          .map((url): SlideshowItem => ({ url, kind: slideshowKind(url) }));
      }
      if (JSON.stringify(data) !== JSON.stringify(d)) changed = true;
      return { ...n, data };
    }
    if (n.type === "fluid") {
      const old = (n.data?.ports || {}) as Record<string, { binding: Binding }>;
      const ports: Record<string, { binding: Binding }> = {};
      for (const p of FLUID_PARAMS) {
        ports[p.key] = old[p.key] || { binding: { kind: "const", value: p.def } };
      }
      const sameKeys =
        Object.keys(old).length === FLUID_PARAMS.length && FLUID_PARAMS.every((p) => old[p.key]);
      if (!sameKeys) changed = true;
      return { ...n, data: { ...n.data, ports } };
    }
    const schema = DATA_SCHEMAS[n.type];
    if (!schema) return n; // signal / output / scope: nothing to coerce
    const data = coerceBySchema(schema, d);
    if (JSON.stringify(data) !== JSON.stringify(d)) changed = true;
    return { ...n, data } as GraphNode;
  });
  // Drop nodes of a retired/unknown type (v7) so a legacy save loads cleanly. Their
  // incident edges are pruned below via `liveIds`.
  const nodes = mapped.filter((n) => KNOWN_NODE_TYPES.has(n.type));
  if (nodes.length !== mapped.length) changed = true;
  const liveIds = new Set(nodes.map((n) => n.id));
  // Drop edges incident to a removed node, and edges that targeted a now-removed
  // fluid PARAM port (keeps the §3.3 invariant). `positions` (the points input, spec
  // 11) is a non-param fluid input, so it's allowed — don't drop it.
  // "__in" = a loose (unassigned) wire parked on the card — legal on any node (v14).
  const valid = new Set([...FLUID_PARAM_KEYS, "positions", "color", "__in"]);
  const fluidIds = new Set(nodes.filter((n) => n.type === "fluid").map((n) => n.id));
  // v26: the same pruning for the gen-sim cards — their v25→v26 port RENAMES
  // would otherwise leave dangling param edges (coercePorts drops the binding,
  // and a bindingless non-loose edge breaks the binding↔edge invariant while
  // still hashing / faking "contributing"). Non-param inputs stay legal.
  const genValid: Record<string, Set<string>> = {};
  for (const t of ["waves", "lightning", "fire", "aurora", "rain", "clouds"]) {
    genValid[t] = new Set([
      ...(NODE_PARAMS[t] || []).map((p) => p.key),
      "positions",
      "color",
      "video",
      "__in",
    ]);
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edges = (graph.edges || []).filter((e) => {
    if (!liveIds.has(e.source) || !liveIds.has(e.target)) return false;
    if (fluidIds.has(e.target) && !valid.has(e.targetPort)) return false;
    const tv = genValid[nodeById.get(e.target)?.type ?? ""];
    if (tv && !tv.has(e.targetPort)) return false;
    return true;
  });
  if (edges.length !== (graph.edges || []).length) changed = true;
  // v29: the detailed view is gone, so the view-MODE fields go with it. `viewMode`
  // (v16), `viewOverrides` (v16) and the legacy `expanded`/`minimized` (pre-v16) are all
  // stripped — every card is compact now, so there is nothing to remember. cx/cy folded
  // into x/y per node above.
  const vg = graph as Graph & { viewMode?: unknown; viewOverrides?: unknown };
  if (vg.viewMode !== undefined || vg.viewOverrides !== undefined) changed = true;
  if (graph.expanded !== undefined || graph.minimized !== undefined) changed = true; // strip legacy
  if (graph.version !== GRAPH_VERSION) changed = true; // re-stamp after migrating
  if (!changed) return graph;
  const out = { ...graph, version: GRAPH_VERSION, nodes, edges } as Graph & {
    viewMode?: unknown;
    viewOverrides?: unknown;
  };
  delete out.viewMode;
  delete out.viewOverrides;
  delete out.expanded;
  delete out.minimized;
  return out;
}
