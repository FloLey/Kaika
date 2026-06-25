# 07 — Workspace integration (bottom-bar mode switch + render flow)

> Wire the animation editor into the app: a **bottom bar** that switches the studio
> screen between "extract signals by track" and "create animation", a container that
> owns the per-segment graph (autosaved via `segment.graph`), and the **Render**
> action that calls `/animate` and feeds the looping video into the Output card.
> Closes **Milestone M3** — the full loop.

## Goal

From a segment, the user switches to **Create animation**, builds a graph, presses
**Render**, and sees a looping video that persists across reload — all sharing the
existing `SegmentRail` and active segment.

## Files

- **Create** `frontend/src/components/animation/AnimationCanvas.jsx` (container).
- **Modify** `frontend/src/components/studio/Studio.jsx` — add the bottom bar +
  tab switch; render the signal pane or `AnimationCanvas` for the active segment.
- **Modify** `frontend/src/App.jsx` — minimal: pass a `studioTab` state down (or
  keep tab state inside `Studio`; see below).
- *(Persistence already handled by `04`'s `segments.js` change + existing autosave.)*

## Design detail

### Bottom bar + tab state

The mode switch is local to the studio screen and must keep the **same active
segment** across tabs. Two valid placements — pick the lighter one:

- **Recommended:** keep `const [tab, setTab] = useState("signals")` **inside
  `Studio.jsx`**. `Studio` already owns the rail + active segment; the tab only
  changes the right-hand pane. App doesn't need to know.

`Studio` render becomes:

```jsx
<div className="studio …">
  <SegmentRail … />                         {/* unchanged, shared */}
  <div className="studio-main">
    {tab === "signals"
      ? (/* existing per-track signal groups */)
      : <AnimationCanvas
          segment={activeSeg} stems={stems} job={job}
          onGraphChange={(g) => editActiveSegment(s => ({ ...s, graph: g }))}/>}
  </div>
  <nav className="mode-bar">               {/* the bottom bar */}
    <button className={tab==="signals" ? "on":""} onClick={() => setTab("signals")}>
      extract signals by track</button>
    <button className={tab==="animation" ? "on":""} onClick={() => setTab("animation")}>
      create animation</button>
  </nav>
</div>
```

> `editActiveSegment` is Studio's existing pattern for mutating the active segment
> within `setSegments` (see `editActiveSignals` in `Studio.jsx`). Add a sibling that
> patches the whole segment (for `graph`).

### `AnimationCanvas` container

Owns the **render** state and bridges graph ↔ canvas ↔ backend:

```jsx
function AnimationCanvas({ segment, stems, job, onGraphChange }) {
  const graph = segment.graph || emptyGraph();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [videoUrl, setVideoUrl] = useState("");   // last rendered url for this graph
  const [selId, setSelId] = useState(null);

  function update(updater) { onGraphChange(updater(graph)); }  // lift to segment.graph

  async function render() {
    const v = validate(graph); if (!v.ok) { setError(v.error); return; }
    setBusy(true); setError("");
    try {
      const { url } = await api.renderGraph({
        job_id: job,
        segment: { start: segment.start, end: segment.end, signals: segment.signals },
        graph,
      });
      setVideoUrl(url);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="anim-wrap">
      <GraphCanvas graph={graph} onGraphChange={update}
                   selected={selId} onSelect={setSelId}
                   renderNode={(node, h) => renderAnimNode(node, h, { segment, stems, job, videoUrl, busy, error })}/>
      <Palette graph={graph} onAdd={(node) => update(g => ({ ...g, nodes: [...g.nodes, node] }))}
               signals={segment.signals}/>
      <div className="anim-actions">
        <button className="btn primary" disabled={busy} onClick={render}>
          {busy ? "rendering…" : "render"}</button>
        {error && <span className="anim-err">{error}</span>}
      </div>
    </div>
  );
}
```

- **Render trigger:** explicit **Render** button (not auto-debounce) — the locked
  decision, since modulated renders re-extract signals + re-simulate. Backend hash
  cache makes a re-press of an unchanged graph instant. Optionally compute the
  frontend `graphHash` to disable Render when nothing changed since the last render.
- **Output wiring:** `videoUrl` flows into the `OutputNode` via `renderAnimNode`.
- **Per-segment isolation:** `graph` comes straight from `segment.graph`; switching
  segments in the rail swaps the graph automatically (no extra state). `videoUrl`
  resets on segment change (key the container by `segment.id`).

### Persistence

- `onGraphChange` patches `segment.graph` in App's `segments` → the existing 800 ms
  autosave (`App.jsx:31–47`) serializes it (via `04`'s `serializeSegments`) → PUT
  `/projects/<job>` → `db.save_segments` stores it in the JSONB tree. **No new
  persistence code.** Confirm the autosave runs in `step==="studio"` (it does).
- `graph.view` (pan/zoom) is part of the graph, so it persists too; exclude it from
  the render hash (`01` §3.6) so panning doesn't trigger re-render eligibility.

### Default scaffold

When a segment's `graph` is null and the user first opens the animation tab, leave
it empty (just the palette) — do **not** auto-populate. The user adds a Fluid +
Output when ready. (Optional nicety: a one-click "start" that drops a Fluid+Output
pre-wired; defer.)

## Reuse

- `Studio.jsx` rail + `editActiveSignals`/`setSegments` patterns.
- Autosave loop — `App.jsx` (unchanged).
- `api.renderGraph` (`04`), `validate`/`emptyGraph` (`04`), `GraphCanvas` (`05`),
  nodes + `Palette` (`06`).

## Acceptance criteria

- [ ] A bottom bar switches the studio pane between signals and animation, keeping
      the active segment; the rail still selects segments for both.
- [ ] Building a graph + pressing Render produces a looping video in the Output card
      within a couple seconds; the wired params visibly track the music.
- [ ] The graph (and view) persists: reload the project, return to the segment's
      animation tab, and the nodes/wires/positions are intact.
- [ ] Switching segments swaps to that segment's graph; each segment is independent.
- [ ] An invalid graph surfaces a clear inline error instead of rendering.

## Verification (two-audience)

**Fixture/seed data:** a real project + segment with signals (from `make dev`).

**Agent check:** `cd frontend && npm run build && npm run lint`. A vitest for
`AnimationCanvas` render state machine is optional (it's mostly integration); rely
on the manual loop + the backend tests from `03`.

**User check (the headline demo):**
1. `make dev`, open a project → studio → pick a segment → bottom bar **create
   animation**.
2. Add **Fluid** + **Output**; wire Fluid → Output.
3. Add a **Signal** card (e.g. drums kick energy); wire it into **force**; set the
   range `lo=0, hi=45`.
4. Press **Render** → a looping clip appears in Output whose jet pulses with the
   kick.
5. Reload the page, reopen the segment's animation tab → the graph is exactly as
   left. Switch to another segment → its own (empty or different) graph shows.

## Risks & open questions

- **Tab state location** — kept inside `Studio` to avoid touching App much; if other
  screens later need the mode, lift to App then.
- **Stale videoUrl across edits** — after editing the graph, the shown video is the
  previous render until Render is pressed again; consider a subtle "out of date"
  badge (compare current `graphHash` to the rendered one). Nice-to-have.
- **Autosave of `view`** — frequent pan/zoom could churn autosave; debounce
  `graph.view` writes (or omit `view` from the autosave payload and keep it
  session-only). Decide here; session-only is simplest.
