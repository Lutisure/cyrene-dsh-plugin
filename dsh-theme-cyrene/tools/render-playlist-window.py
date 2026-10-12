"""Side-by-side: the music panel before and after the playlist became a window.

Generates its own inputs rather than reading committed screenshots: it renders
the probe page twice through headless Chromium — once with the shipped height
rule, once with the old `max-height: 168px` swapped back in — so the figure can
never drift from the code it claims to describe.

    python tools/render-playlist-window.py
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "playlist-window.png"
PROBE = ROOT / "tools" / "probe-panel.mjs"

EDGE_CANDIDATES = [
    Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
    Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
]

# Microsoft YaHei, like the other render tools here. Pillow's default face has no
# CJK glyphs, so font discovery that stops at Arial boxes every Chinese
# character — which is how this sheet first came out.
FONT_DIR = Path(r"C:\Windows\Fonts")
_fonts: dict[tuple[int, bool], ImageFont.FreeTypeFont] = {}

INK = (232, 226, 238)
DIM = (150, 142, 160)
PINK = (247, 201, 218)
BG = (23, 19, 28)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    key = (size, bold)
    if key in _fonts:
        return _fonts[key]
    for name in (("msyhbd.ttc", "msyh.ttc") if bold else ("msyh.ttc", "msyhbd.ttc")):
        try:
            _fonts[key] = ImageFont.truetype(str(FONT_DIR / name), size)
            return _fonts[key]
        except OSError:
            continue
    _fonts[key] = ImageFont.load_default()
    return _fonts[key]


def find_browser() -> Path:
    for candidate in EDGE_CANDIDATES:
        if candidate.exists():
            return candidate
    raise SystemExit("no Chromium found; set one of EDGE_CANDIDATES")


def shot(browser: Path, page: Path, out: Path, window: str) -> None:
    subprocess.run(
        [
            str(browser),
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            f"--user-data-dir={Path(tempfile.gettempdir()) / 'cyrene-figure'}",
            f"--window-size={window}",
            "--virtual-time-budget=5000",
            f"--screenshot={out}",
            page.as_uri(),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=180,
    )


def main() -> int:
    browser = find_browser()
    work = Path(tempfile.mkdtemp(prefix="cyrene-figure-"))

    # 1. Ask the probe to build its page, then keep a copy of the source.
    page_current = work / "current.html"
    env = {**os.environ, "CYRENE_PROBE_OUT": str(page_current), "CYRENE_SONGS": "6"}
    subprocess.run(
        ["node", str(PROBE)],
        check=True,
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        timeout=120,
    )
    source = page_current.read_text(encoding="utf-8")

    # 2. The "before" page is the same page with the old rule put back. The
    #    window height is the only difference between the two halves, so the
    #    figure isolates that one change.
    before_source = source.replace(
        "height: var(--cy-playlist-h);", "max-height: 168px;"
    )
    if before_source == source:
        raise SystemExit("could not find the playlist height rule to swap out")

    page_before = work / "before.html"
    page_before.write_text(before_source, encoding="utf-8")

    # 3. Render both. Wide enough that nothing is clipped by the viewport.
    before_png = work / "before.png"
    after_png = work / "after.png"
    shot(browser, page_before, before_png, "760,900")
    shot(browser, page_current, after_png, "760,900")

    # 4. Compose. The panel sits at a fixed offset in both renders, so cropping
    #    the same box from each keeps them comparable.
    box = (194, 45, 566, 500)
    panel_w, panel_h = box[2] - box[0], box[3] - box[1]

    with Image.open(before_png) as image:
        before = image.convert("RGB").crop(box).copy()
    with Image.open(after_png) as image:
        after = image.convert("RGB").crop(box).copy()

    gap, pad, head, foot = 28, 24, 74, 34
    sheet = Image.new("RGB", (pad * 2 + panel_w * 2 + gap, head + panel_h + foot), BG)
    draw = ImageDraw.Draw(sheet)

    sheet.paste(before, (pad, head))
    sheet.paste(after, (pad + panel_w + gap, head))

    draw.text((pad, 20), "改前 · max-height 168px", font=font(15, True), fill=DIM)
    draw.text((pad + panel_w + gap, 20), "改后 · height 108px", font=font(15, True), fill=PINK)
    draw.text((pad, 46), "6 行全部撑开，面板 445px", font=font(12), fill=DIM)
    draw.text((pad + panel_w + gap, 46), "4 行 + 滚动条，面板 391px", font=font(12), fill=PINK)
    draw.text((pad, head + panel_h + 10), "同一个 6 首歌单，同一套渲染", font=font(11), fill=DIM)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(OUT)
    print(f"wrote {OUT}  ({sheet.width}x{sheet.height})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
