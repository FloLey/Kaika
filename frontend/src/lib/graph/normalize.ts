// normalizeGraph: upgrade a (possibly older) persisted graph to the current
// GRAPH_VERSION. The per-type field coercion is driven by a schema table (one
// row per field: coerce-or-default), with the genuinely special cases — fluid
// ports, combine slots, colour stops, the video `speed` migration — kept as
// explicit branches. Idempotent + returns the same object when nothing changed.

import { FLUID_PARAM_KEYS } from "../fluidParams.js";
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
  "output",
  "math",
  "lfo",
  "noise",
  "shaper",
  "gate",
  "scope",
  "pattern",
  "animate-points",
  "merge-points",
  "color",
  "lyrics",
  "image",
  "imagegen",
  "video",
  "backdrop",
]);

// ---- field coercers (the schema-table vocabulary) ------------------------------
type Coerce = (v: unknown) => unknown;
const num = (def: number): Coerce => (v) => (typeof v === "number" ? v : def);
const str = (def: string): Coerce => (v) => (typeof v === "string" ? v : def);
const orDefault = (def: string): Coerce => (v) => v || def; // truthy passes (legacy semantics)
const bool: Coerce = (v) => !!v;
const boolDefaultTrue: Coerce = (v) => v !== false;
const oneOf = (values: string[], def: string): Coerce => (v) =>
  values.includes(v as string) ? v : def;
const hexColor = (def: string): Coerce => (v) =>
  /^#[0-9a-fA-F]{6}$/.test((v as string) || "") ? v : def;
const idList: Coerce = (v) =>
  Array.isArray(v) && v.length ? v : [mkInputId(), mkInputId()];
const strList: Coerce = (v) =>
  Array.isArray(v) ? v.filter((u): u is string => typeof u === "string") : [];
const portsFor = (type: string): Coerce => (v) =>
  coercePorts(type, v as Record<string, FluidPort> | undefined);

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
  gate: { threshold: num(0.5), hysteresis: num(0.1), invert: bool },
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
    ports: portsFor("video"),
  },
  imagegen: {
    assetUrls: strList,
    box_x: num(0),
    box_y: num(0),
    box_w: num(1),
    box_h: num(1),
    fit: oneOf(["cover", "contain", "stretch"], "cover"),
    threshold: num(0.5),
    hysteresis: num(0.1),
    prompt: str(""),
    seed: num(1),
    ports: portsFor("imagegen"),
  },
  backdrop: { color: hexColor("#101418"), ports: portsFor("backdrop") },
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
  const mapped = graph.nodes.map((node): GraphNode => {
    const n =
      legacy && node.type === "color" ? ({ ...node, type: "grade" } as unknown as GraphNode) : node;
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
  const edges = (graph.edges || []).filter(
    (e) =>
      liveIds.has(e.source) &&
      liveIds.has(e.target) &&
      !(fluidIds.has(e.target) && !valid.has(e.targetPort))
  );
  if (edges.length !== (graph.edges || []).length) changed = true;
  // v13: compact-by-default. The persisted set inverted from `minimized` (collapsed
  // cards) to `expanded` (full-body cards). A save without `expanded` gets it derived:
  // the inverse of its `minimized` set — which, for an old save with NO minimized
  // field, means ALL node ids (old saves showed full cards; preserve their look).
  // A v13+ save keeps its `expanded`, filtered to live node ids. `minimized` is
  // always stripped from the result.
  let expanded: string[];
  if (Array.isArray(graph.expanded)) {
    expanded = graph.expanded.filter((id) => liveIds.has(id));
    if (expanded.length === graph.expanded.length) expanded = graph.expanded;
    else changed = true;
  } else {
    const min = new Set(graph.minimized ?? []);
    expanded = nodes.filter((n) => !min.has(n.id)).map((n) => n.id);
    changed = true;
  }
  if (graph.minimized !== undefined) changed = true; // legacy field present: strip it
  if (graph.version !== GRAPH_VERSION) changed = true; // re-stamp after migrating
  if (!changed) return graph;
  const out: Graph = { ...graph, version: GRAPH_VERSION, nodes, edges, expanded };
  delete out.minimized;
  return out;
}
