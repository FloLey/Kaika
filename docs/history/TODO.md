# TODO

Signals support 8 feature types (`signals.py` `_RAW`): energy, onset, flux,
brightness, harmonic, chroma, beat, bar — each with full shaping (attack/release/
invert/gamma/gain/offset/threshold), drawn live + pulse-pad preview per segment,
persisted to Postgres.

## Signal features — DONE
- [x] onset, flux, brightness, harmonic, chroma, beat/bar phase + feature selector.

## Simulation (rebuild Kaika ON TOP of this project — later, big milestone)
The signals are NOT exported to the external Kaika. The visual simulation will be
rebuilt inside this project and read the per-segment signals directly (from
Postgres / in memory). No disk export / hand-off needed.
- [x] First fluid sim: standalone **fluid lab** — backend `fluid.py` (Stam
      stable-fluids, ported from Kaika) computes a centered-source clip, looped
      live in the UI with debounced controls (`/fluid` + `FluidLab.jsx`).
- [ ] Design the in-project sim that consumes a segment's signals (curves) as
      per-frame control inputs.
- [ ] Decide the contract the sim reads (fps, normalization 0..1, signal naming).
- [ ] A timeline/preview that plays a segment with its signals driving visuals
      (the pulse pad is the first seed of this).

## Kaika fluid sources — signal-driven (next big step, after the sim above)
The idea: model a *fluid source* as a first-class object in Kaika and let signals
drive its behaviour live.
- [ ] Define all the characteristics of a fluid **source** in Kaika (its full set
      of inputs/parameters — e.g. position, rate/flow, velocity, density, pressure,
      temperature, viscosity, color, lifetime, spread/angle… enumerate the complete
      schema).
- [ ] Build a "patching" stage where you can link a pulse/signal to any one input
      of a source object and watch how it changes the source's behaviour.
- [ ] Wiring: connect each signal (output) to a source input and see, in a live
      render, what changes in the fluid as the connection drives it.
- [ ] Support multiple fluids at once — each with its own source + its own
      signal→input wiring — composed in the same live render.

## Shaping / combination extras
- [ ] Combine signals: multiply / mix / max two signals.
- [ ] Derivative shaper (react to change) and accumulator/build shaper.
- [ ] Per-signal output range remap (min→max), quantize/steps.

## Card builder — generate new cards from a description (idea, not scheduled)
Let the user describe a card in three fields — **input**, **output**, and **what
it does** — and have the app author the card, register it, and make it usable
immediately, without a manual code change per card. The end state: a single
"registry of tools" that both *describes* every card and *implements* it, so cards
can be loaded dynamically and new ones added on the fly.

### Investigation notes (what "add a card" actually costs today)
An investigation traced one card end-to-end across every surface. Findings:

- **"Add a card" is not one recipe — there are three archetypes**, each with a very
  different backend footprint. A generator must classify the card first:
  - **Value modulator** (LFO / Math / Noise / Shaper — outputs a 0..1 curve): the
    *lightest* path. One pure `_xxx_curve(data, nframes, fps)` + one `elif` branch in
    `graph_modulators.py::_make_value_resolver`. **No** param spec, **no** codegen,
    **no** render handlers, **no** `RENDER_VERSION` bump. Params ride in `node.data`
    and are hashed generically.
  - **Points card** (points / pattern / animate-points / merge-points): one branch in
    `Dag._resolve_points` + a helper in `graph_modulators.py`.
  - **Video producer** (fluid / backdrop / image / …): the *heavy* path — twin
    `_xxx_video` **and** `_xxx_block` handlers that must stay byte-identical
    (whole-clip vs. block-streaming lockstep), plus the render math in a `sources.py`
    function, a `SOURCE_PARAM_SPEC` entry, and `make gen-params`.
- A single new card normally touches **~15–18 edit sites** across frontend + backend
  (see the authoritative human checklist at `DEVELOPMENT.md` "Checklist — add a node
  type"). Most is mechanical boilerplate; the real design decisions are the render
  math, the `data` field schema + defaults, port ranges, palette/help copy, and a
  non-black Playground demo graph.
- **Only one codegen precedent exists**: `backend/gen_fluid_params.py` string-templates
  `frontend/src/lib/fluidParams.js` from the backend param specs, guarded by a no-drift
  test. It's a *pure projection*, not open-ended generation.
- **There is no runtime plugin system today** — both registries (`registry.ts`
  `NODE_TYPES`, `graph_render.py` dispatch dicts) are hand-edited static objects. A
  "load on the fly" card builder has to *introduce* dynamic registration; that's the
  biggest new-infra cost, and it relaxes the static-registry invariants the current
  tests assume.
- **`output_hash` already folds each node's whole `data` dict generically**
  (`graph_hash.py`), so a new node type's params are cache-covered for free — an
  additive card needs **no** `RENDER_VERSION` bump.
- The app's existing LLM client (`backend/llm.py`) runs a **local Ollama model**
  (`qwen3.6`), consistent with Kaika's local-first design — reuse it for generation,
  noting code-gen is materially harder than the section-splitting it does today.

### Recommended first cut (chosen direction — a POC, still not scheduled)
Scope decisions taken while planning: **(1)** POC on the **value-modulator archetype
only** (lightest path); **(2)** the card's math is **LLM-generated source** (not a
constrained DSL); **(3)** cards load via a **runtime plugin registry** — live with no
restart ("on the fly").

**Key architectural decision that reconciles those three.** "Generated source" +
"runtime loading" + a browser that only runs *bundled* React would otherwise force an
in-browser TSX compiler. Avoid that by **splitting where code vs. data is generated**:
- **Backend = real generated code.** The model writes a genuine Python `curve()` body,
  AST-validated + sandboxed + smoke-tested, then dynamically loaded.
- **Frontend = generated *data* (a spec), rendered generically.** The model writes a
  card **spec** (JSON: label, category, controls, help). One generic
  `GenericModulatorNode` renders *any* value-modulator spec — **no per-card TSX is
  compiled in the browser**, which is what makes runtime loading feasible.

So the plugin unit is a **single card-definition document** = metadata + controls spec
(drives the frontend) + `curve_src` Python (drives the backend):
```json
{ "type": "wobble", "label": "Wobble", "category": "modulators",
  "archetype": "value-modulator", "help": "…",
  "controls": [ { "key": "rate", "widget": "slider", "min": 0.1, "max": 8,
                  "step": 0.1, "default": 2, "help": "…" } ],
  "inputs": ["in"],
  "curve_src": "def curve(data, nframes, fps, inputs): …  # float32 (nframes,) 0..1" }
```

Work items:
- [ ] **Store** — a `generated_cards` JSONB table in `db.py` (user data, keyed by
      node type; matches the `projects` persistence pattern). One row per card.
- [ ] **Sandbox** — safe-compile `curve_src`: AST allowlist (reject imports /
      `eval` / `exec` / `open` / underscore-dunder escapes), restricted builtins
      exposing only `np` / `math`, then a timed smoke test asserting a finite
      `float32 (nframes,)` result. Threat model is "the local model wrote something
      dumb/runaway," not an adversary — proportionate, not a hardened jail.
- [ ] **Plugin registry** (backend) — load defs from the store, compile + cache each
      curve, expose `resolve(type)` / `all_specs()`; hook it as the fallback in
      `_make_value_resolver` (after the built-in `elif` chain). A bad card degrades
      that node to flat 0 rather than failing the render.
- [ ] **Generation** — `llm.generate_card(input, output, description)` reusing the
      Ollama client, a strict JSON schema, and a bounded retry loop that feeds
      validation/smoke-test errors back to the model. Keep the model choice behind
      one function so it can point at a stronger model if local quality is weak.
- [ ] **Routes** — `POST /cards/generate`, `GET /cards`, `DELETE /cards/<type>`;
      register the blueprint and add `/cards` to the Vite proxy (hard invariant).
- [ ] **Frontend generic renderer** — `GenericModulatorNode.tsx` renders any spec
      (NodeFrame + `out` value port + optional input ports + a controls loop reusing
      the existing `Ctl`/`select` widgets, with help badges from the spec).
- [ ] **Dynamic registry** (frontend) — fetch `GET /cards` at editor load and overlay
      the specs onto the registry's consumers: `registry.ts` (palette/chrome),
      `normalize.ts` (`KNOWN_NODE_TYPES` + a generic coercion derived from the spec's
      controls), `factories.ts` (a generic factory). **Sequencing risk:**
      `normalizeGraph` drops unknown-type nodes, so specs must be fetched *before* a
      graph with dynamic nodes is normalized (gate load on the fetch, or make the
      drop lenient for known dynamic types).
- [ ] **Card Builder UI** — a 3-field panel (input / output / what it does) →
      `POST /cards/generate` → refetch `/cards` so the new card appears live in the
      palette. Add a "?" per the docs invariant (a `card-builder` `Docs.tsx` section).

Deliberately **deferred**: the points + video-producer archetypes (twin
`_video`/`_block` lockstep, `sources.py`, `SOURCE_PARAM_SPEC`, `make gen-params`);
bespoke per-card TSX; and baking generated cards into git / `CARD_LABELS` / the
Playground (runtime cards are user data, so they're exempt from `test_card_impact.py`,
which guards shipped built-in cards). Edge case to handle: a saved graph referencing a
later-deleted generated card drops that node on normalize.

> A throwaway backend spike (sandbox + plugin registry + store) written while
> exploring **accidentally landed in commit `f538e0c`**, then was **removed from the
> working tree** (`card_plugins.py`, `card_sandbox.py`, the `db.py` table, the
> `graph_modulators.py` hook, the `/cards` proxy line) — so committing the current
> tree drops it. It still exists in history at `f538e0c` if ever wanted as a
> reference when this work is actually picked up.

## Cleanup — DONE
- [x] Removed dead `TrackRow.jsx`, `FreqControls.jsx`, `Modal.jsx` + their CSS.
