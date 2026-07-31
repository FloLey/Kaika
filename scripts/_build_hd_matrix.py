"""Assemble the HD matrix artifact from whatever Z-Image clips finished.
- regenerates fluid-input small clips for the HD frame window (so they match the results)
- derives recipe 5 (mask x continuous intensity, dilated margin) and recipe 2 (noise + geodesic cut)
- writes the HTML (base64-embedded) to the scratchpad; the Artifact call is done by the agent
Only includes recipes whose result clips exist.
"""

import base64, subprocess, sys
from pathlib import Path
import numpy as np, cv2

SM = Path("data/ai_stylize_proto/small")
SW, SH = 224, 400  # small clip dims (224 wide, 16:9-ish portrait from 448x800)
FLU = {"dense": ("d0e3b447c35129f5", 20), "sparse": ("b64f1a34f1067c83", 0)}
FRAMES = 48
PKS = [("Lava", "lava"), ("Flowers", "flowers"), ("Lightning", "lightning"), ("Trees", "trees")]
K = np.ones((3, 3), np.uint8)


def read(p):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(p), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True,
    ).stdout
    a = np.frombuffer(raw, np.uint8)
    n = a.size // (SW * SH * 3)
    return a[: n * SW * SH * 3].reshape(n, SH, SW, 3) if n else None


def enc(frames, name):
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            f"{SW}x{SH}",
            "-r",
            "24",
            "-i",
            "-",
            "-an",
            "-c:v",
            "libx264",
            "-crf",
            "31",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(SM / name),
        ],
        input=frames.tobytes(),
        check=True,
    )


def fluid_frames(fk):
    key, start = FLU[fk]
    a = np.load(f"data/fluid_cache/{key}.npy", mmap_mode="r")
    return [cv2.resize(np.asarray(a[min(start + i, len(a) - 1)]), (SW, SH)) for i in range(FRAMES)]


def build_fluid_clips():
    for fk in FLU:
        f = np.stack(fluid_frames(fk))
        enc(f, f"HDfluid_{fk}.mp4")


def intensity(dye, margin=True):
    v = dye.astype(np.float32).max(axis=2) / 255.0
    a = np.clip(cv2.GaussianBlur(v, (0, 0), 2) / 0.5, 0, 1)
    if margin:
        a = cv2.dilate(
            (a * 255).astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (27, 27))
        )
        a = cv2.GaussianBlur(a, (0, 0), 6) / 255.0
    return a[..., None]


def geo_cut(gen, dye, factor=0.6):
    content = (cv2.cvtColor(gen, cv2.COLOR_RGB2GRAY) > 16).astype(np.uint8)
    v = dye.astype(np.float32).max(axis=2) / 255.0
    core = (cv2.GaussianBlur(v, (0, 0), 2) > 0.22).astype(np.uint8)
    N = int(np.clip(factor * np.sqrt(max(core.sum(), 1) / np.pi), 8, 80))
    m = core.copy()
    for _ in range(N):
        m = cv2.dilate(m, K) & content
    return cv2.GaussianBlur(m.astype(np.float32), (0, 0), 3)[..., None]


def derive(recipe_src, tag, fn):
    """Post-process an existing recipe clip per-frame with fn(gen, dye) -> alpha."""
    for fk in FLU:
        dyes = fluid_frames(fk)
        for _, pk in PKS:
            src = SM / f"V2hd_{recipe_src}_{fk}_{pk}.mp4"
            if not src.exists():
                continue
            g = read(src)
            if g is None:
                continue
            n = min(len(g), len(dyes))
            out = np.stack(
                [(g[i].astype(np.float32) * fn(g[i], dyes[i])).astype(np.uint8) for i in range(n)]
            )
            enc(out, f"V2hd_{tag}_{fk}_{pk}.mp4")


def b64(name):
    return "data:video/mp4;base64," + base64.b64encode((SM / name).read_bytes()).decode()


def exists(name):
    return (SM / name).exists()


def build_html(scratch):
    def vid(name, cls=""):
        return (
            f'<div class="screen {cls}"><video src="{b64(name)}" autoplay loop muted playsinline preload="none"></video></div>'
            if exists(name)
            else '<div class="screen empty">—</div>'
        )

    # seeds reused from the SD-era illustrations (conceptual)
    # NOTE: recipes 2 & 5 are NOT separate generations — they post-process another recipe.
    # So their "seed" is that of their parent (2←1, 5←4), not a fake independent seed.
    SEED = {
        "noise": {"dense": "SEED_noise.mp4", "sparse": "SEED_noise.mp4"},
        "noisecut": {"dense": "SEED_noise.mp4", "sparse": "SEED_noise.mp4"},
        "fluid": {"dense": "HDfluid_dense.mp4", "sparse": "HDfluid_sparse.mp4"},
        "mask": {"dense": "SEED_mask_dense.mp4", "sparse": "SEED_mask_sparse.mp4"},
        "intens": {"dense": "SEED_mask_dense.mp4", "sparse": "SEED_mask_sparse.mp4"},
    }
    VERS = [
        ("noise", "1 · Start from noise (txt2img)"),
        ("noisecut", "2 · Découpe auto <span class='drv'>= recette 1 découpée</span>"),
        ("fluid", "3 · Start from fluid (img2img 0.8)"),
        ("mask", "4 · Masked-gen (inpaint)"),
        (
            "intens",
            "5 · Intensité continue <span class='drv'>= recette 4 × densité (post-traitement, pas de génération)</span>",
        ),
    ]
    sections = ""
    for ver, title in VERS:
        # skip a recipe entirely if none of its clips exist
        any_clip = any(exists(f"V2hd_{ver}_{fk}_{pk}.mp4") for fk in FLU for _, pk in PKS)
        if not any_clip:
            continue
        rows = ""
        for fk, flab in [("dense", "Dense"), ("sparse", "Sparse")]:
            cells = "".join(vid(f"V2hd_{ver}_{fk}_{pk}.mp4") for _, pk in PKS)
            rows += f'<div class="row"><div class="rlab">{flab}</div>{vid("HDfluid_"+fk,"fluidcell")}{vid(SEED[ver][fk],"seed")}{cells}</div>'
        win = ver == "mask"
        sections += f"""<section class="vblock{' win' if win else ''}">
          <div class="vhead"><h2>{title}</h2></div>
          <div class="colhead"><span></span><span>Fluide</span><span>Seed</span><span>Lava</span><span>Flowers</span><span>Lightning</span><span>Trees</span></div>
          <div class="grid">{rows}</div>
        </section>"""
    html = f"""<div class="wrap">
      <div class="eyebrow">Kaika · AI-stylize · matrice HD (Z-Image Turbo)</div>
      <h1>La matrice, en modèle HD</h1>
      <p class="sub">Mêmes recettes, mais générées avec <b>Z-Image Turbo</b> (~6 Md param) au lieu de SD-Turbo. Chaque ligne&nbsp;: fluide source, seed, puis les 4 prompts. La recette 4 (inpaint) est photoréaliste.</p>
      {sections}
      <footer class="foot">Z-Image Turbo · 448&#215;800 · 8 pas · guidance 0 · recettes 3/4 sans ControlNet · recettes 2/5 dérivées par post-traitement.</footer>
    </div>
    <style>
      :root{{ --bg:#0c0d11; --panel:#15161d; --panel2:#1b1d26; --line:#282a36; --ink:#eef0f6; --dim:#9aa0b4; --faint:#6b7186; --acc:#5b9bff; --seed:#c98be0; --fluid:#ff9d4d; --ok:#4bd6a0; --screen:#000; }}
      :root[data-theme="light"]{{ --bg:#eceef4; --panel:#fff; --panel2:#f4f5fa; --line:#dfe2ec; --ink:#1a1c24; --dim:#565c72; --faint:#8991a6; }}
      @media (prefers-color-scheme:light){{ :root:not([data-theme="dark"]){{ --bg:#eceef4; --panel:#fff; --panel2:#f4f5fa; --line:#dfe2ec; --ink:#1a1c24; --dim:#565c72; --faint:#8991a6; }} }}
      *{{ box-sizing:border-box; }}
      body{{ margin:0; color:var(--ink); background:radial-gradient(1000px 480px at 82% -8%, rgba(255,157,77,.10), transparent 60%), var(--bg); font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; line-height:1.5; -webkit-font-smoothing:antialiased; }}
      .wrap{{ max-width:1080px; margin:0 auto; padding:clamp(18px,3.5vw,46px); }}
      .eyebrow{{ font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:12px; letter-spacing:.14em; text-transform:uppercase; color:var(--fluid); }}
      h1{{ font-size:clamp(23px,3.4vw,34px); line-height:1.13; margin:.35em 0 .3em; font-weight:650; }}
      .sub{{ color:var(--dim); max-width:80ch; margin:0; font-size:16px; }} .sub b{{ color:var(--ink); }}
      .vblock{{ margin-top:30px; padding-top:20px; border-top:1px solid var(--line); }}
      .vblock.win{{ background:linear-gradient(180deg,color-mix(in srgb,var(--ok) 6%,transparent),transparent); border:1px solid color-mix(in srgb,var(--ok) 30%,var(--line)); border-radius:14px; padding:18px; margin-inline:-18px; }}
      .vhead h2{{ font-size:19px; margin:0 0 8px; font-weight:640; }}
      .drv{{ font-size:12px; font-weight:400; color:var(--faint); font-family:ui-monospace,monospace; }}
      .colhead,.row{{ display:grid; grid-template-columns:46px 1fr 1fr 1fr 1fr 1fr 1fr; gap:7px; }}
      .colhead{{ margin-bottom:6px; }}
      .colhead span{{ font-family:ui-monospace,monospace; font-size:10px; letter-spacing:.03em; text-transform:uppercase; color:var(--faint); text-align:center; }}
      .colhead span:nth-child(2){{ color:var(--fluid); }} .colhead span:nth-child(3){{ color:var(--seed); }}
      .row{{ margin-bottom:7px; align-items:center; }}
      .rlab{{ font-family:ui-monospace,monospace; font-size:10.5px; color:var(--dim); text-align:right; }}
      .screen{{ background:var(--screen); border:1px solid var(--line); border-radius:8px; overflow:hidden; aspect-ratio:448/800; display:flex; align-items:center; justify-content:center; }}
      .screen.empty{{ color:var(--faint); font-size:12px; }}
      .screen.fluidcell{{ border-color:color-mix(in srgb,var(--fluid) 45%,var(--line)); }}
      .screen.seed{{ border-color:color-mix(in srgb,var(--seed) 45%,var(--line)); }}
      .screen video{{ width:100%; height:100%; object-fit:cover; display:block; }}
      @media (max-width:640px){{ .colhead,.row{{ grid-template-columns:26px 1fr 1fr 1fr 1fr 1fr 1fr; gap:3px; }} .colhead span{{ font-size:7px; }} .rlab{{ font-size:8px; }} }}
      .foot{{ margin-top:30px; padding-top:18px; border-top:1px solid var(--line); color:var(--faint); font-size:11.5px; font-family:ui-monospace,monospace; }}
    </style>"""
    Path(scratch, "hd_matrix.html").write_text(html)
    print("wrote", len(html))


if __name__ == "__main__":
    scratch = sys.argv[1]
    build_fluid_clips()
    derive("mask", "intens", lambda g, d: intensity(d))  # recipe 5
    derive("noise", "noisecut", lambda g, d: geo_cut(g, d))  # recipe 2 (if recipe 1 done)
    build_html(scratch)
