"""Re-render existing projects' spectrograms with the current BG_COLOR/COLORMAPS.

New uploads already render with the current (light) settings; run this once to
update projects that were separated before the theme change:

    python -m backend.rerender_spectrograms
"""

from __future__ import annotations

from .media import make_spectrogram, stem_audio_path
from .paths import COLORMAPS, SPECTRO_DIR, STEMS


def main() -> None:
    if not SPECTRO_DIR.is_dir():
        print("nothing to do — no spectrograms dir at", SPECTRO_DIR)
        return
    jobs = sorted(p.name for p in SPECTRO_DIR.iterdir() if p.is_dir())
    if not jobs:
        print("no projects to re-render under", SPECTRO_DIR)
        return
    for job_id in jobs:
        out = SPECTRO_DIR / job_id
        for stem in STEMS:
            src = stem_audio_path(job_id, stem)
            if src is None:
                print(f"  {job_id}/{stem}: source audio missing — skipped")
                continue
            make_spectrogram(src, out / f"{stem}.png", COLORMAPS[stem])
        print(f"  {job_id}: re-rendered")
    print(f"done — {len(jobs)} project(s)")


if __name__ == "__main__":
    main()
