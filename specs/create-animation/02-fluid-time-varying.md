# 02 — Backend: time-varying fluid simulation

> Refactor `fluid.simulate()` so each modulatable parameter accepts a **scalar or a
> per-frame array**. This is what lets a signal animate a parameter over the clip.
> Backward-compatible: the existing scalar path (and FluidLab) is untouched.

## Goal

Make `simulate(params)` read each modulatable param **per frame** when given an
array of length `nframes`, while still accepting a plain scalar (current
behavior). No new dependencies, no API surface change for existing callers.

## Why / context

Today `simulate()` reads each param once before the frame loop
(`backend/fluid.py:158–180`) and `FluidSim` holds `dissipation/vorticity/...` as
fixed attributes. The graph executor (`03`) needs to pass, e.g.,
`source.force = [v0, v1, …, v_{nframes-1}]` so the jet pulses with a drum signal.
This step adds that capability in isolation so it can be tested with a tiny Python
snippet before the executor or any UI exists.

## Files

- **Modify** `backend/fluid.py` — `simulate()` frame loop + a `_series` helper;
  set `FluidSim` medium params per step.
- *(No route changes here; `/animate` is added in `03`.)*

## Design detail

### Per-frame resolution helper

Add near the top of `fluid.py`:

```python
def _series(x, nframes: int) -> np.ndarray:
    """Coerce a scalar or sequence into a float32 array of length nframes.
    Scalars broadcast; sequences are linearly resampled to nframes."""
    if np.isscalar(x):
        return np.full(nframes, float(x), np.float32)
    arr = np.asarray(x, np.float32).ravel()
    if arr.size == 0:
        return np.zeros(nframes, np.float32)
    if arr.size == nframes:
        return arr
    # linear resample onto nframes (signals arrive at their own fps)
    xs = np.linspace(0.0, 1.0, arr.size)
    xt = np.linspace(0.0, 1.0, nframes)
    return np.interp(xt, xs, arr).astype(np.float32)
```

> The executor (`03`) already resamples signal curves to `nframes`; `_series`
> resampling is a safety net and lets callers pass arbitrary-length arrays.

### Modulatable params → per-frame arrays

In `simulate()`, after computing `nframes`, replace the scalar reads for the
modulatable params with arrays. Keep the existing scalar reads as the values fed
to `_series` (so omitted params keep their defaults):

```python
# was: emit = float(src.get("emit", 0.3)) ; force = float(src.get("force", 20.0)) ; ...
emit_s   = _series(src.get("emit", 0.3),   nframes)
radius_s = _series(src.get("radius", 0.08), nframes)
force_s  = _series(src.get("force", 20.0), nframes)
angle_s  = _series(src.get("angle", 270.0), nframes)
rotsp_s  = _series(src.get("rot_speed", 0.0), nframes)
rotac_s  = _series(src.get("rot_accel", 0.0), nframes)
inten_s  = _series(src.get("intensity", 1.0), nframes)
opac_s   = _series(src.get("opacity", 1.0), nframes)
diss_s   = _series(fl.get("dissipation", 0.95), nframes)
vdis_s   = _series(fl.get("velocity_dissipation", 0.97), nframes)
visc_s   = _series(fl.get("viscosity", 0.0), nframes)
vort_s   = _series(fl.get("vorticity", 5.0), nframes)
```

`color` stays computed once (static in v1); `intensity`/`opacity` now multiply
**per frame** (so brightness can pulse):

```python
base_color = ... # the [r,g,b] array as today (without intensity/opacity)
```

### Frame loop changes

Within `for i in range(nframes):`

```python
# medium params can change each frame -> set on the sim before stepping
sim.dissipation     = float(diss_s[i])
sim.vel_dissipation = float(vdis_s[i])
sim.viscosity       = float(visc_s[i])
sim.vorticity       = float(vort_s[i])

if enabled:
    px, py = pos_at(i / denom)
    ts = i / fps
    ang = np.deg2rad(angle_s[i] + rotsp_s[i] * ts + 0.5 * rotac_s[i] * ts * ts)
    color_i = base_color * inten_s[i] * opac_s[i]
    sim.add_dye(px, py, radius_s[i], color_i, emit_s[i])
    f = force_s[i] * 0.02
    if radial:
        sim.add_radial(px, py, radius_s[i], f)
    elif f:
        sim.add_force(px, py, radius_s[i], np.cos(ang) * f, np.sin(ang) * f)
sim.step()
frames[i] = _tonemap(sim.dens)
```

`FluidSim.step()` already reads `self.dissipation/vel_dissipation/viscosity/
vorticity` each call (`fluid.py:110–127`), so setting them per frame Just Works —
no change to `FluidSim` needed beyond keeping those as mutable attributes (they
already are).

### Backward compatibility

- Scalars passed by FluidLab/`/fluid` flow through `_series` → constant arrays →
  identical output. **Confirm bit-for-bit** isn't required, but visually identical
  and numerically near-identical (the only change is reading `arr[i]` of a constant
  array vs a scalar).
- `angle` rotation math is preserved exactly when `rot_speed/rot_accel` are scalar.

## Reuse

- `_series` uses only `numpy` (already imported).
- `_tonemap`, `add_dye`, `add_force`, `add_radial`, `pos_at`, `FluidSim` — all
  existing in `backend/fluid.py`.

## Acceptance criteria

- [ ] `simulate()` accepts arrays for every key in the `02` list and reads them per
      frame; scalars still work.
- [ ] Passing a constant array equals passing the scalar (visually identical clip).
- [ ] No new imports/deps; `FluidLab` + `/fluid` behavior unchanged.
- [ ] A modulated `force` produces a clip whose jet strength visibly varies over
      time.

## Verification (two-audience)

**Fixture/seed data:** none needed — self-contained Python.

**Agent check** — add/keep a throwaway snippet or a `pytest` (folded into `09`):

```bash
.venv/bin/python - <<'PY'
import numpy as np
from backend import fluid
nf = 48
# constant-array == scalar
a,_,_ = fluid.simulate({"duration":2,"fps":24,"grid":48,
    "source":{"force":20,"color":[0.3,0.7,1]}, "fluid":{}})
b,_,_ = fluid.simulate({"duration":2,"fps":24,"grid":48,
    "source":{"force":[20]*nf,"color":[0.3,0.7,1]}, "fluid":{}})
assert a.shape == b.shape
print("scalar≈array mean abs diff:", np.abs(a.astype(int)-b.astype(int)).mean())
# ramped force renders without error
ramp = list(np.linspace(0,60,nf))
c,fps,n = fluid.simulate({"duration":2,"fps":24,"grid":48,
    "source":{"force":ramp,"color":[0.3,0.7,1]}, "fluid":{}})
fluid.render_mp4(c, fps, __import__("pathlib").Path("/tmp/anim_ramp.mp4"))
print("ramp ok ->", c.shape, "/tmp/anim_ramp.mp4")
PY
```
Expect: tiny mean abs diff (constant array ≈ scalar), and `/tmp/anim_ramp.mp4`
written.

**User check:** open `/tmp/anim_ramp.mp4` — the jet should start weak and grow
stronger over the 2 s (force ramps 0→60). Also open the app's existing **fluid
lab** and confirm it still behaves exactly as before (no regression).

## Risks & open questions

- **Resample direction** — signals may be longer/shorter than `nframes`; `_series`
  linear-interpolates. The executor (`03`) extracts at the fluid fps when possible
  to avoid resampling artifacts.
- **Per-frame `viscosity`** — viscosity runs a smoothing loop each step; large
  modulated values are still bounded by the existing stability clamps in `step()`.
- **Performance** — array indexing per frame is negligible vs the FFT solve; grid
  stays 96. No measurable slowdown expected.
