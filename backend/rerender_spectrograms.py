"""Re-render existing projects' spectrograms with the current BG_COLOR/COLORMAPS.

New uploads already render with the current (light) settings; run this once to
update projects that were separated before the theme change:

    python -m backend.rerender_spectrograms
"""
from __future__ import annotations

from . import app as A


def main() -> None:
    if not A.SPECTRO_DIR.is_dir():
        print("nothing to do — no spectrograms dir at", A.SPECTRO_DIR)
        return
    jobs = sorted(p.name for p in A.SPECTRO_DIR.iterdir() if p.is_dir())
    if not jobs:
        print("no projects to re-render under", A.SPECTRO_DIR)
        return
    for job_id in jobs:
        out = A.SPECTRO_DIR / job_id
        for stem in A.STEMS:
            src = A.stem_audio_path(job_id, stem)
            if src is None:
                print(f"  {job_id}/{stem}: source audio missing — skipped")
                continue
            A.make_spectrogram(src, out / f"{stem}.png", A.COLORMAPS[stem])
        print(f"  {job_id}: re-rendered")
    print(f"done — {len(jobs)} project(s)")


if __name__ == "__main__":
    main()
