"""Build the emote set from the harvested artwork.

The client's emote easter egg matches transcript text against **`EMOTE_TRIGGERS`
labels**, and a label is the filename with its extension stripped
(`build.mjs`: `labelOf`). So the filenames are not a convention here, they *are*
the contract — `开心.webp` is what makes the word 「谢谢」 light something up.

Every label is served by one of the official chat stickers, which already carry
exactly those expressions. Five labels ship: 开心 / 得意 / 没错 / 期待 / 疑惑.
The sixth label, 变身, is gone — see `ANIMATED` below.

    python tools/build-emotes.py            # contact sheet for review
    python tools/build-emotes.py --write    # also write GIF/emotes/
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SOURCE_DIR = ROOT / "brand" / "pet"
OUT_DIR = ROOT / "GIF" / "emotes"
DOCS = ROOT / "docs"

# The overlay draws these at 148 px wide; 256 keeps them crisp on a 2x display
# without carrying pixels nothing will ever show.
SIZE = 256

# Label -> which sticker wears that expression.
#
# Read off `docs/pet-assets.png` by looking, and then re-read off the rendered
# contact sheet: the first pass had 没错 on the crossed-arms pout and 期待 on a
# wink, which is backwards. The numbered filenames mean nothing, so the only way
# to place them is to look at them.
STILLS = {
    "开心": "sticker-ppg-24-cyrene-01.webp",  # eyes closed, tongue out
    "期待": "sticker-ppg-24-cyrene-02.webp",  # star eyes, excited — anticipating
    "得意": "sticker-ppg-24-cyrene-03.webp",  # smug, hand under chin
    "疑惑": "sticker-ppg-24-cyrene-04.webp",  # lowered brows, arms crossed — sceptical
    "没错": "sticker-ppg-24-cyrene-05.webp"   # confident wink with sparkles
}

# No animated emote. 变身 was the only one and was removed on request; the splash
# art it was built from is still in brand/pet/ if it comes back. Kept as an empty
# mapping rather than deleted so the pipeline still handles the animated case —
# and so re-adding one is a one-line change.
ANIMATED = {}
ANIM_FRAMES = 16
ANIM_MS = 80


def load(name):
    path = SOURCE_DIR / name
    if not path.exists():
        raise SystemExit(f"missing source: {path}  (run tools/harvest-assets.py first)")
    return Image.open(path).convert("RGBA")


def upper_body(image, fraction=0.58):
    """Crop to the top of the opaque content — head and torso of a full-body art.

    Derived from the alpha bounding box rather than guessed coordinates, so it
    keeps working if the artwork is ever replaced.
    """
    box = image.getchannel("A").getbbox()
    if box is None:
        return image
    left, top, right, bottom = box
    height = bottom - top
    return image.crop((left, top, right, top + round(height * fraction)))


def fit(image, size=SIZE):
    """Scale into a square, centred, preserving aspect."""
    copy = image.copy()
    copy.thumbnail((size, size), Image.LANCZOS)
    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    tile.paste(copy, ((size - copy.width) // 2, (size - copy.height) // 2), copy)
    return tile


def glow(image, colour, radius, strength):
    """A soft halo taken from the artwork's own silhouette."""
    alpha = image.getchannel("A").filter(ImageFilter.GaussianBlur(radius))
    halo = Image.new("RGBA", image.size, colour + (0,))
    halo.putalpha(alpha.point(lambda value: int(value * strength)))
    return halo


def build_animated(source):
    """A power-up beat: a flash, a settle, and rising sparkles."""
    base = fit(source)
    colour = (255, 190, 230)
    frames = []
    rng = np.random.default_rng(20260107)

    # Sparkles drift upward across the whole loop, so the motion reads as
    # continuous rather than restarting at the seam.
    stars = [(rng.integers(30, SIZE - 30), rng.integers(40, SIZE - 20), rng.integers(2, 5)) for _ in range(14)]

    for index in range(ANIM_FRAMES):
        t = index / ANIM_FRAMES
        # A quick overshoot in the first quarter, then a gentle breathing pulse.
        if t < 0.25:
            scale = 0.90 + (t / 0.25) * 0.16
            flash = (1 - t / 0.25) * 0.55
        else:
            settle = (t - 0.25) / 0.75
            scale = 1.06 - settle * 0.05 + 0.012 * np.sin(settle * np.pi * 2)
            flash = 0.0

        tile = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        grown = base.resize((round(SIZE * scale), round(SIZE * scale)), Image.LANCZOS)
        offset = ((SIZE - grown.width) // 2, (SIZE - grown.height) // 2)
        tile.paste(glow(grown, colour, 12, 0.35), offset, glow(grown, colour, 12, 0.35))
        tile.paste(grown, offset, grown)
        if flash > 0:
            wash = Image.new("RGBA", tile.size, (255, 255, 255, int(255 * flash)))
            tile = Image.alpha_composite(tile, wash)

        draw = ImageDraw.Draw(tile, "RGBA")
        for star_x, star_y, star_r in stars:
            progress = (t + star_x / SIZE) % 1.0
            y = star_y - progress * 90
            alpha = int(200 * (1 - abs(progress - 0.5) * 2))
            if alpha <= 0:
                continue
            draw.ellipse(
                (star_x - star_r, y - star_r, star_x + star_r, y + star_r),
                fill=(255, 245, 252, alpha)
            )
        frames.append(tile)
    return frames


def contact_sheet(stills, animated):
    cell = 220
    labels = list(stills.keys()) + list(animated.keys())
    canvas = Image.new("RGB", (cell * len(labels), cell + 30), (20, 17, 25))
    draw = ImageDraw.Draw(canvas)
    face = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 15)
    for index, label in enumerate(labels):
        source = stills.get(label) or animated[label][len(animated[label]) // 3]
        tile = Image.new("RGB", (cell, cell), (30, 26, 38))
        shown = source.resize((cell - 20, cell - 20), Image.LANCZOS)
        tile.paste(shown, (10, 10), shown)
        canvas.paste(tile, (index * cell, 0))
        kind = "animated webp" if label in animated else "webp"
        draw.text((index * cell + 8, cell + 6), f"{label}  ({kind})", font=face, fill=(224, 218, 232))
    out = DOCS / "emote-set.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out)
    print(f"wrote {out} ({len(labels)} emotes)")


def main():
    write = "--write" in sys.argv
    stills = {}
    for label, name in STILLS.items():
        stills[label] = fit(load(name))
    animated = {label: build_animated(upper_body(load(name))) for label, name in ANIMATED.items()}

    for label, tile in stills.items():
        print(f"  {label:<4} still   {tile.width}x{tile.height}  from {STILLS[label]}")
    for label, frames in animated.items():
        print(f"  {label:<4} gif     {len(frames)} frames x {ANIM_MS}ms  from {ANIMATED[label]}")

    contact_sheet(stills, animated)

    if not write:
        print("\nre-run with --write to populate GIF/emotes/")
        return

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for label, tile in stills.items():
        target = OUT_DIR / f"{label}.webp"
        tile.save(target, format="WEBP", quality=92, method=6)
        print(f"  wrote {target.relative_to(ROOT)}  ({target.stat().st_size / 1024:.0f} KB)")
    for label, frames in animated.items():
        # Animated WebP, not GIF. GIF cannot carry partial alpha, so it forces the
        # whole frame opaque — and it cost 460 KB for this loop versus a fraction
        # of that here. The build's `ANIM_EXT` and the overlay's plain <img> both
        # already accept .webp, so nothing else has to change.
        target = OUT_DIR / f"{label}.webp"
        frames[0].save(
            target,
            format="WEBP",
            save_all=True,
            append_images=frames[1:],
            duration=ANIM_MS,
            loop=0,
            quality=82,
            alpha_quality=80,
            method=6
        )
        print(f"  wrote {target.relative_to(ROOT)}  ({target.stat().st_size / 1024:.0f} KB, {len(frames)} frames)")


if __name__ == "__main__":
    main()
