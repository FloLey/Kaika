# 02 — Color Grade card (`video → video`)

> Recolour the stream: thermal-camera false colour, two-colour duotone
> (poster look), or neon edge-glow on black. Ships the C2 "Color/Hue grade"
> that `specs/playground-cards/03-video-fx-cards.md` left unshipped — and goes
> further: the card takes an optional **`tint` colour input**, so a `color`
> card in gradient mode with a bound `position` sweeps the grade's colour with
> the music. Lands second to prove the colour-input plumbing on an FX card.

## Locked decisions

1. **Three modes, one dropdown**: `thermal | duotone | neon` (default
   `thermal`). `ColorGradeData { mode; map; colorA; colorB; ports }`.
2. **`tint` is a real colour input, resolved the lyrics way.**
   `_resolve_node_color(graph, node, "tint", nodes, resolve)`
   (`graph_modulators.py:40`) is already generic — lyrics uses it for
   `fillColor`/`outlineColor`; nothing about it is fluid-specific. Wired: the
   per-frame r/g/b(+intensity) replaces `colorB`. Unwired (`{}`): the static
   swatches. No new backend colour machinery.
3. **Floor behaviour is per mode and documented** (PLAN §6): *neon* keeps black
   black (edges on black); *thermal* keeps it for inferno/turbo (their 0 is
   ~black) but lifts it for jet/ocean; *duotone* lifts it by design (`colorA`
   IS the shadow colour). Docs: grade modes belong at the end of the chain.
4. **LUT-based, near-free.** All three modes reduce to a 256-entry lookup on
   luminance (thermal, duotone) or a Canny+blur pass (neon) — no per-pixel
   Python, trivially real-time.

## Data + ports

Static (`lib/types.ts`):

```ts
export interface ColorGradeData {
  mode: "thermal" | "duotone" | "neon";
  map: "turbo" | "inferno" | "jet" | "ocean"; // thermal only
  colorA: string; // duotone shadow hex (default "#0b1030")
  colorB: string; // duotone highlight / neon glow hex (default "#ff5ac8"); tint overrides
  ports: Record<string, FluidPort>;
}
```

`SOURCE_PARAM_SPEC["colorgrade"]`:

| key | label | min | max | step | default | fmt |
|-----|-------|-----|-----|------|---------|-----|
| `intensity` | intensity | 0.0 | 1.0 | 0.01 | 1.0 | dp2 |
| `shift` | shift | 0.0 | 1.0 | 0.01 | 0.0 | dp2 |

Port → mode mapping:

| port | thermal | duotone | neon |
|------|---------|---------|------|
| `intensity` | dry ↔ graded mix | dry ↔ graded mix | glow gain |
| `shift` | LUT roll (`shift·255`) | midpoint gamma `lum**(2**(shift·2−1))` | glow hue rotation |

## 1 — `backend/look_fx.py`

```python
def colorgrade_apply(frames, static, fps, frame_offset, tint, *, intensity, shift):
    """(T,H,W,C) uint8. `tint` is _resolve_node_color's dict ({} = unwired);
    its r/g/b/intensity entries are scalars or per-frame arrays."""
```

- **thermal**: luminance (RGB via `fluid.flatten` if C=4) →
  `cv2.applyColorMap` with the `map` LUT rolled by `shift·255`; lerp toward the
  input by `1 − intensity`.
- **duotone**: shaped luminance `lum ** (2 ** (shift·2 − 1))` lerps
  `colorA → colorB/tint` per frame.
- **neon**: `cv2.Canny(80, 160)` (extract's thresholds) → hard edge core +
  `cv2.GaussianBlur` halo × `intensity`, coloured `colorB`/tint with hue
  rotated by `shift`, composited on black.

## 2 — Backend handlers

The transform pair plus the colour resolve at setup:

- `_colorgrade_video`: `tint = _resolve_node_color(dag.graph, node, "tint",
  dag.nodes, dag._value_resolver())`; apply over `dag.video(src)`.
- `_colorgrade_block`: resolve `tint` + `params` once; per-frame tint arrays
  slice `[a:b]` like `_lyrics_block`'s params do; wrap the upstream producer.
- Register in both handler dicts (PLAN §5).

## 3 — Frontend graph model

The standard five-card wiring (spec 01 §3 lists it; only deltas here):

- `normalize.ts` row: `mode: oneOf([...], "thermal")`, `map: oneOf([...],
  "turbo")`, `colorA/colorB: hexColor(...)`, `ports: portsFor("colorgrade")`.
- **The tint plumbing (the point of this commit):**
  - `lib/graph/mutations.ts` `resolveDropPort` colour branch (~:271): add
    `node.type === "colorgrade" ? ["tint"] : ...` to the candidates.
  - `components/animation/nodes/CompactCard.tsx` `inFlow` (~:38): add
    `portId === "tint"` to the colour-port test (the wired case already
    resolves via the `src?.type === "color"` fallback; this fixes the UNWIRED
    port's drop-target typing in compact view).

## 4 — Card + registry

- `ColorGradeNode.tsx`: mode select; `map` select (thermal), `colorA`/`colorB`
  swatches (duotone/neon) — mode-conditional like transform's `segments`; a
  second `sideIn` **`Port flow="color" portId="tint"`** (the LyricsNode
  stacked-in-ports pattern, LyricsNode.tsx:185-205); two `ParamRow`s.
- Registry: label "Color Grade", order 3.67, help: "Thermal, duotone or neon
  edge-glow. Wire a gradient color card into tint and bind its position — the
  grade sweeps colour with the music."
- paramHelp: `mode`, `map`, `colorA`, `colorB`, `intensity`, `shift`, `tint` →
  `animation-lookfx`.

## 5 — Playground demo + tests

- `CARD_LABELS`: `"colorgrade": "Color Grade"`. Demo: fluid → colorgrade
  (duotone, `tint` ← color card in gradient mode with `position` ← LFO) →
  output — colour visibly sweeps; duotone's lifted floor easily clears the
  brightness bars.
- `tests/test_look_fx.py` additions:
  - wired tint (gradient + bound position) changes duotone output across
    frames; unwired falls back to `colorB` exactly;
  - thermal `intensity=0` → passthrough; neon on black input → black output;
  - stream ≡ sync for a graded graph (colour arrays slice correctly per block).

## Verification

Commit gates (PLAN). Live: the demo pipeline sweeping colour with the beat;
flip all three modes; drop a colour wire onto the compact card — it lands on
`tint` (the §3 plumbing, eyeballed).
