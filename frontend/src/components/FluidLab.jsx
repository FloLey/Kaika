import { useEffect, useMemo, useRef, useState } from "react";
import SharedCtl, { Toggle as SharedToggle } from "./Ctl.jsx";
import { clamp } from "../mel.js";
import { runFluid } from "../api.js";

const HELP = {
  duration: "Length of the simulation (seconds) that gets computed and looped.",
  enabled: "Turn the centre source on/off. Off = no new dye; existing dye drifts and fades.",
  emit: "How much dye the source releases each frame.",
  radius: "Size of the source splat (fraction of the canvas).",
  force: "Strength of the jet the source pushes into the fluid.",
  angle: "Starting direction the jet pushes (0°=right, 90°=down, 270°=up). Ignored when radial is on.",
  rot_speed: "How fast the jet direction rotates over time (degrees per second). + = clockwise.",
  rot_accel: "How fast the rotation speeds up over time (degrees per second²) — the jet winds up into a spiral.",
  radial: "Push outward in all directions from the centre instead of one heading.",
  r: "Red component of the dye color.",
  g: "Green component of the dye color.",
  b: "Blue component of the dye color.",
  intensity: "Brightness of the dye (HDR multiplier on the color — higher glows harder).",
  opacity: "How much the dye shows over the background (lower = more see-through / fainter).",
  path_speed: "How fast the source travels the points — number of full trips along the path over the clip (0 = stay on the first point).",
  path_closed: "Close the loop: link the last point back to the first so the source goes round and round your points.",
  path_pingpong: "Go back and forth along the points instead of looping (ignored when closed).",
  dissipation: "How fast the dye fades (lower = fades faster).",
  velocity_dissipation: "How fast the flow loses momentum (lower = calms faster).",
  viscosity: "Thickness — smooths the velocity field (higher = gooier).",
  vorticity: "Swirl: re-energizes little vortices (higher = more curl).",
};

// Which guide section each control's "?" deep-links to (see Docs.jsx ids).
const SECTION = {
  emit: "fluid-source", radius: "fluid-source", force: "fluid-source",
  angle: "fluid-source", rot_speed: "fluid-source", rot_accel: "fluid-source",
  radial: "fluid-source", enabled: "fluid-source", r: "fluid-source",
  g: "fluid-source", b: "fluid-source", intensity: "fluid-source",
  opacity: "fluid-source",
  path_speed: "fluid-path", path_closed: "fluid-path", path_pingpong: "fluid-path",
  dissipation: "fluid-medium", velocity_dissipation: "fluid-medium",
  viscosity: "fluid-medium", vorticity: "fluid-medium",
};
const sectionFor = (k) => SECTION[k] || "fluid-lab";

// Thin adapters over the shared controls: FluidLab keys every param by `k` and
// its `onChange` is `(k, value)`, so we bind the key and look up help/section.
function Ctl({ label, k, value, min, max, step, onChange, fmt }) {
  return (
    <SharedCtl label={label} value={value} min={min} max={max} step={step} fmt={fmt}
               help={HELP[k]} section={sectionFor(k)} onChange={(v) => onChange(k, v)} />
  );
}

function Toggle({ label, k, value, onChange }) {
  return (
    <SharedToggle label={label} value={value} help={HELP[k]} section={sectionFor(k)}
                  onChange={(v) => onChange(k, v)} />
  );
}

// Standalone fluid playground: a centered source in a black square; the sim is
// computed in the backend and looped here. Controls re-run it (debounced) with a
// flash-free double-buffered video swap.
export default function FluidLab({ onBack }) {
  const [p, setP] = useState({
    duration: 10, enabled: true, emit: 0.3, radius: 0.08, force: 20, angle: 270,
    rot_speed: 0, rot_accel: 0, radial: false,
    r: 70, g: 176, b: 255, intensity: 1.0, opacity: 1.0,
    points: [[0.5, 0.5]], path_speed: 1, path_closed: false, path_pingpong: false,
    dissipation: 0.95, velocity_dissipation: 0.97, viscosity: 0.0, vorticity: 6,
  });
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(0);
  const [showPath, setShowPath] = useState(true);
  const visibleRef = useRef(0);
  const vids = [useRef(null), useRef(null)];
  const reqId = useRef(0);

  const set = (k, v) => setP((s) => ({ ...s, [k]: v }));

  // --- source path editor (click stage to add, drag markers, dbl-click remove) ---
  const stageRef = useRef(null);
  const normCoord = (e) => {
    const r = stageRef.current.getBoundingClientRect();
    return [clamp((e.clientX - r.left) / r.width, 0, 1),
            clamp((e.clientY - r.top) / r.height, 0, 1)];
  };
  const addPoint = (e) => {
    if (e.target !== e.currentTarget) return;       // ignore clicks on a marker
    const c = normCoord(e);
    setP((s) => ({ ...s, points: [...s.points, c] }));
  };
  const onMarkerDown = (idx, e) => {
    e.stopPropagation();
    let moved = false;
    const move = (ev) => {
      moved = true;
      setP((s) => {
        const pts = s.points.slice();
        pts[idx] = normCoord(ev);
        return { ...s, points: pts };
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      // Click (no drag) on the FIRST point closes/opens the loop, like a
      // polygon tool. Needs at least a triangle.
      if (!moved && idx === 0) {
        setP((s) => (s.points.length > 2
          ? { ...s, path_closed: !s.path_closed } : s));
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const removePoint = (idx) =>
    setP((s) => (s.points.length > 1
      ? { ...s, points: s.points.filter((_, i) => i !== idx) } : s));
  const resetPath = () => setP((s) => ({ ...s, points: [[0.5, 0.5]] }));

  const params = useMemo(() => ({
    duration: p.duration, fps: 24, grid: 96,
    source: { emit: p.emit, radius: p.radius, force: p.force, angle: p.angle,
              rot_speed: p.rot_speed, rot_accel: p.rot_accel, radial: p.radial,
              enabled: p.enabled, color: [p.r / 255, p.g / 255, p.b / 255],
              intensity: p.intensity, opacity: p.opacity, points: p.points,
              path_speed: p.path_speed, path_closed: p.path_closed,
              path_pingpong: p.path_pingpong },
    fluid: { dissipation: p.dissipation, velocity_dissipation: p.velocity_dissipation,
             viscosity: p.viscosity, vorticity: p.vorticity },
  }), [p]);
  const key = JSON.stringify(params);

  useEffect(() => {
    const id = ++reqId.current;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const { url } = await runFluid(params);
        if (id !== reqId.current) return;        // a newer request superseded us
        const back = 1 - visibleRef.current;
        const el = vids[back].current;
        const onReady = () => {
          el.removeEventListener("canplay", onReady);
          if (id !== reqId.current) return;
          visibleRef.current = back;
          setVisible(back);
          setBusy(false);
        };
        el.addEventListener("canplay", onReady);
        el.src = url;
        el.load();
        el.play().catch(() => {});
      } catch (e) {
        if (id === reqId.current) { setError(e.message); setBusy(false); }
      }
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <div className="step fluid-lab">
      <div className="results-head">
        <span className="section-title">FLUID LAB · centered source</span>
        <button className="btn" onClick={onBack}>↩ projects</button>
      </div>

      <div className="fluid-wrap">
        <div className="fluid-left">
          <div className="fluid-stage">
            {[0, 1].map((i) => (
              <video
                key={i}
                ref={vids[i]}
                className="fluid-video"
                style={{ opacity: visible === i ? 1 : 0 }}
                loop muted autoPlay playsInline
              />
            ))}
            {showPath && (
              <div className="fluid-overlay" ref={stageRef} onPointerDown={addPoint}>
                <svg className="fluid-path" viewBox="0 0 100 100" preserveAspectRatio="none">
                  {p.points.length > 1 && (() => {
                    const pts = p.points.map(([x, y]) => `${x * 100},${y * 100}`).join(" ");
                    return p.path_closed
                      ? <polygon points={pts} fill="none" />
                      : <polyline points={pts} fill="none" />;
                  })()}
                </svg>
                {p.points.map(([x, y], i) => (
                  <div
                    key={i}
                    className={"fluid-marker" + (i === 0 ? " first" : "")}
                    style={{ left: x * 100 + "%", top: y * 100 + "%" }}
                    onPointerDown={(e) => onMarkerDown(i, e)}
                    onContextMenu={(e) => { e.preventDefault(); removePoint(i); }}
                    title={i === 0
                      ? "first point — drag to move · click to close/open the loop · right-click to remove"
                      : `point ${i + 1} — drag to move · right-click to remove`}
                  >
                    {i + 1}
                  </div>
                ))}
              </div>
            )}
            {busy && <div className="fluid-busy">simulating…</div>}
            {error && <div className="fluid-err">{error}</div>}
          </div>
          <div className="fluid-stagebar">
            <button className="btn sm" onClick={() => setShowPath((v) => !v)}>
              {showPath ? "🙈 hide points" : "👁 show points"}
            </button>
          </div>
        </div>

        <div className="fluid-ctls">
          <Ctl label="sim time" k="duration" value={p.duration} min={2} max={30} step={1}
               onChange={set} fmt={(v) => v + "s"} />
          <div className="ctl-sep">SOURCE</div>
          <Toggle label="enabled" k="enabled" value={p.enabled} onChange={set} />
          <Ctl label="emit" k="emit" value={p.emit} min={0} max={1} step={0.02}
               onChange={set} fmt={(v) => v.toFixed(2)} />
          <Ctl label="radius" k="radius" value={p.radius} min={0.02} max={0.3} step={0.01}
               onChange={set} fmt={(v) => v.toFixed(2)} />
          <Ctl label="force" k="force" value={p.force} min={0} max={60} step={1}
               onChange={set} />
          <Ctl label="angle" k="angle" value={p.angle} min={0} max={360} step={5}
               onChange={set} fmt={(v) => v + "°"} />
          <Ctl label="rot speed" k="rot_speed" value={p.rot_speed} min={-180} max={180} step={5}
               onChange={set} fmt={(v) => v + "°/s"} />
          <Ctl label="rot accel" k="rot_accel" value={p.rot_accel} min={-90} max={90} step={5}
               onChange={set} fmt={(v) => v + "°/s²"} />
          <Toggle label="radial" k="radial" value={p.radial} onChange={set} />

          <div className="ctl-sep">COLOR (4 axes)</div>
          <Ctl label="red" k="r" value={p.r} min={0} max={255} step={1} onChange={set} />
          <Ctl label="green" k="g" value={p.g} min={0} max={255} step={1} onChange={set} />
          <Ctl label="blue" k="b" value={p.b} min={0} max={255} step={1} onChange={set} />
          <Ctl label="intensity" k="intensity" value={p.intensity} min={0} max={3} step={0.1}
               onChange={set} fmt={(v) => v.toFixed(1)} />
          <Ctl label="opacity" k="opacity" value={p.opacity} min={0} max={1} step={0.05}
               onChange={set} fmt={(v) => v.toFixed(2)} />
          <div className="ctl swatch-row">
            <span className="ctl-label">swatch</span>
            <div className="color-swatch" style={{ background: `rgb(${p.r}, ${p.g}, ${p.b})` }} />
          </div>

          <div className="ctl-sep">PATH · click stage = add · drag = move · click 1st point = close · right-click = remove</div>
          <div className="ctl path-row">
            <span className="ctl-label">points</span>
            <span className="ctl-val">{p.points.length}{p.path_closed ? " ⟳" : ""}</span>
            <button className="btn sm" onClick={resetPath}>reset to center</button>
          </div>
          <Ctl label="path speed" k="path_speed" value={p.path_speed} min={0} max={8} step={0.5}
               onChange={set} fmt={(v) => v.toFixed(1) + "×"} />
          <Toggle label="ping-pong" k="path_pingpong" value={p.path_pingpong} onChange={set} />

          <div className="ctl-sep">MEDIUM</div>
          <Ctl label="dissip." k="dissipation" value={p.dissipation} min={0.85} max={0.995} step={0.005}
               onChange={set} fmt={(v) => v.toFixed(3)} />
          <Ctl label="vel diss." k="velocity_dissipation" value={p.velocity_dissipation} min={0.85} max={0.995} step={0.005}
               onChange={set} fmt={(v) => v.toFixed(3)} />
          <Ctl label="viscosity" k="viscosity" value={p.viscosity} min={0} max={0.5} step={0.02}
               onChange={set} fmt={(v) => v.toFixed(2)} />
          <Ctl label="vorticity" k="vorticity" value={p.vorticity} min={0} max={10} step={0.5}
               onChange={set} fmt={(v) => v.toFixed(1)} />
        </div>
      </div>
    </div>
  );
}
