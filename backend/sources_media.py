"""Source cards backed by a FILE on disk: image, video, slideshow.

Split out of `sources.py` (cleanup step 27). Import from the `sources` facade unless
you are working inside the package.

The placement helpers (`_place_box`, `_fit_rgba`, `_apply_opacity`) live here because
only these cards use them — every card in this module lays a fixed-size asset into a
fractional box, which is the one thing the generative cards never do.
"""

from __future__ import annotations

import json
import logging
import subprocess
from functools import lru_cache

import numpy as np
from PIL import Image

from .config import PROBE_TIMEOUT

log = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# Image / Video layer cards (spec: backgrounds are layers, not a setting)
# --------------------------------------------------------------------------- #
def _place_box(w: int, h: int, box_x, box_y, box_w, box_h):
    """Pixel box (x0, y0, bw, bh) for a fractional placement box, clamped in-frame.
    Defaults (0,0,1,1) cover the whole frame."""
    bw = max(1, int(round(float(box_w) * w)))
    bh = max(1, int(round(float(box_h) * h)))
    x0 = max(0, min(int(round(float(box_x) * w)), w - 1))
    y0 = max(0, min(int(round(float(box_y) * h)), h - 1))
    return x0, y0, min(bw, w - x0), min(bh, h - y0)


def _fit_rgba(src: np.ndarray, bw: int, bh: int, fit: str) -> np.ndarray:
    """Resize a source RGBA (H,W,4) into a (bh,bw,4) box: `cover` fills + centre-crops,
    `contain` fits inside on a transparent letterbox, `stretch` distorts to exact size."""
    ih, iw = src.shape[:2]
    pil = Image.fromarray(src, "RGBA")
    if fit == "stretch" or iw == 0 or ih == 0:
        return np.asarray(pil.resize((bw, bh), Image.LANCZOS), np.uint8)
    scale = max(bw / iw, bh / ih) if fit == "cover" else min(bw / iw, bh / ih)
    nw, nh = max(1, round(iw * scale)), max(1, round(ih * scale))
    r = np.asarray(pil.resize((nw, nh), Image.LANCZOS), np.uint8)
    out = np.zeros((bh, bw, 4), np.uint8)
    ox, oy = (nw - bw) // 2, (nh - bh) // 2  # >0 crop (cover), <0 pad (contain)
    sx, sy, dx, dy = max(0, ox), max(0, oy), max(0, -ox), max(0, -oy)
    cw, ch = min(nw - sx, bw - dx), min(nh - sy, bh - dy)
    out[dy : dy + ch, dx : dx + cw] = r[sy : sy + ch, sx : sx + cw]
    return out


def _apply_opacity(base_rgba: np.ndarray, nframes: int, opacity) -> np.ndarray:
    """Broadcast a single (h,w,4) layer to (nframes,h,w,4), scaling alpha per frame."""
    h, w = base_rgba.shape[:2]
    op = np.asarray(opacity, np.float32).reshape(-1)[:, None, None]
    out = np.empty((nframes, h, w, 4), np.uint8)
    out[..., :3] = base_rgba[..., :3]
    out[..., 3] = np.clip(base_rgba[None, ..., 3].astype(np.float32) * op, 0, 255).astype(np.uint8)
    return out


def image(
    nframes,
    h,
    w,
    *,
    asset_path,
    box_x=0.0,
    box_y=0.0,
    box_w=1.0,
    box_h=1.0,
    fit="cover",
    opacity,
    frame_offset=0,
) -> np.ndarray:
    """A still image as an RGBA layer `(nframes, h, w, 4)`. Placed into the box (fractions
    0..1, default full-frame) per `fit`; alpha = the image's own alpha × box coverage,
    scaled per frame by `opacity`. `frame_offset` is unused (static) — kept so the block
    renderer can call it the same way as `video`/`lyrics`."""
    base = np.zeros((h, w, 4), np.uint8)
    if asset_path:
        try:
            src = np.asarray(Image.open(asset_path).convert("RGBA"), np.uint8)
            x0, y0, bw, bh = _place_box(w, h, box_x, box_y, box_w, box_h)
            base[y0 : y0 + bh, x0 : x0 + bw] = _fit_rgba(src, bw, bh, fit)
        except (OSError, ValueError, Image.DecompressionBombError):
            pass  # missing/corrupt/oversized asset -> empty (transparent) layer
    return _apply_opacity(base, nframes, opacity)


@lru_cache(maxsize=128)
def _video_meta(path: str):
    """(duration_sec, width, height) for a video, via ffprobe (cached).

    ⚠ This is THE call the export's `_HD_SLOT` deadlock ran through. That slot is a
    `BoundedSemaphore(1)` released in a `finally`, and a `subprocess.run` with no timeout
    never reaches it — so one ffprobe wedged on a corrupt or network-stalled file used to
    409 every subsequent export for the life of the process. The ceiling is the fix; the
    fallback below is what makes a timeout survivable rather than merely visible.
    """
    try:
        out = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height:format=duration",
                "-of",
                "json",
                path,
            ],
            capture_output=True,
            text=True,
            timeout=PROBE_TIMEOUT,
        )
    except (OSError, subprocess.TimeoutExpired):
        log.warning("ffprobe failed or timed out on %s — using placeholder dimensions", path)
        return 0.0, 16, 16
    try:
        j = json.loads(out.stdout or "{}")
    except ValueError:
        return 0.0, 16, 16
    st = (j.get("streams") or [{}])[0]
    return (
        float(j.get("format", {}).get("duration") or 0.0),
        int(st.get("width") or 16),
        int(st.get("height") or 16),
    )


def _fit_vf(bw: int, bh: int, fit: str) -> str:
    """ffmpeg -vf fit chain producing exactly bw x bh RGBA (transparent letterbox for
    `contain`)."""
    if fit == "stretch":
        return f"scale={bw}:{bh}"
    if fit == "contain":
        return (
            f"scale={bw}:{bh}:force_original_aspect_ratio=decrease,"
            f"pad={bw}:{bh}:(ow-iw)/2:(oh-ih)/2:color=#00000000"
        )
    return f"scale={bw}:{bh}:force_original_aspect_ratio=increase,crop={bw}:{bh}"  # cover


class VideoClip:
    """A resumable decoder for one video-layer node — the `fluid.FluidClip` of video.

    Block streaming used to spawn a fresh ffmpeg per ~5s block, each paying seek +
    pipeline-init and re-decoding overlapping GOP data. Because the block renderer's
    source times are non-decreasing (speed >= 0, blocks are front-to-back), ONE
    persistent rawvideo decoder can instead be opened at the first request and simply
    read FORWARD across `frames()` calls. A backward request (never in normal
    streaming; safety) transparently reopens the decoder at the new time, so
    correctness never depends on decoder state.
    """

    def __init__(
        self,
        h,
        w,
        fps,
        *,
        asset_path,
        box_x=0.0,
        box_y=0.0,
        box_w=1.0,
        box_h=1.0,
        fit="cover",
        loop=True,
        crop_x=0.0,
        crop_y=0.0,
        crop_w=1.0,
        crop_h=1.0,
    ):
        self.h, self.w, self.fps = int(h), int(w), int(fps)
        self.x0, self.y0, self.bw, self.bh = _place_box(self.w, self.h, box_x, box_y, box_w, box_h)
        self.path = str(asset_path) if asset_path else ""
        self.fit = fit
        # Source crop (fractions of the SOURCE frame, before fit): the selected region is
        # what gets fitted into the box, so a clip too wide/tall for the format can show
        # exactly the part the user picked. Clamped in-frame and non-degenerate; the
        # identity crop adds NO filter, keeping existing renders byte-identical.
        cx = min(max(float(crop_x), 0.0), 0.99)
        cy = min(max(float(crop_y), 0.0), 0.99)
        cw = min(max(float(crop_w), 0.01), 1.0 - cx)
        ch = min(max(float(crop_h), 0.01), 1.0 - cy)
        self._crop_vf = (
            ""
            if (cx, cy, cw, ch) == (0.0, 0.0, 1.0, 1.0)
            # max(1, …) guards a sub-pixel crop on a tiny source (ffmpeg needs >= 1px).
            else f"crop=max(1\\,iw*{cw:.4f}):max(1\\,ih*{ch:.4f}):iw*{cx:.4f}:ih*{cy:.4f},"
        )
        self.loop = bool(loop)
        self.dur = _video_meta(self.path)[0] if self.path else 0.0
        self._proc: "subprocess.Popen | None" = None
        self._seek = 0.0  # source time of decoded stream frame 0
        self._fold = 0.0  # whole loops subtracted from request times (loop mode)
        self._read = 0  # frames consumed from the stream so far
        self._last: "np.ndarray | None" = None  # most recently decoded frame
        self._eof = False

    def close(self) -> None:
        if self._proc is None:
            return
        try:
            self._proc.stdout.close()
        except OSError:
            pass
        self._proc.kill()
        self._proc.wait()
        self._proc = None

    def _open(self, t0: float) -> None:
        """(Re)start the decoder so stream frame 0 is the source frame at time `t0`.
        With `loop`, whole loops are folded out of the seek (`-stream_loop -1` covers
        overruns past the clip end); the `fps` filter resamples the source onto the
        output grid so index math stays uniform. NO `-t`/`-frames:v` cap — frames are
        pulled lazily, the pipe back-pressures ffmpeg, and `close()` reaps it."""
        self.close()
        self._fold = (
            float(np.floor(t0 / self.dur) * self.dur) if (self.loop and self.dur > 0) else 0.0
        )
        self._seek = t0 - self._fold
        cmd = ["ffmpeg", "-v", "error"]
        if self.loop:
            cmd += ["-stream_loop", "-1"]
        cmd += [
            "-ss",
            f"{max(0.0, self._seek):.4f}",
            "-i",
            self.path,
            "-vf",
            f"fps={self.fps},format=rgba," f"{self._crop_vf}{_fit_vf(self.bw, self.bh, self.fit)}",
            "-pix_fmt",
            "rgba",
            "-f",
            "rawvideo",
            "-",
        ]
        self._proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self._read = 0
        self._last = None
        self._eof = False

    def _frame(self, idx: int):
        """Read forward to stream frame `idx` and return it; at/after EOF (short or
        non-looping clip) the last decoded frame holds. None until a frame decodes."""
        n = self.bw * self.bh * 4
        while self._read <= idx and not self._eof:
            buf = self._proc.stdout.read(n)
            if not buf or len(buf) < n:
                self._eof = True
                break
            self._last = np.frombuffer(buf, np.uint8).reshape(self.bh, self.bw, 4)
            self._read += 1
        return self._last

    def frames(self, src_t) -> np.ndarray:
        """RGBA frames `(len(src_t), h, w, 4)` sampling the source at times `src_t`
        (seconds, non-decreasing within AND across calls), placed into the box. Alpha
        is the box/letterbox coverage; the caller scales it by `opacity`."""
        count = len(src_t)
        out = np.zeros((count, self.h, self.w, 4), np.uint8)
        if not self.path or count == 0:
            return out
        src_t = np.asarray(src_t, np.float64)
        # Past the end with `loop` off: the frames stay TRANSPARENT (black at the
        # terminal). Holding the last frame used to be the fallback, but in a montage a
        # slot longer than its clip then froze on a still for the rest of the cut, which
        # reads as a broken render; blank is unambiguous, and the card's shortfall
        # warning already says how much material is missing. Tick `loop` to replay
        # instead. `spent` is computed BEFORE clipping so we know which frames to blank.
        spent = None
        if self.dur > 0 and not self.loop:
            last = max(0.0, self.dur - 1.0 / float(self.fps))
            spent = src_t > last
            src_t = np.clip(src_t, 0.0, last)
        if self._proc is None:
            self._open(float(src_t[0]))
        idx = np.round((src_t - self._fold - self._seek) * self.fps).astype(int)
        if idx[0] < max(0, self._read - 1):  # backward jump -> reopen at the new time
            self._open(float(src_t[0]))
            idx = np.round((src_t - self._fold - self._seek) * self.fps).astype(int)
        idx = np.maximum(idx, 0)
        for i, k in enumerate(idx):
            if spent is not None and spent[i]:
                continue  # out of material — leave this frame blank
            f = self._frame(int(k))
            if f is not None:
                out[i, self.y0 : self.y0 + self.bh, self.x0 : self.x0 + self.bw] = f
        return out


class SlideshowClip:
    """A slideshow of MIXED image/video items as an RGBA layer, driven by a whole-
    segment per-frame `index` (item shown at each frame; computed once from the trigger).

    Built once, streamed per block — the same "build once, read forward" shape as
    `VideoClip` — so the whole-clip and block handlers share ONE core and stay
    byte-identical (the render lockstep invariant). Image items are pre-fitted into the
    box ONCE (like `imagegen`); each video item owns its own resumable `VideoClip`
    (loop=True). A video item plays from its in-point (`start`) for as long as the
    trigger keeps it visible; each fresh RUN (a return to that item after the sequence
    moved on) restarts at the in-point — a backward jump `VideoClip.frames` absorbs by
    reopening its decoder.

    The playhead of a video item at a given frame is `start + age/fps`, where `age` is
    the number of frames since the CURRENT contiguous run of that item began. `age` and
    `run_id` are precomputed over the WHOLE segment (never per block), so a run that
    straddles a block seam keeps counting forward and streamed output equals the
    whole-clip render frame-for-frame.
    """

    def __init__(
        self, h, w, fps, *, items, index, box_x=0.0, box_y=0.0, box_w=1.0, box_h=1.0, fit="cover"
    ):
        self.h, self.w, self.fps = int(h), int(w), int(fps)
        self.x0, self.y0, self.bw, self.bh = _place_box(self.w, self.h, box_x, box_y, box_w, box_h)
        self.index = np.asarray(index, np.int64)
        self.n_items = len(items)
        # Run-relative timing over the whole segment (see class docstring).
        n = len(self.index)
        new_run = np.ones(n, bool)
        if n > 1:
            new_run[1:] = self.index[1:] != self.index[:-1]
        pos = np.arange(n)
        run_start = np.maximum.accumulate(np.where(new_run, pos, 0)) if n else pos
        self.age = pos - run_start  # frames since the current slide appeared
        self.run_id = np.cumsum(new_run) - 1 if n else pos  # unique id per contiguous run
        # Build each item: image -> fitted tile (video slot None); video -> its own
        # VideoClip (tile slot None). Slots stay index-aligned with `items`.
        self.tiles: list = []
        self.clips: list = []
        self.starts: list = []
        for it in items:
            path, kind = it.get("path", ""), it.get("kind", "image")
            if kind == "video" and path:
                clip = VideoClip(
                    self.h,
                    self.w,
                    self.fps,
                    asset_path=path,
                    box_x=box_x,
                    box_y=box_y,
                    box_w=box_w,
                    box_h=box_h,
                    fit=fit,
                    loop=True,
                )
                self.tiles.append(None)
                self.clips.append(clip)
                self.starts.append(float(it.get("start", 0.0) or 0.0))
            else:
                tile = np.zeros((self.bh, self.bw, 4), np.uint8)  # transparent fallback
                if path:
                    try:
                        src = np.asarray(Image.open(path).convert("RGBA"), np.uint8)
                        tile = _fit_rgba(src, self.bw, self.bh, fit)
                    except (OSError, ValueError, Image.DecompressionBombError):
                        pass
                self.tiles.append(tile)
                self.clips.append(None)
                self.starts.append(0.0)

    def frames(self, a, b, opacity) -> np.ndarray:
        """RGBA frames `[a, b)` as `(b-a, h, w, 4)`, alpha scaled by the block-sliced
        `opacity` (len b-a). Exactly one item is active per frame (the `index`), so each
        item paints its frames independently and they never overlap."""
        a, b = int(a), int(b)
        count = b - a
        out = np.zeros((max(count, 0), self.h, self.w, 4), np.uint8)
        if count <= 0 or not self.n_items:
            return out
        idx_block = self.index[a:b] % self.n_items
        for item in np.unique(idx_block):
            local = np.nonzero(idx_block == item)[0]  # positions within this block
            clip = self.clips[int(item)]
            if clip is None:  # image item: paste its tile on every active frame
                out[local, self.y0 : self.y0 + self.bh, self.x0 : self.x0 + self.bw] = self.tiles[
                    int(item)
                ]
                continue
            # Video item: split the active frames into contiguous RUNS (a single block can
            # hold two separate runs of the same item, e.g. index v,w,v). VideoClip.frames
            # only checks for a backward jump at its FIRST element, so a mid-array reset
            # would corrupt — call it once per run, in forward order.
            glob = local + a
            splits = np.where(np.diff(self.run_id[glob]) != 0)[0] + 1
            for grp in np.split(np.arange(len(local)), splits):
                lpos = local[grp]
                src_t = self.starts[int(item)] + self.age[glob[grp]] / float(self.fps)
                out[lpos] = clip.frames(src_t)  # already placed into the box
        return apply_video_opacity(out, opacity)

    def close(self) -> None:
        for c in self.clips:
            if c is not None:
                c.close()


def video_src_times(count, fps, src0, speed) -> np.ndarray:
    """Source time (s) per output frame: `src_t[i] = src0 + (Σ speed before i) / fps`.
    speed >= 0, so the times are non-decreasing — what `VideoClip.frames` requires."""
    count = int(count)
    sp = np.maximum(0.0, np.asarray(speed, np.float64).reshape(-1))
    if sp.size < count:  # hold the last (or unit) speed if the array is short/scalar
        sp = np.concatenate([sp, np.full(count - sp.size, sp[-1] if sp.size else 1.0)])
    sp = sp[:count]
    return float(src0) + np.concatenate([[0.0], np.cumsum(sp)[:-1]]) / float(fps)


def apply_video_opacity(out: np.ndarray, opacity) -> np.ndarray:
    """Scale a video layer's alpha by the per-frame `opacity` array, in place.

    Opacity is 1.0 unless something is wired to it — the overwhelmingly common case, and
    then this is the identity. The guard costs an O(frames) reduce; what it skips is a
    float32 round-trip over the whole alpha PLANE, which measured 21.4s of a 133s 4K
    render (16%) while changing nothing. Returns the same array either way: callers rely
    on the in-place mutation, not on the return value."""
    op = np.asarray(opacity, np.float32).reshape(-1)[: out.shape[0], None, None]
    if op.size and float(op.min()) == 1.0 and float(op.max()) == 1.0:
        return out
    out[..., 3] = np.clip(out[..., 3].astype(np.float32) * op, 0, 255).astype(np.uint8)
    return out
