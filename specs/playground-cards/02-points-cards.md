# 02 — Points cards (`points`)

> The `points` card today is a **draw pad only** (`PointsNode.tsx` + `addPoint`/
> `movePoint`/`removePoint` in `graphModel.ts`): you click positions by hand and wire
> them into a fluid's `positions` input, which emits one source per point. That's
> tedious for regular layouts and impossible to animate. These two cards make
> `points` generative and composable: **Pattern/Shape** (parametric layouts) and
> **Animate Points** (move points over time). They unlock "a ring of 12 sources
> rotating on the beat" without placing a single dot by hand.

## Locked decisions

1. **`points` stays a 0–1 normalised `[x, y][]`** (the existing `PointsData.points`
   shape, `types.ts:108-110`), so any of these cards drops into a fluid's `positions`
   input unchanged.
2. **`points → points` uses plain edges** (same generic edge mechanism as PLAN P1):
   Animate takes a `points` input and emits `points`. Pattern is a pure generator (no
   input).
3. **Points consumers read `node.data.points`** — but transforms need the *resolved*
   upstream points, so the backend gains a small `resolve_points(node_id)` resolver
   (mirrors `resolve_source`, memoised) that `_points_for` calls instead of reading
   `data.points` directly. A bare `points` (draw pad) resolver just returns its array.
4. **Generators may be time-varying.** Pattern's `rotation`/`radius`/`count` and
   Animate's amount are modulatable (PLAN P2). A points stream is therefore resolved
   **per frame** when any input is modulated (length-`nframes` list of point-lists),
   and the fluid emits accordingly; when all inputs are static it stays a single
   point-list (byte-identical to today's path — see "Open questions").
5. **`count` is clamped** (e.g. ≤ 64) to bound emitter count — surfaced in the UI, and
   `log`-free hard cap in the backend.

## Architecture this builds on

- Frontend: `PointsNode.tsx` (draw pad + aspect-ratio pad), `graphModel.ts` points
  helpers (`patchPoints`, `addPoint`…), `registry.ts` (`points` is category
  `sources`, `outFlow: "points"`, accent `var(--courant)`), `ports.ts` (`points` flow
  already matches in `connectIssue`).
- Backend: `graph.py` `_Dag._points_for` (`graph.py:533-541` — the single reader of a
  fluid's wired points today) and `_fluid_emitters` (one source per point,
  `graph.py:543-550`). These are the integration points to generalise to a
  `resolve_points` resolver.
- The `positions` input is already a non-param fluid input that `normalizeGraph`
  preserves (`graphModel.ts:295` keeps `"positions"` in `valid`).

## Cards

### B1 — Pattern / Shape  (`id: pattern`)
1. **Purpose.** Generate a regular layout of source positions parametrically — a ring
   of emitters, a grid, a line, a spiral — instead of hand-placing.
2. **Ports.** No input. Output `out` (`points`).
3. **Static params.** `layout`: `circle | ring | grid | line | spiral | scatter`.
   `count` (1–64). `radius` / `spacing` (0–1). `rotation` (0–360°). `center` `[x,y]`.
   `scatter` seed (deterministic). `count`, `radius`, `rotation` modulatable (P2).
4. **Frontend.** `PatternData { layout; count; radius; rotation; center; seed; ports }`;
   factory seeds `circle`, `count:6`. Component: layout `<select>` + sliders + a live
   preview pad reusing `PointsNode`'s normalised pad (read-only, shows generated dots).
5. **Backend.** `resolve_points` branch: compute positions from params; when any of
   `count/radius/rotation` is signal-bound, emit a per-frame list (resolve those ports
   via P2 first). Clamp to `[0,1]²`.
6. **Docs.** `animation-pattern` — "Lay out sources in a ring/grid/spiral; spin the
   ring by wiring rotation to a signal."

### B2 — Animate Points  (`id: animate-points`)
1. **Purpose.** Move an incoming points set over time — orbit, jitter, breathe (scale
   pulse), drift — so a hand-drawn or patterned layout comes alive.
2. **Ports.** Input `in` (`points`). Output `out` (`points`).
3. **Static params.** `mode`: `orbit | jitter | breathe | drift`. `amount` (0–1).
   `rate` (tempo-locked or free, same convention as the LFO in spec 01). `center` for
   orbit/breathe. `amount`/`rate` modulatable (P2).
4. **Frontend.** `AnimatePointsData { mode; amount; rate; center; ports }`. Component:
   mode `<select>` + amount/rate; preview shows the resolved motion.
5. **Backend.** `resolve_points` branch: resolve `in`, then for each frame apply the
   per-mode transform (orbit = rotate about center by `rate·t`; jitter = seeded
   per-frame offset scaled by `amount`; breathe = scale about center; drift = LFO-style
   translation). Produces a per-frame point list. Jitter is seeded for cache stability.
6. **Docs.** `animation-animate-points` — "Orbit, jitter, or breathe a set of sources
   over time."

## Open questions (resolve while drafting)

- **Per-frame emitters in `fluid.simulate`.** Today `_fluid_emitters` returns a *static*
  source list (one per point); a fluid source's own `points`/`path_speed` is how it
  moves. Confirm whether `simulate()` accepts **time-varying source positions** (a
  per-frame list) or whether Animate/modulated-Pattern should instead drive each
  source's existing path machinery. Pick the smaller change; the static path keeps the
  current behaviour byte-identical (important for the render cache).
- **Resolver factoring.** `resolve_points` should sit beside `resolve_source` and be
  memoised the same way; confirm `_points_for` is the only caller to update.
- **Count cap interaction with merge.** A patterned fluid feeding a merge multiplies
  emitters; confirm the cap is enforced before `_merge_params` concatenation.

## Verification

- `pattern(circle, count 8) → fluid.positions → output` renders 8 sources;
  `pattern → animate-points(orbit) → fluid.positions` shows them rotating.
- `rotation`-bound Pattern (wired from an LFO) spins on render; static Pattern hits the
  render cache identically across two renders.
- `normalizeGraph` + `validate` accept `points→points` edges; the count cap holds.
