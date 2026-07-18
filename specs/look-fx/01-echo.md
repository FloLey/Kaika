# 01 — Echo card (`video → video`)

> Motion trails: movement leaves fading ghosts behind. The smallest card of the
> wave but the hardest semantics — a genuinely *temporal* effect inside a
> block-streamed renderer. It lands first to prove the stateful-block shape and
> the stream ≡ sync test that every later card reuses, plus the one-time
> infrastructure (`look_fx.py`, GRAPH_VERSION 24, RENDER_VERSION 7).
>
> **Revised after the first review** (user tested with real footage — a runner
> against a bright street — and the max-trail was invisible): the card gained a
> `mode` dropdown with three memories. `ghost` (default) = EMA afterimages of
> every change, blend capped 50/50 so the live frame stays readable — the
> universal echo for real footage. `bright` = the original decayed running max —
> comet tails for dye-on-black. `dark` = bright's exact mirror (the same scan on
> the inverted image) — solid shadow trails behind a dark subject on a bright
> scene.

## Locked decisions

1. **Three trail memories behind one `mode` static** (`ghost | bright | dark`,
   default `ghost`). Shared per frame: `p = 0.5 ** (1 / (length·fps))`
   (`length` = the trail's half-life in seconds). bright:
   `acc = maximum(frame, acc·p)`, `out = frame + amount·clip(acc − frame)` —
   ghosts keep their original brightness, black stays black (the dye floor
   survives). ghost: `acc = lerp(frame, acc, p)` (seeded from frame 0 so an
   empty history can't dim the clip start),
   `out = frame + amount·0.5·(acc − frame)` — signed, capped 50/50. dark:
   `255 − bright_scan(255 − frames)`, accumulator carried in inverted space.
2. **The accumulator is closure state, not lookback.** Blocks can't re-pull
   earlier upstream frames (PLAN §2), and the decayed accumulator *is* the
   complete summary of all past frames — carrying it across `produce(a, b)`
   calls is exact, O(1) memory, and byte-identical to the whole-clip scan.
3. **float32 accumulator, all channels.** An RGBA layer's alpha trails with its
   colour (the `_transform_frames` C∈{3,4} convention), so a lyrics layer's
   cut-out ghosts correctly.
4. **`length = 0` is a passthrough** (no allocation, no scan) — the freshly
   dropped card defaults to a visible trail (`0.4`), but a modulated length that
   hits 0 must not divide by zero: `p = 0` when `length·fps < 1e-6`.
5. **Trails reset at segment cuts** in the whole-song export (each segment
   renders through its own DAG). Accepted; one Docs sentence.

## Ports (`SOURCE_PARAM_SPEC["echo"]`)

| key | label | min | max | step | default | fmt | meaning |
|-----|-------|-----|-----|------|---------|-----|---------|
| `length` | length | 0.0 | 2.0 | 0.05 | 0.4 | dp2 | trail half-life, seconds (0 = off). Wire a signal → beat-pumped trails. |
| `amount` | amount | 0.0 | 1.0 | 0.01 | 1.0 | dp2 | dry ↔ trail mix |

## 1 — `backend/look_fx.py` (new module, this commit)

The module opens with the wave's shared helpers (later specs add theirs):

```python
def rng_for_frame(seed: int, t_abs: int) -> np.random.Generator:
    """Deterministic per-frame RNG: reproducible, block-independent (PLAN §3)."""
    return np.random.default_rng(np.random.SeedSequence([int(seed), int(t_abs)]))

def echo_scan(frames, acc, fps, *, length, amount):
    """(T,H,W,C) uint8 + carried float32 acc (or None) -> (out, new_acc).
    length/amount are per-frame float32 arrays (Dag._fx_params output)."""
```

`echo_scan` loops the block's frames front-to-back updating `acc`, returns the
new accumulator so the block closure can carry it. The whole-clip path is the
same call with `acc=None` over all frames.

## 2 — Backend handlers (`backend/graph_render.py`)

- `_echo_video(dag, node)`: `src = _video_source(...)` (ValueError if unwired,
  transform's message style); `out, _ = look_fx.echo_scan(dag.video(src), None,
  dag.fps, **dag._fx_params(node))`.
- `_echo_block(dag, node)`: resolve `params = dag._fx_params(node)` once
  (full-segment arrays); `producer = dag._block_producer(src)`;
  `state = {"acc": None}`; `produce(a, b)` calls `echo_scan(producer(a, b),
  state["acc"], dag.fps, **{k: v[a:b] for k, v in params.items()})` and stores
  the returned acc. Ordering is guaranteed by `_block_producer`'s cache + lock
  (each block runs the inner closure once, front-to-back — the FluidClip
  argument, restated at the closure).
- Register in `_VIDEO_HANDLERS` / `_BLOCK_HANDLERS`. `_VIDEO_PRODUCERS`,
  validate, and `output_hash` pick the type up automatically.
- **`backend/graph_hash.py`: `RENDER_VERSION` 6 → 7** (this commit, once for
  the wave).

## 3 — Frontend graph model

- `lib/types.ts`: `EchoData { ports: Record<string, FluidPort> }`; `EchoNode`
  in the `GraphNode` union.
- `lib/graph/factories.ts`: `echoNode(x, y)` (`ports: coercePorts("echo",
  undefined)`); **GRAPH_VERSION 23 → 24** with the history comment
  *v24: added the five look-FX cards (echo/colorgrade/retro/signalfx/paint) —
  pure additions, no migration.*
- `lib/graph/normalize.ts`: `echo: { ports: portsFor("echo") }` in
  `DATA_SCHEMAS`; add `"echo"` (and, this commit, all five types) to
  `KNOWN_NODE_TYPES`.
- `lib/graph/core.ts`: add to `VIDEO_FX` (flows into `VIDEO_PRODUCERS` +
  `nodeRenderable`'s wired-input rule). `lib/graphModel.ts`: re-export the
  factory.
- `lib/nodeParams.ts`: `export const ECHO_PARAMS: FluidParam[] =
  SOURCE_PARAMS.echo;` + `echo: ECHO_PARAMS` in `NODE_PARAMS`.
- `lib/graph/layout.ts`: a `DETAILED_SIZES.echo` entry (small — two rows).

## 4 — Card + registry

- `components/animation/nodes/EchoNode.tsx` — the wave's simplest card:
  `NodeFrame`, `video` in-port, `StreamPreview`, two `ParamRow`s, a one-line
  hint ("movement leaves fading ghosts — wire *length* to a signal").
  TransformNode.tsx minus the mode select.
- `nodes/registry.ts`: `echo` entry — `chrome { title: "echo", accent:
  "var(--fx)", outFlow: "video" }`, factory, palette
  `{ label: "Echo", category: "compositing", order: 3.69, help: "Motion
  trails — movement leaves fading ghosts. Wire length to a signal for
  beat-pumped trails.", io: { in: "video", out: "video" } }`.
- `lib/paramHelp.ts`: `length`, `amount` one-liners; `ARG_SECTION` →
  `animation-lookfx`.

## 5 — Docs

`Docs.tsx`: this commit creates the shared **`animation-lookfx`** section
(added to `DOC_SECTION_IDS`) that all five cards point at; Echo's paragraph
covers the trail math in user terms + the segment-cut reset note (Locked 5).

## 6 — Playground demo + tests

- `backend/card_demo.py` `CARD_LABELS`: `"echo": "Echo"`. Demo pipeline: a
  fast-orbiting fluid (animate-points) → echo (`length` ← LFO) → output — the
  orbit paints visible comet trails; easily clears the brightness floors.
- **New `tests/test_look_fx.py`** (this commit; later specs append):
  - **stream ≡ sync**: echo graph rendered via `Dag.video()` vs concatenated
    `stream_blocks(block_frames=4)` — exact array equality. THE test of the
    wave's temporal design.
  - decay: a single bright frame then black input → trail strictly decreasing,
    gone within ~4 half-lives.
  - `length=0` → passthrough (input returned unchanged).
  - RGBA: a 4-channel layer passes through with alpha trailing.
- Frontend: registry round-trip / paramHelp / playground-fixture suites cover
  the new entry automatically.

## Verification

Commit gates (PLAN). Live: fluid → echo → output, wire `length` to a kick
signal — trails stretch on every hit; scrub across a block seam (~5 s) — no
jump in the ghosts (the closure-state proof, eyeballed).
