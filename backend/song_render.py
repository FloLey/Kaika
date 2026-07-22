"""Continuous whole-song HD render (the "final export" stage).

Each segment marks one output as "final". This renders the WHOLE song as a single
continuous fluid simulation instead of N independent clips: K persistent `FluidSim`
fields (one per layer number) advance across the entire song, and crossing a segment
boundary only swaps the *rules* (emitters, medium, colours, FX) — the velocity+dye
field carries through unbroken, so transitions are seamless. Layer numbers are the
continuity key: layer `n` in one segment continues into layer `n` of the next; a layer
absent in a segment keeps advecting (fades, no new dye); a new number starts fresh.

Per segment we reuse the EXISTING machinery: `Dag.field_layers` finds the fluid/merge
fields feeding the final output and resolves each one's `simulate()` params (emitters +
medium) exactly as its preview does; a `fluid.LayerInjector` drives the matching
persistent field with segment-local timing. The segment's window is then styled by
feeding those continuous field frames back into its own DAG (`dag._video` pre-seed) so
all the FX / grade / composite / lyrics logic applies per segment. Frames stream into a
single fragmented-mp4 encoder; the song's original audio is muxed at the end. Progress
and cancellation ride on `render_jobs`, same as the per-segment stream.
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
import subprocess
import uuid

import cv2
import numpy as np

from . import fluid, paths, render_cache
from .compositions import final_output_id, root_composition
from .config import ENCODE_TIMEOUT
from .graph_hash import RENDER_VERSION
from .graph_render import Dag, _clip_dims, _grid_dims

log = logging.getLogger("kaika.export")

# Sensible HD defaults when a project hasn't set export settings yet: portrait 1080x1920,
# 30fps, a grid finer than the 'high' preset (144) for a crisp master, and a 1024px
# long edge for the HD regeneration of Image-gen cards. Lives here (not in `routes/`)
# so the routes AND `cache_gc` can read it without importing a blueprint. These values
# are `_export_hash` inputs — changing one invalidates every cached master.
EXPORT_DEFAULTS = {"width": 1080, "height": 1920, "fps": 30, "gridCells": 216, "imageSize": 1024}


def output_from_export(export: dict) -> dict:
    """Export settings -> the `output` dict the render engine takes.

    THE lockstep anchor between the two HD paths: the whole-song export
    (`build_plan`) and the single-segment HD export (`routes/export.segment`)
    both go through here, so a segment's HD preview can't drift from what the
    final master will contain (a test pins the equivalence).

    That claim used to be false in the one way that mattered. `nativeShort` lived in the
    ROUTE's dict, so a sim-free segment rendered at native size for a segment export and on
    the coarse sim grid for the master — which ffmpeg then blew up with nearest-neighbour
    (measured on real projects: 2.1x from 1024x1800, 5.0x from 384x216). It was withheld
    here because ONE encoder spans the whole song and its input geometry is fixed at the
    first write; `build_plan` now sizes that encoder from the largest grid in the plan
    instead of from a constant, so the reason is gone."""
    return {
        "width": int(export.get("width", 1080)),
        "height": int(export.get("height", 1920)),
        "fps": int(export.get("fps", 24)),
        "gridCells": int(export.get("gridCells", 144)),
        # An export is watched full-screen and archived, so it gets the quality CRF while
        # the editor's previews stay light. It rides in the OUTPUT dict rather than being
        # read from `export` at the encoder because `output_hash` folds this dict in
        # whole — changing the quality therefore re-keys every HD cache entry on its own,
        # with no RENDER_VERSION bump and no stale clip encoded at the old setting.
        "crf": fluid.CRF_EXPORT,
        # A sim-free graph renders at the export's NATIVE size, not on a simulation grid —
        # see graph_render._NATIVE_SHORT and _grid_dims.
        "nativeShort": min(int(export.get("width") or 1080), int(export.get("height") or 1920)),
    }


# Frames-in-flight guard: a block holds `block_seconds * fps` frames at the FULL output
# size (1080x1920x30fps ≈ 8 MB/frame → a 5 s block is over a gigabyte). Scale the block
# down with the pixel count, floored so short segments still stream. Also tightens
# cancellation latency, which is only checked between blocks.
#
# Lives here, not in `routes/export.py`, because BOTH HD paths need it and routes imports
# this module (never the reverse). The single-segment export always streamed; the whole
# SONG export did not, and materialised a whole segment at native 4K instead.
def hd_block_seconds(w: int, h: int) -> float:
    ref = 540 * 960
    return max(0.5, min(5.0, 5.0 * ref / max(1, w * h)))


def export_audio_path(job_id: str, export: dict, stem_audio_path):
    """The audio file an export muxes, or None. `audioMode` "instrumental" takes
    the vocals-removed mix (karaoke covers); anything else — or a failure to build
    the instrumental — falls back to the original."""
    want = export.get("audioMode", "original")
    audio = stem_audio_path(job_id, want) if want == "instrumental" else None
    if audio is None:
        audio = stem_audio_path(job_id, "original")
    return audio


def _export_hash(job_id, segments, compositions, lyric_lines, export) -> str:
    """Content key for a whole-song export (so an identical re-export is a cache hit).
    Folds RENDER_VERSION like output_hash does, so a render-semantics bump invalidates
    stale HD exports instead of serving them as cache hits."""
    payload = {
        # v3: graphs live in the composition pool, referenced by rootCompositionId —
        # the payload folds each segment's root composition (graph + resolved output),
        # so an edit anywhere reachable still moves the key. v2: sim-free segments
        # render at native size instead of on the sim grid. RENDER_VERSION is
        # deliberately NOT bumped for either: it is folded into `output_hash` for every
        # render including previews, whose pixels are untouched — bumping it would evict
        # a whole project's cache for a change confined to the HD paths.
        "v": 3,
        "render_version": RENDER_VERSION,
        "job_id": job_id,
        "export": export,
        "lyrics": lyric_lines,
        "segments": [
            {
                "start": s.get("start"),
                "end": s.get("end"),
                "signals": s.get("signals"),
                "root": s.get("rootCompositionId"),
                "final": final_output_id(root_composition(compositions, s)),
                "graph": (root_composition(compositions, s) or {}).get("graph"),
            }
            for s in segments
        ],
    }
    blob = json.dumps(payload, sort_keys=True, default=str).encode()
    return hashlib.sha1(blob).hexdigest()[:16]


def _mux_audio(
    video: "object", audio: "object", out_path: "object", *, start: float = 0.0, duration=None
) -> None:
    """Combine the silent `video` with `audio` into `out_path` (video stream-copied,
    audio re-encoded to AAC, trimmed to the shorter of the two).

    `start`/`duration` take a SLICE of the audio — the single-segment HD export
    muxes just that segment's window. They seek the AUDIO input only (input-side
    `-ss`, so it's a fast keyframe seek, and the video keeps its own timeline);
    with neither, the command is byte-identical to the whole-song one."""
    a_in = []
    if start:
        a_in += ["-ss", f"{float(start):.3f}"]
    if duration is not None:
        a_in += ["-t", f"{float(duration):.3f}"]
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-i", str(video), *a_in, "-i", str(audio),
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "aac", "-shortest",
        "-movflags", "+faststart", str(out_path),
    ]  # fmt: skip
    # ENCODE ceiling: this muxes a whole song's video with its audio.
    proc = subprocess.run(cmd, capture_output=True, timeout=ENCODE_TIMEOUT)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode(errors="replace")[-2000:])


def close_plan(ctx: dict) -> None:
    """Release every DAG `build_plan` opened. Safe to call twice (`Dag.close` is
    idempotent), and tolerant of a partially-built ctx so it can run from a `finally`."""
    for entry in (ctx or {}).get("plan") or []:
        entry[0].close()


def song_total_frames(segments: list, export: dict) -> int:
    """The export's total frame count, WITHOUT building the plan.

    `build_plan` computes the same sum, but only as a by-product of opening a Dag per
    segment and resolving its fields — which is where signal extraction (STFT / HPSS /
    beat-track) happens. The cache-hit path needs the number and nothing else, so it goes
    through `_clip_dims`: the one place the 0.5 s duration floor lives, and already the
    documented seam for exactly this (`render_stream`'s cache hit uses it the same way).
    Deriving the floor a second time here is how the two quietly disagree.
    """
    out_dict = output_from_export(export)
    fps = out_dict["fps"]
    return sum(max(1, round(_clip_dims(seg, out_dict)[0] * fps)) for seg in segments)


def build_plan(
    job_id: str, segments: list, compositions: dict, lyric_lines: list, export: dict,
    stem_audio_path
) -> dict:  # fmt: skip
    """Resolve every segment's DAG + final-output fields ONCE (signal extraction happens
    here) and the per-layer dye layout — the UNION of edge-modes across every segment
    that feeds a layer, so a persistent field's dye layers cover them all. Each segment's
    graph resolves through the composition pool (`rootCompositionId`). Returns the
    render context consumed by `iter_song_windows`. Raises if a segment is unmarked."""
    out_dict = output_from_export(export)  # the shared export->output contract
    fps, w, h = out_dict["fps"], out_dict["width"], out_dict["height"]
    plan: list = []  # per segment: (dag, output_id, [field...], window_len, (gh, gw))
    layer_sources: dict = {}  # layer number -> accumulated source dicts (for dye layout)
    total = 0
    for seg in sorted(segments, key=lambda s: float(s.get("start", 0.0))):
        comp = root_composition(compositions, seg)
        oid = final_output_id(comp)
        if not comp or not oid:
            raise ValueError(f"segment {seg.get('id')} has no final output marked")
        seg2 = {**seg, "lyric_lines": seg.get("lyric_lines") or lyric_lines}
        dag = Dag(job_id, seg2, comp["graph"], stem_audio_path, out_dict)
        fields = dag.field_layers(oid)
        window = max(1, round(dag.duration * fps))
        for f in fields:
            layer_sources.setdefault(f["layer"], []).extend(
                f["params"].get("sources") or [f["params"].get("source", {})]
            )
        plan.append((dag, oid, fields, window, _grid_dims(dag)))
        total += window
    dye_layout = {
        n: fluid._dye_layout(srcs) for n, srcs in layer_sources.items()
    }  # n -> (modes, wrap)
    # ONE ffmpeg spans the song and its rawvideo geometry is fixed at the first write, so
    # every segment must arrive at one size — which is why `nativeShort` used to be withheld
    # from the shared contract. Size the encoder from the plan instead of from a constant:
    # the LARGEST segment grid. All-light song -> native (no resampling anywhere); all-fluid
    # song -> the sim grid, byte-identical to before; mixed -> native, and only the fluid
    # segments are upscaled. Largest, not "native if any segment is light", because
    # `gridCells` is user-settable above the short side and would otherwise DOWNscale a
    # light segment.
    gh, gw = max(
        (dims for *_, dims in plan),
        key=lambda d: d[0] * d[1],
        default=fluid.grid_from_output(out_dict),
    )
    # The persistent fields are a DIFFERENT size from the encoder and must stay so: they
    # carry across segment boundaries, so they need ONE size for the whole song, and that
    # size is the sim grid — never the encoder's (a mixed song would otherwise simulate at
    # 4K). A fluid segment's own Dag resolves to this same grid, so the pre-seeded arrays
    # still match what its DAG expects.
    sim_h, sim_w = fluid.grid_from_output(out_dict)
    return {  # NB: the plan's DAGs hold resources — the caller must `close_plan(ctx)`
        "plan": plan,
        "dye_layout": dye_layout,
        "total": total,
        "gh": gh,  # the ENCODER's rawvideo input size
        "gw": gw,
        "sim_h": sim_h,  # the persistent fluid fields' grid
        "sim_w": sim_w,
        "fps": fps,
        "w": w,
        "h": h,
        "crf": fluid.crf_from_output(out_dict),
    }


def _to_encoder_size(blk: np.ndarray, gh: int, gw: int) -> np.ndarray:
    """Bring one block to the encoder's fixed rawvideo size.

    Decides on the block's ACTUAL shape, never on a size recorded earlier, so the invariant
    cannot drift from what a producer really returned.

    `INTER_NEAREST` is hardcoded, and it is allowed to be: the only blocks smaller than the
    encoder input are sim-grid dye, which wants nearest ("upscale crisply" — the same choice
    ffmpeg's `flags=neighbor` made when it did this job) and which arrives already flattened
    to RGB. Video and montage segments render at native and pass straight through, so nothing
    photographic is ever resampled here. If that ever stops being true, this comment is the
    thing to revisit — a photographic upscale wants cubic or Lanczos, not nearest.

    The RGBA branch is belt-and-braces: no current caller can reach it (the segments that
    carry alpha are exactly the ones already at native size), but resampling straight alpha
    would bleed colour out of transparent pixels, so flatten first if it ever happens.
    """
    if blk.shape[1:3] == (gh, gw):
        return blk
    if blk.shape[-1] == 4:
        blk = fluid.flatten(blk)
    out = np.empty((len(blk), gh, gw, blk.shape[-1]), np.uint8)
    for i, frame in enumerate(blk):
        cv2.resize(frame, (gw, gh), dst=out[i], interpolation=cv2.INTER_NEAREST)
    return out


def iter_song_windows(ctx: dict, should_cancel=None, on_segment=None):
    """Yield `(a, b, styled_frames)` — the continuous render. The K persistent `FluidSim`
    fields carry across yields (that's the whole point): entering a segment only swaps the
    injected rules.

    A segment WITH fluid fields yields exactly one window covering it, flattened RGB
    `[win, gh, gw, 3]` — the persistent fields must be advanced over the whole window
    before the segment's DAG can be fed them. A segment with NO fluid field has nothing to
    inject, so it is streamed in blocks instead and yields several times, RGBA. Callers
    must therefore treat this as a stream of consecutive frame ranges, not one per
    segment, and must not assume a channel count (the encoder handles both).
    Stops early (returns) if `should_cancel()` before a segment. Pure/no I/O, so tests can
    concatenate the windows and assert continuity without ffmpeg.

    `on_segment(index, count, label)` fires as each segment BEGINS — the only moment that
    knows it. Progress is otherwise published once per segment (one `yield` here), so the
    frame counter sits still for minutes and then leaps a whole segment; this is what
    tells the UI it is still working, and on what. Optional, so the generator stays pure
    for the tests that just concatenate its windows."""
    dye_layout, gh, gw = ctx["dye_layout"], ctx["gh"], ctx["gw"]
    sim_h, sim_w = ctx["sim_h"], ctx["sim_w"]
    fields_sim: dict = {}  # layer number -> persistent FluidSim (carries across segments)
    done = 0
    for k, (dag, oid, fields, window, _dims) in enumerate(ctx["plan"]):
        if should_cancel and should_cancel():
            return
        if on_segment:
            seg = dag.segment or {}
            on_segment(k + 1, len(ctx["plan"]), str(seg.get("label") or seg.get("id") or ""))
        # Build this segment's per-field injector against the field's GLOBAL dye layout,
        # and lazily create each persistent field the first time its layer is used.
        injectors = []  # (node_id, layer_number, LayerInjector)
        for f in fields:
            modes, vel_wrap = dye_layout[f["layer"]]
            inj = fluid.LayerInjector(f["params"], modes)
            if f["layer"] not in fields_sim:
                fields_sim[f["layer"]] = fluid.FluidSim(
                    sim_h,
                    sim_w,
                    dissipation=inj.medium0("dissipation"),
                    vel_dissipation=inj.medium0("velocity_dissipation"),
                    viscosity=inj.medium0("viscosity"),
                    vorticity=inj.medium0("vorticity"),
                    wrap=vel_wrap,
                    dye_modes=modes,
                )
            injectors.append((f["node_id"], f["layer"], inj))

        if not injectors:
            # NOTHING to inject: no fluid field feeds this segment's output, so there is
            # no reason to hold the whole clip in memory — stream it in blocks like the
            # single-segment HD export already does, and yield each block.
            #
            # This is what took the machine down. The whole-clip path renders at the DAG's
            # own frame size, which for a sim-free graph is the export's NATIVE size: a
            # 60 s segment at 2160x3840 RGBA is ~59 GB in one allocation. Observed: 13-17 GB
            # resident and climbing before the OS memory killer fired. A fluid segment was
            # never in this danger — it renders on the sim grid, which is orders smaller.
            #
            # Blocks come out RGBA here where the fluid path yields flattened RGB. That is
            # fine and deliberate: `StreamEncoder` fixes its input format on the first block
            # and converts any later mismatch, and ffmpeg composites RGBA over black exactly
            # as `fluid.flatten` does (pinned by tests/test_flatten_contract.py). Flattening
            # here instead would cost a full extra pass over every frame for no difference.
            block = max(1, round(hd_block_seconds(ctx["w"], ctx["h"]) * ctx["fps"]))
            for a0, b0, _total, blk in dag.stream_blocks(oid, block):
                yield done + a0, done + b0, _to_encoder_size(blk, gh, gw)
            done += window
            continue

        # Advance ALL live fields over this window; capture each USED field's frames.
        captured = {nid: np.empty((window, sim_h, sim_w, 3), np.uint8) for nid, _, _ in injectors}
        for i in range(window):
            for _nid, layer_n, inj in injectors:
                inj.apply(fields_sim[layer_n], i)
            for sim in fields_sim.values():  # step every field (unused ones just fade)
                sim.step()
            for nid, layer_n, _inj in injectors:
                captured[nid][i] = fluid._tonemap(fields_sim[layer_n].current_dye())

        # Style the window through the segment's own DAG, feeding it the continuous
        # fields (pre-seed the video memo), then flatten RGBA -> RGB on black.
        for nid, frames in captured.items():
            dag._video[nid] = frames
        styled = fluid.flatten(dag.video(oid))
        # Chunk BEFORE resizing. Resizing the whole window would allocate it again at the
        # encoder size — a 60 s window at 4K is ~50 GB, the exact allocation that took the
        # machine down. One source window (sim grid, small) plus one destination block.
        step = max(1, round(hd_block_seconds(ctx["w"], ctx["h"]) * ctx["fps"]))
        for a0 in range(0, window, step):
            b0 = min(a0 + step, window)
            yield done + a0, done + b0, _to_encoder_size(styled[a0:b0], gh, gw)
        done += window


def render_song(
    job_id: str,
    segments: list,
    compositions: dict,
    lyric_lines: list,
    export: dict,
    stem_audio_path,
    *,
    on_progress=None,
    on_segment=None,
    should_cancel=None,
) -> str | None:
    """Render the whole song to one continuous HD mp4 (video + muxed audio) and return
    its URL. `segments` each carry `start`, `end`, `signals`, `rootCompositionId`; the
    graphs live in `compositions` (the pool).
    `on_segment(index, count, label)` fires as each segment starts — frame progress lands
    only once per segment (one window per yield), so the counter can sit still for minutes
    and then leap; this is the signal that says it is still working, and on what. It is a
    SEPARATE callback rather than a kwarg on `on_progress`, which is a shared 3-arg
    contract several callers satisfy with a plain lambda.

    See the module docstring for the continuous-field model. Cached by content hash;
    cancellation between segments returns None."""
    h = _export_hash(job_id, segments, compositions, lyric_lines, export)
    out_path = paths.ANIM_DIR / f"song_{h}.mp4"
    url = f"/fluid/{out_path.name}"
    # CHECK THE CACHE BEFORE DOING THE WORK. `build_plan` opens a Dag per segment and
    # resolves its fields, which runs full signal extraction (STFT / HPSS / beat-track)
    # over every segment — minutes of work on a long song, and it used to run BEFORE this
    # existence check, so re-exporting an unchanged project paid for it every time. The
    # only thing the hit path wanted from it was the frame total, which `song_total_frames`
    # derives from the segment bounds alone.
    if out_path.exists():  # identical export already rendered
        render_cache.touch(out_path)
        if on_progress:
            total = song_total_frames(segments, export)
            on_progress(total, total, url)
        return url

    ctx = build_plan(job_id, segments, compositions, lyric_lines, export, stem_audio_path)
    # Each Dag may hold ffmpeg decoders (a video / slideshow / stylize card registers
    # clip.close on it), and they outlive build_plan by design — `iter_song_windows` walks
    # them — so they're drained in this OUTER finally. It used to also cover a cache-hit
    # early return that leaked a decoder per video card on every repeat export; that return
    # now happens above, before any Dag exists, so there is nothing to leak on that path.
    try:
        # Strip the "song_" underscore: the id names the scratch dir AND lands in the
        # progress preview URL, and /fluid/stream/<render_id>/… only serves alnum ids.
        render_id = out_path.stem.replace("_", "") + uuid.uuid4().hex[:8]
        scratch = paths.STREAM_DIR / render_id
        shutil.rmtree(scratch, ignore_errors=True)
        scratch.mkdir(parents=True, exist_ok=True)
        silent = scratch / "video.mp4"
        enc = fluid.StreamEncoder(
            silent, ctx["fps"], ctx["gw"], ctx["gh"], ctx["w"], ctx["h"], crf=ctx["crf"]
        )
        try:
            for _a, b, styled in iter_song_windows(ctx, should_cancel, on_segment=on_segment):
                enc.write(styled)  # opens ffmpeg on the first window
                if on_progress:
                    on_progress(b, ctx["total"], f"/fluid/stream/{render_id}/video.mp4?n={b}")
            if should_cancel and should_cancel():  # iter stopped early -> cancelled
                return None
            enc.finalize()
            audio = export_audio_path(job_id, export, stem_audio_path)
            if audio is not None:
                _mux_audio(silent, audio, out_path)
            else:  # no audio available — ship the silent video
                shutil.move(str(silent), str(out_path))
            render_cache.evict(paths.ANIM_DIR)
            if on_progress:
                on_progress(ctx["total"], ctx["total"], url)
            return url
        finally:
            enc.close()  # no-op unless cancelled / errored mid-stream
            shutil.rmtree(scratch, ignore_errors=True)
    finally:
        close_plan(ctx)
