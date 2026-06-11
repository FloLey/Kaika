"""Recipe model v2 — the creative lever.

A recipe is a YAML file that **fully** describes the render: canvas dimensions,
analysis settings, solver field, emitters (trigger / placement / color / body),
modulators (signal -> parameter routing), timeline defaults, rendering, palettes,
per-section prompts and diffusion parameters. Nothing visual lives only in code:
every former engine constant is a recipe field with the old constant as default.

v1 recipes (no ``version`` key, ``fluid:``/``splats:`` blocks) are upgraded in
memory to the equivalent v2 document — see :func:`upgrade_v1`.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict, fields, is_dataclass
from pathlib import Path
from typing import Dict, List, Optional, get_type_hints, get_origin, get_args

import os

import yaml

RECIPE_VERSION = 2


def _find_recipes_dir() -> Path:
    """Locate recipes for both editable (repo) and wheel (packaged) installs."""
    env = os.environ.get("KAIKA_RECIPES")
    candidates = [Path(env)] if env else []
    pkg = Path(__file__).resolve().parents[1]          # .../kaika
    candidates += [pkg / "recipes",                    # packaged (wheel)
                   Path(__file__).resolve().parents[3] / "recipes"]  # repo (dev)
    for c in candidates:
        if c.is_dir():
            return c
    return candidates[-1]


RECIPES_DIR = _find_recipes_dir()

# ---------------------------------------------------------------------------
# Canvas + analysis
# ---------------------------------------------------------------------------

def fft_friendly(n: int) -> int:
    """Round ``n`` to the nearest integer whose prime factors are only 2/3/5,
    so the FFT Poisson projection stays fast on rectangular grids."""
    def ok(k: int) -> bool:
        for p in (2, 3, 5):
            while k % p == 0:
                k //= p
        return k == 1
    lo, hi = n, n
    while lo > 8 or hi < 4 * n:
        if ok(hi):
            return hi
        if lo > 8 and ok(lo):
            return lo
        lo -= 1
        hi += 1
    return n


@dataclass
class Canvas:
    """Output dimensions & framerate. ``sim_resolution`` is the number of
    simulation cells on the SHORT side; the long side scales with the aspect
    ratio, rounded to an FFT-friendly size."""
    width: int = 1024
    height: int = 1024
    fps: int = 24
    sim_resolution: int = 256

    def grid(self) -> tuple:
        """(grid_h, grid_w) simulation cells."""
        s = max(16, int(self.sim_resolution))
        if self.width >= self.height:
            h = s
            w = fft_friendly(int(round(s * self.width / max(1, self.height))))
        else:
            w = s
            h = fft_friendly(int(round(s * self.height / max(1, self.width))))
        return h, w

    def render_size(self, cap_short: Optional[int] = None) -> tuple:
        """(render_h, render_w) output pixels, optionally capped (draft)."""
        w, h = int(self.width), int(self.height)
        if cap_short:
            short = min(w, h)
            if short > cap_short:
                k = cap_short / short
                w, h = int(round(w * k)), int(round(h * k))
        return max(2, h - h % 2), max(2, w - w % 2)


@dataclass
class AnalysisConfig:
    bands: List[float] = field(default_factory=lambda: [150.0, 4000.0])
    onset_delta: float = 0.10
    onset_wait: int = 4


# ---------------------------------------------------------------------------
# Field + render
# ---------------------------------------------------------------------------

@dataclass
class Ambient:
    strength: float = 1.6       # curl-noise stirring amplitude (cells/frame)
    scale: float = 2.6          # spatial frequency of the noise
    speed: float = 0.16         # temporal evolution per frame


@dataclass
class FieldConfig:
    dissipation: float = 0.90
    velocity_dissipation: float = 0.96
    viscosity: float = 0.0
    vorticity: float = 8.0          # base value; modulators move it
    vorticity_gain: float = 0.015   # was VORT_K
    force_gain: float = 0.04        # was FORCE_K
    ambient: Ambient = field(default_factory=Ambient)
    density_clamp: float = 12.0


@dataclass
class Bloom:
    amount: float = 0.65
    threshold: float = 0.45
    sigma: float = 0.0              # 0 = auto (resolution / 48)


# ---------------------------------------------------------------------------
# Emitters
# ---------------------------------------------------------------------------

TRIGGER_TYPES = ("onset", "beat", "continuous", "lookahead", "manual")
PLACEMENT_TYPES = ("fixed", "random", "wander", "line", "circle", "grid",
                   "signal_x", "signal_y")
DIRECTION_TYPES = ("radial_out", "radial_in", "fixed", "random", "flow")
COLOR_TYPES = ("fixed", "palette", "palette_cycle", "palette_random",
               "chroma_hue", "chroma_palette", "centroid_ramp")
SIGNALS = ("rms", "centroid", "flux", "beat_phase", "bar_phase",
           "harmonic_ratio", "chroma_argmax", "band.low", "band.mid",
           "band.high", "section.energy", "voice")
MOD_MODES = ("absolute", "add", "scale")
MOD_CURVES = ("linear", "smoothstep")       # plus pow(k) / step(t), parsed


@dataclass
class Trigger:
    type: str = "onset"
    band: str = "low"               # onset: low | mid | high
    min_mag: float = 0.0
    max_per_frame: int = 0          # 0 = unlimited
    every: int = 1                  # beat: 1 = every beat, 4 = once per bar
    offset: int = 0                 # beat index offset
    every_frames: int = 3           # continuous / lookahead cadence
    when: str = ""                  # continuous condition, e.g. "rms > 0.5"
    mag_source: str = ""            # continuous: spawn magnitude follows this
                                    # signal (sustained content breathes);
                                    # min_mag gates weak frames out
    section: str = "drop"           # lookahead target / continuous filter
    window_s: float = 8.0           # lookahead window


@dataclass
class Placement:
    type: str = "random"
    points: List[List[float]] = field(default_factory=list)  # fixed / line ends
    region: List[float] = field(default_factory=lambda: [0.05, 0.05, 0.95, 0.95])
    center: List[float] = field(default_factory=lambda: [0.5, 0.5])
    wander_amp: float = 0.16        # was WANDER_AMP
    jitter: float = 0.09            # was KICK_JITTER
    wander_freq: float = 1.0
    radius: float = 0.25            # circle
    arc_deg: float = 360.0
    rows: int = 2                   # grid
    cols: int = 2
    source: str = "rms"             # signal_x / signal_y driver
    range: List[float] = field(default_factory=lambda: [0.1, 0.9])
    x: float = 0.5                  # fixed other axis (signal_y)
    y: float = 0.5                  # fixed other axis (signal_x)


@dataclass
class Direction:
    type: str = "radial_out"
    angle_deg: float = 0.0
    jitter: float = 0.5             # radians; was KICK_ANGLE_JITTER


@dataclass
class Brightness:
    source: str = "fixed"           # fixed | centroid | rms
    value: float = 1.0
    range: List[float] = field(default_factory=lambda: [0.75, 1.25])


@dataclass
class ColorSpec:
    type: str = "palette"
    hex: str = "#FFFFFF"            # fixed
    palette: str = "main"
    index: int = 0                  # palette
    start: int = 1                  # palette_cycle
    saturation: float = 0.7         # chroma_hue
    value: float = 0.9
    hue_offset: float = 0.0
    dark: str = "#1B2740"           # centroid_ramp endpoints
    bright: str = "#FFE3B0"
    min_hold_s: float = 0.2         # chroma hold window (anti-flicker)
    opacity: float = 1.0
    brightness: Brightness = field(default_factory=Brightness)


@dataclass
class Body:
    radius: float = 0.08
    force: float = 6000.0
    lifetime_s: float = 0.5
    emit: float = 0.2
    drift: float = 0.4
    speed: float = 1.5
    jet_fraction: float = 0.35      # was JET_FRACTION
    decay: float = 1.3              # was SOURCE_DECAY
    expand: float = 0.8             # was SOURCE_EXPAND
    mag_gain: float = 1.0


@dataclass
class RenderConfig:
    exposure: float = 1.9
    bloom: Bloom = field(default_factory=Bloom)
    background: float = 0.04        # tint intensity (0 = pure black)
    # The background is a full audio-drivable color, not just a grey level:
    # any emitter color type works (fixed / palette / chroma_hue /
    # chroma_palette / centroid_ramp), smoothed so the wash evolves gently.
    # Vivid endpoints: the visible tint is background * color, so at level
    # ~0.08 these read as a deep blue <-> warm plum wash, never grey-black.
    background_color: ColorSpec = field(default_factory=lambda: ColorSpec(
        type="centroid_ramp", dark="#3350A0", bright="#A05A72"))
    background_smooth_s: float = 1.5
    gamma: float = 1.15


@dataclass
class Emitter:
    id: str = "emitter"
    enabled: bool = True
    count: int = 1
    trigger: Trigger = field(default_factory=Trigger)
    placement: Placement = field(default_factory=Placement)
    direction: Direction = field(default_factory=Direction)
    color: ColorSpec = field(default_factory=ColorSpec)
    body: Body = field(default_factory=Body)


@dataclass
class Modulator:
    source: str = "rms"
    target: str = "field.vorticity"
    range: List[float] = field(default_factory=lambda: [0.0, 1.0])
    mode: str = "absolute"          # absolute | add | scale
    curve: str = "linear"           # linear | pow(k) | smoothstep | step(t)
    smooth_s: float = 0.0
    apply_to: str = "spawn"         # reserved; only "spawn" implemented in v2


# ---------------------------------------------------------------------------
# Diffusion / post / recipe
# ---------------------------------------------------------------------------

@dataclass
class DiffusionConfig:
    model: str = "wan-2.2-vace"
    backend: str = "local"          # "local" (no-GPU fallback) | "comfyui"
    strength: float = 0.5
    control: List[str] = field(default_factory=lambda: ["depth", "flow"])
    chunk_s: float = 5.0
    overlap_frames: int = 24


@dataclass
class PostConfig:
    upscale: bool = False
    interpolate: bool = False
    grain: float = 0.0              # 0..1 film grain on the final
    vignette: float = 0.0           # 0..1 vignette strength on the final


def _default_emitters() -> List[Emitter]:
    """The v2 default mapping: kicks (low), hats (high), melody (mid, pitch ->
    x position + chroma color), tension (pre-drop lookahead)."""
    return [
        Emitter(id="kicks",
                trigger=Trigger(type="onset", band="low"),
                placement=Placement(type="wander", center=[0.5, 0.5],
                                    wander_amp=0.16, jitter=0.09),
                direction=Direction(type="radial_out", jitter=0.5),
                color=ColorSpec(type="palette", palette="main", index=0),
                body=Body(radius=0.10, force=9000.0, lifetime_s=0.8, emit=0.22,
                          drift=0.7, speed=1.3)),
        Emitter(id="hats",
                trigger=Trigger(type="onset", band="high", max_per_frame=5),
                placement=Placement(type="random",
                                    region=[0.08, 0.08, 0.92, 0.92]),
                direction=Direction(type="random", jitter=0.0),
                color=ColorSpec(type="palette_cycle", palette="main", start=1,
                                brightness=Brightness(source="centroid",
                                                      range=[0.75, 1.25])),
                body=Body(radius=0.03, force=3500.0, lifetime_s=0.3, emit=0.11,
                          drift=0.3, speed=2.6)),
        Emitter(id="melody",
                trigger=Trigger(type="onset", band="mid", min_mag=0.25),
                placement=Placement(type="signal_x", source="chroma_argmax",
                                    range=[0.1, 0.9], y=0.3),
                direction=Direction(type="fixed", angle_deg=90.0, jitter=0.2),
                color=ColorSpec(type="chroma_palette", palette="main"),
                body=Body(radius=0.05, force=4000.0, lifetime_s=0.6, emit=0.13,
                          drift=0.5, speed=1.8)),
        # Sustained content (vocals, pads) is harmonic — onsets never fire on
        # it. This emitter paints continuously, magnitude following the
        # "voice" signal (harmonic mid-band energy), position following pitch.
        Emitter(id="voice",
                trigger=Trigger(type="continuous", every_frames=4,
                                mag_source="voice", min_mag=0.25, section=""),
                placement=Placement(type="signal_x", source="chroma_argmax",
                                    range=[0.15, 0.85], y=0.6, jitter=0.04),
                direction=Direction(type="flow", jitter=0.4),
                color=ColorSpec(type="chroma_palette", palette="main"),
                body=Body(radius=0.07, force=1500.0, lifetime_s=1.0, emit=0.14,
                          drift=0.9, speed=0.5)),
        Emitter(id="tension",
                trigger=Trigger(type="lookahead", section="drop", window_s=8.0,
                                every_frames=3),
                placement=Placement(type="random", region=[0.2, 0.2, 0.8, 0.8]),
                direction=Direction(type="random", jitter=0.0),
                color=ColorSpec(type="palette", palette="main", index=0,
                                brightness=Brightness(source="fixed", value=0.6)),
                body=Body(radius=0.08, force=1500.0, lifetime_s=0.7, emit=0.10,
                          drift=0.6, speed=0.8)),
    ]


def _default_modulators() -> List[Modulator]:
    """The v1 hardwired couplings, now visible: RMS drives vorticity and the
    ambient stir (with the old 12% floor expressed as the range bottom) —
    plus the background level breathing with loudness."""
    return [
        Modulator(source="rms", target="field.vorticity", range=[8.0, 38.0],
                  mode="absolute"),
        Modulator(source="rms", target="field.ambient.strength",
                  range=[0.192, 1.6], mode="absolute"),
        Modulator(source="rms", target="render.background",
                  range=[0.04, 0.11], mode="absolute", smooth_s=0.4),
    ]


@dataclass
class Recipe:
    version: int = RECIPE_VERSION
    name: str = "default"
    seed: int = 0
    canvas: Canvas = field(default_factory=Canvas)
    analysis: AnalysisConfig = field(default_factory=AnalysisConfig)
    field_: FieldConfig = field(default_factory=FieldConfig)
    render: RenderConfig = field(default_factory=RenderConfig)
    palettes: Dict[str, List[str]] = field(default_factory=lambda: {
        "main": ["#B84A74", "#34808A", "#E0A458", "#6C4A8C", "#3FA39B",
                 "#D98A5E"]})
    emitters: List[Emitter] = field(default_factory=_default_emitters)
    modulators: List[Modulator] = field(default_factory=_default_modulators)
    timeline: List[dict] = field(default_factory=list)   # recipe-shipped defaults
    diffusion: DiffusionConfig = field(default_factory=DiffusionConfig)
    post: PostConfig = field(default_factory=PostConfig)
    prompts: Dict[str, str] = field(default_factory=lambda: {
        "base": "abstract organic motion, soft light",
        "default": "botanical organic forms, abstract motion",
    })

    def prompt_for(self, label: str) -> str:
        """Effective prompt for a section: ``base`` is always prefixed; an
        unknown label falls back to ``default``."""
        base = self.prompts.get("base", "").strip()
        body = self.prompts.get(label) or self.prompts.get("default", "")
        return f"{base}, {body}".strip(", ").strip() if base else body

    def emitter(self, eid: str) -> Optional[Emitter]:
        for e in self.emitters:
            if e.id == eid:
                return e
        return None

    def to_dict(self) -> dict:
        d = asdict(self)
        d["field"] = d.pop("field_")            # YAML/JSON key is "field"
        return d

    def to_yaml(self, path: str | Path) -> None:
        Path(path).write_text(yaml.safe_dump(self.to_dict(), sort_keys=False,
                                              allow_unicode=True))


# ---------------------------------------------------------------------------
# Generic dataclass (re)builder
# ---------------------------------------------------------------------------

def _deep_merge(base: dict, over: dict) -> dict:
    """Recursively overlay ``over`` onto ``base`` (override wins; None skipped)."""
    out = dict(base)
    for k, v in (over or {}).items():
        if v is None:
            continue
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _coerce(ftype, val):
    """Rebuild nested dataclasses / containers-of-dataclasses from plain data."""
    if is_dataclass(ftype) and isinstance(val, dict):
        return _build(ftype, val)
    origin = get_origin(ftype)
    args = get_args(ftype)
    if origin is dict and isinstance(val, dict):
        if len(args) == 2 and is_dataclass(args[1]):
            return {k: (_build(args[1], v) if isinstance(v, dict) else v)
                    for k, v in val.items()}
    if origin is list and isinstance(val, list):
        if len(args) == 1 and is_dataclass(args[0]):
            return [_build(args[0], v) if isinstance(v, dict) else v for v in val]
    return val


def _build(cls, data: dict):
    """Generic dataclass builder: recurse into any nested dataclass field.

    Adding a new nested config requires no change here — type hints drive it.
    Unknown keys are ignored (forward compatibility)."""
    hints = get_type_hints(cls)
    kwargs = {f.name: _coerce(hints.get(f.name, object), data[f.name])
              for f in fields(cls) if f.name in data and data[f.name] is not None}
    return cls(**kwargs)


# ---------------------------------------------------------------------------
# v1 -> v2 upgrade
# ---------------------------------------------------------------------------

def is_v1(d: dict) -> bool:
    return int(d.get("version", 1) or 1) < 2 if d else False


def upgrade_v1(d: dict) -> dict:
    """Translate a v1 recipe dict into the equivalent v2 dict.

    Reproduces the v1 behavior: splats.low -> kicks, splats.high -> hats,
    vorticity {min,max} -> base + rms modulator, lookahead_s -> tension emitter,
    the ambient RMS coupling -> a visible modulator, post.aspect -> canvas."""
    d = d or {}
    fl = d.get("fluid", {}) or {}
    post = d.get("post", {}) or {}
    out: dict = {
        "version": 2,
        "name": d.get("name", "default"),
        "seed": d.get("seed", 0),
        "diffusion": d.get("diffusion", {}) or {},
        "prompts": d.get("prompts", {}) or {},
    }

    # Canvas from post.aspect + fluid resolutions.
    render_res = int(fl.get("render_resolution", 512))
    aspect = post.get("aspect", "square")
    if aspect == "wide":
        w, h = int(round(render_res * 16 / 9)), render_res
    else:
        w = h = render_res
    out["canvas"] = {"width": w, "height": h, "fps": int(post.get("fps", 24)),
                     "sim_resolution": int(fl.get("resolution", 256))}
    out["post"] = {k: v for k, v in post.items() if k not in ("fps", "aspect")}

    # Field.
    amb_strength = float(fl.get("ambient_strength", 1.6))
    out["field"] = {
        "dissipation": fl.get("dissipation", 0.90),
        "velocity_dissipation": fl.get("velocity_dissipation", 0.96),
        "viscosity": fl.get("viscosity", 0.0),
        "vorticity": (fl.get("vorticity", {}) or {}).get("min", 8.0),
        "ambient": {"strength": amb_strength,
                    "scale": fl.get("ambient_scale", 2.6),
                    "speed": fl.get("ambient_speed", 0.16)},
    }
    out["render"] = {
        "exposure": fl.get("exposure", 1.9),
        "bloom": {"amount": fl.get("bloom", 0.65)},
        "background": fl.get("background", 0.04),
    }
    palette = fl.get("palette") or ["#B84A74", "#34808A", "#E0A458", "#6C4A8C",
                                    "#3FA39B", "#D98A5E"]
    out["palettes"] = {"main": list(palette)}

    # Emitters from splats (defaults match the v1 hardcoded behavior).
    splats = fl.get("splats", {}) or {}
    emitters = []
    low = dict(splats.get("low", {}) or {})
    emitters.append({
        "id": "kicks",
        "trigger": {"type": "onset", "band": "low"},
        "placement": {"type": "wander", "center": [0.5, 0.5],
                      "wander_amp": 0.16, "jitter": 0.09},
        "direction": {"type": "radial_out", "jitter": 0.5},
        "color": {"type": "palette", "palette": "main", "index": 0},
        "body": {"radius": low.get("radius", 0.10),
                 "force": low.get("force", 9000.0),
                 "lifetime_s": low.get("lifetime_s", 0.8),
                 "emit": low.get("emit", 0.22),
                 "drift": low.get("drift", 0.7),
                 "speed": low.get("speed", 1.3)},
    })
    high = dict(splats.get("high", {}) or {})
    emitters.append({
        "id": "hats",
        "trigger": {"type": "onset", "band": "high",
                    "max_per_frame": high.get("max_per_beat", 5)},
        "placement": {"type": "random", "region": [0.08, 0.08, 0.92, 0.92]},
        "direction": {"type": "random", "jitter": 0.0},
        "color": {"type": "palette_cycle", "palette": "main", "start": 1,
                  "brightness": {"source": "centroid", "range": [0.75, 1.25]}},
        "body": {"radius": high.get("radius", 0.03),
                 "force": high.get("force", 3500.0),
                 "lifetime_s": high.get("lifetime_s", 0.3),
                 "emit": high.get("emit", 0.11),
                 "drift": high.get("drift", 0.3),
                 "speed": high.get("speed", 2.6)},
    })
    lookahead_s = float(fl.get("lookahead_s", 8.0))
    if lookahead_s > 0:
        emitters.append({
            "id": "tension",
            "trigger": {"type": "lookahead", "section": "drop",
                        "window_s": lookahead_s, "every_frames": 3},
            "placement": {"type": "random", "region": [0.2, 0.2, 0.8, 0.8]},
            "direction": {"type": "random", "jitter": 0.0},
            "color": {"type": "palette", "palette": "main", "index": 0,
                      "brightness": {"source": "fixed", "value": 0.6}},
            "body": {"radius": 0.08, "force": 1500.0, "lifetime_s": 0.7,
                     "emit": 0.10, "drift": 0.6, "speed": 0.8},
        })
    out["emitters"] = emitters

    vort = fl.get("vorticity", {}) or {}
    out["modulators"] = [
        {"source": "rms", "target": "field.vorticity", "mode": "absolute",
         "range": [vort.get("min", 8.0), vort.get("max", 38.0)]},
        {"source": "rms", "target": "field.ambient.strength", "mode": "absolute",
         "range": [0.12 * amb_strength, amb_strength]},
    ]
    return out


# ---------------------------------------------------------------------------
# Normalisation, loading, validation
# ---------------------------------------------------------------------------

_PLACEMENT_ALIASES = {"from": None, "to": None}     # mapped into points


def _normalise_placement(p: dict) -> dict:
    """Accept the spec's ``from``/``to`` line aliases by folding them into
    ``points`` (canonical: points[0] = from, points[1] = to)."""
    if not isinstance(p, dict):
        return p
    p = dict(p)
    if "from" in p or "to" in p:
        pts = list(p.get("points") or [[0.25, 0.5], [0.75, 0.5]])
        while len(pts) < 2:
            pts.append([0.75, 0.5])
        if "from" in p:
            pts[0] = p.pop("from")
        if "to" in p:
            pts[1] = p.pop("to")
        p["points"] = pts
    return p


def _normalise(d: dict) -> dict:
    d = dict(d or {})
    if "field" in d:
        d["field_"] = d.pop("field")
    for e in d.get("emitters", []) or []:
        if isinstance(e, dict) and isinstance(e.get("placement"), dict):
            e["placement"] = _normalise_placement(e["placement"])
    for t in d.get("timeline", []) or []:
        if isinstance(t, dict) and isinstance(t.get("placement"), dict):
            t["placement"] = _normalise_placement(t["placement"])
    return d


def from_dict(d: dict) -> Recipe:
    """Build a Recipe from plain data: v1 docs are upgraded, missing fields
    take defaults, and the result is validated (hard errors raise ValueError)."""
    d = d or {}
    if is_v1(d) and any(k in d for k in ("fluid",)) or ("version" not in d and
                                                        "emitters" not in d):
        d = upgrade_v1(d)
    d = _normalise(d)
    # Replacement semantics for lists: a recipe that *gives* emitters/modulators
    # replaces the defaults entirely (merging lists by index is a trap).
    base = asdict(Recipe())
    base["timeline"] = []
    merged = _deep_merge(base, {k: v for k, v in d.items()
                                if k not in ("emitters", "modulators", "timeline")})
    rec = _build(Recipe, merged)
    if "emitters" in d and d["emitters"] is not None:
        rec.emitters = [_build(Emitter, _fill_emitter(e)) for e in d["emitters"]]
    if "modulators" in d and d["modulators"] is not None:
        rec.modulators = [_build(Modulator, m) for m in d["modulators"]]
    rec.timeline = list(d.get("timeline") or [])
    errors = validate(rec)
    if errors:
        raise ValueError("invalid recipe: " + "; ".join(errors))
    return rec


def _fill_emitter(e: dict) -> dict:
    """Deep-merge a partial emitter spec onto emitter defaults."""
    return _deep_merge(asdict(Emitter()), e or {})


def load_recipe(name_or_path: str | Path) -> Recipe:
    """Load a recipe by file path or by bare name (looked up in ``recipes/``)."""
    p = Path(name_or_path)
    if not p.exists() and p.suffix == "":
        p = RECIPES_DIR / f"{name_or_path}.yaml"
    if not p.exists():
        raise FileNotFoundError(f"recipe not found: {name_or_path}")
    return from_dict(yaml.safe_load(p.read_text()))


# ---- modulator target paths ------------------------------------------------

def config_tree(rec: Recipe) -> dict:
    """The modulatable view of a recipe: field / render plus emitters by id.
    This is the tree segment overrides and modulators address by dot-path."""
    d = rec.to_dict()
    return {
        "field": d["field"],
        "render": d["render"],
        "emitters": {e["id"]: e for e in d["emitters"]},
    }


def resolve_path(tree: dict, path: str):
    """Follow a dot-path into the config tree; returns (parent, key) or None."""
    parts = path.split(".")
    node = tree
    for p in parts[:-1]:
        if not isinstance(node, dict) or p not in node:
            return None
        node = node[p]
    if not isinstance(node, dict) or parts[-1] not in node:
        return None
    return node, parts[-1]


def _parse_curve(curve: str) -> Optional[str]:
    """Return an error string for an invalid curve spec, else None."""
    c = (curve or "linear").strip()
    if c in MOD_CURVES:
        return None
    for prefix in ("pow(", "step("):
        if c.startswith(prefix) and c.endswith(")"):
            try:
                float(c[len(prefix):-1])
                return None
            except ValueError:
                pass
    return f"unknown curve '{curve}' (linear | pow(k) | smoothstep | step(t))"


def validate(rec: Recipe) -> List[str]:
    """Hard validation: everything here would otherwise fail (or silently
    misbehave) inside the engine. Errors are verbatim — the chat copilot
    receives and self-corrects on them."""
    errs: List[str] = []
    if rec.canvas.width < 16 or rec.canvas.height < 16:
        errs.append("canvas.width/height must be >= 16")
    if rec.canvas.fps < 1 or rec.canvas.fps > 120:
        errs.append("canvas.fps must be 1..120")
    seen = set()
    for e in rec.emitters:
        if e.id in seen:
            errs.append(f"duplicate emitter id '{e.id}'")
        seen.add(e.id)
        if e.trigger.type not in TRIGGER_TYPES:
            errs.append(f"emitter '{e.id}': unknown trigger type "
                        f"'{e.trigger.type}' {TRIGGER_TYPES}")
        if e.trigger.type == "onset" and e.trigger.band not in ("low", "mid", "high"):
            errs.append(f"emitter '{e.id}': trigger.band must be low|mid|high")
        if e.trigger.mag_source and e.trigger.mag_source not in SIGNALS:
            errs.append(f"emitter '{e.id}': trigger.mag_source "
                        f"'{e.trigger.mag_source}' is not a signal {SIGNALS}")
        if e.placement.type not in PLACEMENT_TYPES:
            errs.append(f"emitter '{e.id}': unknown placement type "
                        f"'{e.placement.type}' {PLACEMENT_TYPES}")
        if e.direction.type not in DIRECTION_TYPES:
            errs.append(f"emitter '{e.id}': unknown direction type "
                        f"'{e.direction.type}' {DIRECTION_TYPES}")
        if e.color.type not in COLOR_TYPES:
            errs.append(f"emitter '{e.id}': unknown color type "
                        f"'{e.color.type}' {COLOR_TYPES}")
        if e.color.type in ("palette", "palette_cycle", "palette_random",
                            "chroma_palette"):
            if e.color.palette not in rec.palettes:
                errs.append(f"emitter '{e.id}': palette '{e.color.palette}' "
                            f"not in palettes {sorted(rec.palettes)}")
    bc = rec.render.background_color
    if bc.type not in COLOR_TYPES:
        errs.append(f"render.background_color: unknown type '{bc.type}' "
                    f"{COLOR_TYPES}")
    elif bc.type in ("palette", "palette_cycle", "palette_random",
                     "chroma_palette") and bc.palette not in rec.palettes:
        errs.append(f"render.background_color: palette '{bc.palette}' not in "
                    f"palettes {sorted(rec.palettes)}")
    tree = config_tree(rec)
    for i, m in enumerate(rec.modulators):
        if m.apply_to == "live":
            errs.append(f"modulators[{i}]: apply_to 'live' is not implemented "
                        "in v2 (reserved); use 'spawn'")
        elif m.apply_to != "spawn":
            errs.append(f"modulators[{i}]: apply_to must be 'spawn'")
        if m.mode not in MOD_MODES:
            errs.append(f"modulators[{i}]: mode must be one of {MOD_MODES}")
        cerr = _parse_curve(m.curve)
        if cerr:
            errs.append(f"modulators[{i}]: {cerr}")
        base_sig = m.source.split("(")[0]
        if base_sig not in SIGNALS and not m.source.startswith("lookahead"):
            errs.append(f"modulators[{i}]: unknown source '{m.source}' "
                        f"(one of {SIGNALS} or lookahead(label, seconds))")
        hit = resolve_path(tree, m.target)
        if hit is None:
            errs.append(f"modulators[{i}]: target path '{m.target}' does not "
                        "exist (paths are field.* / render.* / "
                        "emitters.<id>.*)")
        else:
            parent, key = hit
            if not isinstance(parent[key], (int, float)) or isinstance(parent[key], bool):
                errs.append(f"modulators[{i}]: target '{m.target}' is not a "
                            "numeric field")
        if len(m.range or []) != 2:
            errs.append(f"modulators[{i}]: range must be [lo, hi]")
    errs.extend(validate_timeline(rec.timeline, prefix="recipe.timeline"))
    return errs


TIMELINE_ACTIONS = ("spawn", "set", "mute", "unmute")


def validate_timeline(timeline: List[dict], prefix: str = "timeline") -> List[str]:
    errs: List[str] = []
    for i, t in enumerate(timeline or []):
        if not isinstance(t, dict):
            errs.append(f"{prefix}[{i}]: must be a mapping")
            continue
        action = t.get("action", "spawn")
        if action not in TIMELINE_ACTIONS:
            errs.append(f"{prefix}[{i}]: unknown action '{action}' "
                        f"{TIMELINE_ACTIONS}")
        if action == "set":
            if "between" not in t or not isinstance(t["between"], list):
                errs.append(f"{prefix}[{i}]: 'set' needs between: [t0, t1]")
            if not isinstance(t.get("set"), dict) or not t.get("set"):
                errs.append(f"{prefix}[{i}]: 'set' needs a set: {{path: value}}")
        elif "at" not in t and "between" not in t:
            errs.append(f"{prefix}[{i}]: needs 'at' (seconds or anchor)")
        if action in ("mute", "unmute") and not t.get("emitter"):
            errs.append(f"{prefix}[{i}]: '{action}' needs an emitter id")
    return errs
