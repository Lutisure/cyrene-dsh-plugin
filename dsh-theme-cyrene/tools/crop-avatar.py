"""Crop Cyrene's portrait out of the wallpaper still.

The still is the poster frame of the wallpaper video, so it is the one place a
face is available without decoding the video. The output feeds the collapsed
dock dot, which renders at 42 px, so the crop is chosen by *looking* at that
size rather than by arithmetic.

    python tools/crop-avatar.py            # contact sheet of candidates
    python tools/crop-avatar.py --write    # write brand/cyrene-avatar.webp + size preview
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "Default_cyrene-still.webp"
# Kept out of `assets/` on purpose: everything there is offered as a wallpaper,
# and her portrait should not appear in the Scene grid.
OUT = ROOT / "brand" / "cyrene-avatar.webp"

# Source is 2560x1440. She sits on the left, the cage holds the light on the
# right, so the portrait has to come from the left half.
CANDIDATES = [
    ("A 头肩", (830, 700, 1150, 1020)),
    ("B 头部", (890, 750, 1110, 970)),
    ("C 上半身", (740, 640, 1260, 1160)),
    ("D 连手", (700, 630, 1300, 1230)),
]

# Head plus shoulders: enough silhouette to read as her at 42 px, and the horns
# survive the downscale, which is what makes the dot recognisable at all.
# A wider frame was tried and rejected — it traded her sleeve for empty pale
# wall, which the circle then showed as dead space.
CHOSEN = (824, 694, 1160, 1030)
CHOSEN_NAME = "A 头肩"


def sheet():
    if not SOURCE.exists():
        raise SystemExit(f"missing source: {SOURCE}")
    source = Image.open(SOURCE).convert("RGB")
    print(f"source {SOURCE.name}: {source.width}x{source.height}")

    cell = 260
    canvas = Image.new("RGB", (cell * len(CANDIDATES), cell + 34), (14, 12, 18))
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 14)

    for index, (label, box) in enumerate(CANDIDATES):
        crop = source.crop(box).resize((cell, cell), Image.LANCZOS)
        canvas.paste(crop, (index * cell, 0))
        draw.text((index * cell + 6, cell + 8), f"{label}  {box[2] - box[0]}px", font=font, fill=(230, 226, 238))

    out = ROOT / "docs" / "avatar-candidates.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out)
    print(f"wrote {out}")


def preview(avatar):
    """Show the round crop at the sizes it actually gets used at.

    The dot is 42 px; a portrait that reads well at 256 px can still be an
    unreadable smudge there, so it is checked by looking.
    """
    sizes = [96, 64, 42, 32]
    pad = 24
    width = sum(size + pad for size in sizes) + pad
    height = max(sizes) + pad * 2
    canvas = Image.new("RGB", (width, height), (17, 15, 21))
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 13)

    x = pad
    for size in sizes:
        # The mask must match the pasted size, not the supersampled one.
        tile = avatar.resize((size, size), Image.LANCZOS).convert("RGBA")
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
        canvas.paste(tile, (x, pad + (max(sizes) - size) // 2), mask)
        draw.text((x, height - pad + 2), f"{size}px", font=font, fill=(150, 144, 164))
        x += size + pad

    out = ROOT / "docs" / "avatar-preview.png"
    canvas.save(out)
    print(f"wrote {out}")


def write():
    source = Image.open(SOURCE).convert("RGB")
    # 256 px is ample for a 42 px dot and for a 2x display.
    avatar = source.crop(CHOSEN).resize((256, 256), Image.LANCZOS)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    avatar.save(OUT, format="WEBP", quality=92, method=6)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {CHOSEN_NAME} {CHOSEN})")
    preview(avatar)


if __name__ == "__main__":
    sheet()
    if "--write" in sys.argv:
        write()
