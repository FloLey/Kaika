# Step 20 — Timeouts, and an atomic HD write

**Status: DONE** — `769212a`.

> Two corrections from doing it. There were **six** untimed calls, not five: `fluid.py`'s
> `render_mp4` was missed, and every line number below had drifted (`fluid.py:685`→`753`,
> `song_render.py:119`→`125`, `sources.py:1016` moved too). Re-grep, as this file already
> says.
>
> Landed as three ceilings in `config.py` beside the existing `PROXY`/`CLIP`/`THUMB` ones —
> `PROBE_TIMEOUT` 30, `DECODE_TIMEOUT` 600, `ENCODE_TIMEOUT` 1800 — deliberately generous,
> because they bound a *hang*, not a budget.
>
> One thing worth stating that the step below does not: **a ceiling alone would trade a
> deadlock for an outage.** `_video_meta` catches its own `TimeoutExpired` and returns the
> `(0.0, 16, 16)` placeholder it already had for corrupt files, so a stalled probe degrades
> one card instead of 500-ing the export.
>
> The HD publish went further than "reuse `_write_atomic`": the clip is now encoded *beside*
> `dest` rather than in `/tmp`, so publishing is a same-filesystem `os.replace` and the
> whole read-back-through-RAM disappears with the truncation bug. ffmpeg can write straight
> to the final directory; there was never a reason to copy.

**Tier.** Core. Two robustness holes, both of which fail in a way the user experiences as
"exports are broken" with nothing in the logs to explain it.

**Goal.** Make a malformed asset unable to wedge every export for the life of the process,
and make a killed worker unable to poison the HD cache with a truncated file.

**Blocked by.** Nothing.

**Size.** S/M.

> Line numbers are a snapshot — re-grep before relying on one.

---

## 1. Five untimed subprocesses on the render path

The convention is already established and followed on the *upload* path — `media.py:228`
(yt-dlp), `routes/uploads.py:140,171` (extract, demucs), `routes/assets.py:110` (every
derived transcode). These five never got it:

| Site | What it runs |
|---|---|
| `sources.py:1016` | `_video_meta`'s **ffprobe** — runs for every video and slideshow card |
| `fluid.py:685` | `render_mp4` |
| `song_render.py:119` | `_mux_audio` |
| `media.py:131`, `:144` | probe/convert helpers |
| `segment.py:61` | audio extract on the analysis path |

### Why this is not merely untidy

`routes/export.py:43` is `_HD_SLOT = threading.BoundedSemaphore(1)`, released in a `finally`.
A `subprocess.run` with no timeout does not return. The `finally` never runs. **One hung
ffprobe on one malformed asset means every subsequent HD export 409s until the process is
restarted** — and the user sees "export is busy" forever, with no failing job to point at.

`sources.py:1016` is the most exposed of the five: it is on the per-card path, it takes
whatever file the user uploaded, and it has **no `check` and no returncode handling** — it
leans on `json.loads("")` raising to fall through to the `(0.0, 16, 16)` default. That
fallback is fine for a *malformed* probe; it does nothing for a *hung* one.

### The change

Give each a timeout scaled to what it does — a probe is seconds, a whole-clip encode is
minutes — and a `TimeoutExpired` handler that fails the job loudly rather than falling
through to a silent default. Prefer routing them through the existing helper if one fits:
`_ffmpeg_atomic` (`routes/assets.py`) already pairs a timeout with the `FFMPEG_SLOTS`
semaphore, and the comment there explains why no call site should bypass it.

⚠ `subprocess.run(..., timeout=)` kills the child but **does not reap its grandchildren**.
ffmpeg does not normally spawn any; yt-dlp does. Check before assuming a timeout alone is
sufficient for `media.py`.

## 2. The HD stylize write is neither atomic nor streamed

`routes/export.py:510`:

```python
fluid.render_mp4(styled, int(fps), tmp, ...)
dest.write_bytes(tmp.read_bytes())
```

Two distinct problems from one line:

**(a) It loads an entire HD clip into RAM** to move a file between two directories.
`shutil.move` does the job in constant memory.

**(b) `write_bytes` truncates first.** A worker killed mid-write leaves a partial
`hd-stylize-<key>.mp4` — and the next export's `if not dest.exists()` (`:496`) treats that
truncated file as a **valid cache hit**. The failure surfaces much later, as a corrupt export
with no error anywhere near the cause.

**This exact bug was already fixed once in this repo.** Commit `b957547` ("assets: store
uploads atomically — a killed write left a 0-byte clip") fixed it for uploads, and
`_write_atomic` (`routes/assets.py:82`) documents the reasoning. The fix simply never reached
the export path. Reuse `_write_atomic`'s `os.replace` pattern — same-filesystem rename is
atomic, so a reader either sees the complete file or no file.

While in this function, two small leftovers: `routes/export.py:462` re-imports
`graph as graphmod` which is already imported at module level (`:19`), plus function-local
`import tempfile` / `import os`.

⚠ **Interaction with step 19.** Step 19 rekeys this same cache. If 19 lands first, the
`dest.exists()` check it moves earlier is the *same* check that trusts a truncated file — so
this atomicity fix matters more, not less. Cross-reference the two steps in whichever lands
second.

---

## Verification

1. **The wedge, reproduced.** Point a video card at an asset that makes ffprobe hang (a FIFO,
   or a stubbed binary that sleeps). Confirm today it hangs forever and the next HD export
   409s; confirm after the fix the job fails cleanly and the slot is released. This is the
   test that proves the step was worth doing — write it first and watch it fail.
2. A test that `_HD_SLOT` is released when the render raises (the `finally` is already there;
   pin it so it stays).
3. **Truncated-cache test:** write a partial file at the destination path, then export.
   Before: served as a hit. After: either regenerated or rejected — decide which and assert
   it. (`os.replace` prevents *creating* the partial file, but an existing one from before the
   fix should not be trusted either; consider a size or muxer sanity check.)
4. Memory: confirm no full-clip `read_bytes` remains on the export path.

## Acceptance criteria

- No `subprocess.run` on the render path without a timeout — `grep -n "subprocess.run"
  backend/ | grep -v timeout` returns only `Popen` sites and the deliberate exceptions.
- Deliberate exceptions, if any, carry a comment saying why.
- `hd-stylize-*` files are written via `os.replace`.
- The stray re-imports are gone.

## Risks

- **A timeout too tight for a legitimately long HD encode**, turning a slow success into a
  failure. Scale per call site; err generous. The point is to bound the hang, not to police
  the duration.
- **Cross-filesystem `os.replace`** raises `OSError`. Confirm the tmp file and `dest` are on
  the same filesystem — `_write_atomic` presumably already handles this; follow whatever it
  does rather than inventing a second convention.
