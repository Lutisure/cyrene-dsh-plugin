"""Render the DSH boot animation: floating words, then the wordmark.

The animation is **transparent**. It is not a page of artwork — the overlay
supplies a flat scrim and this asset floats on top of it, so what the words and
the logo sit on is the dimmed application rather than a picture.

That decision removed most of the previous pipeline. The first version composited
over a full-bleed starfield, which forced the dialogue out of the plate first —
vertical interpolation, matched film grain, feathered edges — because baked-in
text cannot be animated. With no starfield to composite onto, none of that is
needed: the source frame is now read only to *measure* where the words sit and
how big they are, and the words are drawn straight onto transparency.

    python tools/render-boot.py            # frames for review
    python tools/render-boot.py --write    # also write GIF/cyrene-boot.webp
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "brand" / "boot-source.png"
LOGO_SOURCE = ROOT / "brand" / "boot-logo-source.png"
OUT = ROOT / "GIF" / "cyrene-boot.webp"

# The words from the supplied card, in source order.
LINES = ["翻开这本书吧，", "我会在过去等你。"]

# 16:9, transparent.
WIDTH, HEIGHT = 1200, 675

# The words are sized for reading rather than copied at the source's scale. In
# the original they occupied 10% of a 2282 px frame because they sat inside a
# wide landscape; here they are the hero of their own beat, and the asset is
# displayed at roughly 900 px, so 22% of the canvas puts them around 30 px per
# character on screen.
WORD_WIDTH = 0.24
# Original line spacing was 74 px under a 231 px line — keep that relationship.
LINE_SPACING_RATIO = 74 / 231

FPS = 60
DURATION = 4.2
QUALITY = 86
ALPHA_QUALITY = 80

# The timeline, in seconds. Written as seconds rather than as fractions so the
# beats can be reasoned about directly, and ordered so that **each beat owns the
# frame**: the words finish leaving (2.50) before the wordmark starts arriving
# (2.62). Letting those two overlap put 「翻开这本书吧」 on top of the logo.
BEAT = {
    "line1": (0.30, 1.05),
    "line2": (0.85, 1.60),
    "lines_out": (2.00, 2.50),
    "logo_in": (2.62, 3.42),
}

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhl.ttc",  # Light: closest to the supplied card
    r"C:\Windows\Fonts\msyh.ttc",
]

# Keying thresholds for the logo card, chosen from measurements rather than by
# eye: background residue peaks at a colour distance of ~14 from the flat
# lavender, and her pale line art starts at ~29. 18 sits in the empty band
# between them, and the floor drops the faint wash that would otherwise show as
# a grey rectangle over a dark scrim.
LOGO_LO, LOGO_HI, LOGO_FLOOR = 18.0, 50.0, 0.25
# A channel watermark in the top-right corner of the supplied frame.
LOGO_MASK = (0, 36, 1690, None)
LOGO_SCALE = 0.94

# Alpha ramps are quantised to this many steps. A continuous ramp makes every
# frame unique and WebP stores whole frames, so the logo's fade alone cost ~48
# full encodes. At 60 fps a 20-step ramp over 0.8 s is visually identical and
# lets the repeats merge away.
FADE_STEPS = 20


def font(size):
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    raise SystemExit("no CJK font found")


def ease(value):
    """Clamp to 0..1 and decelerate into place."""
    if value <= 0:
        return 0.0
    if value >= 1:
        return 1.0
    return 1 - (1 - value) ** 3


def beat(name, elapsed):
    """Eased progress through one beat, given elapsed seconds."""
    start, end = BEAT[name]
    return ease((elapsed - start) / (end - start))


def measure_source():
    """Where the words sit and how big they are, read off the supplied frame.

    This is now the only thing the starfield frame is used for. The metrics come
    from the pixels rather than from guessing: the rows carrying text are dense
    runs of near-white, which separates them from stars.
    """
    source = Image.open(SOURCE).convert("RGB")
    arr = np.asarray(source).astype(np.float32)
    col = arr.mean(axis=(0, 2))
    row = arr.mean(axis=(1, 2))
    xs = np.nonzero(col > 2)[0]
    ys = np.nonzero(row > 2)[0]
    if len(xs) == 0 or len(ys) == 0:
        raise SystemExit("the source looks entirely black")
    x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())
    sub = arr[y0 : y1 + 1, x0 : x1 + 1]

    white = sub.min(axis=2) > 190
    dense = np.nonzero(white.sum(axis=1) > 40)[0]
    if len(dense) == 0:
        raise SystemExit("no text rows found — did the source change?")

    runs = []
    start = prev = int(dense[0])
    for y in dense[1:]:
        y = int(y)
        if y - prev > 6:
            runs.append((start, prev))
            start = y
        prev = y
    runs.append((start, prev))

    measured = []
    for top, bottom in runs:
        cols = np.nonzero(white[top : bottom + 1].any(axis=0))[0]
        measured.append(
            {
                "top": top,
                "height": bottom - top + 1,
                "width": int(cols.max() - cols.min() + 1),
            }
        )
    print(f"source text: {len(measured)} band(s) in a {x1 - x0 + 1}x{y1 - y0 + 1} frame")
    for band in measured:
        print(f"  top {band['top']}, {band['width']}px wide, {band['height']}px tall")
    return measured


def load_logo():
    """The closing logo card, keyed off its flat lavender field."""
    source = Image.open(LOGO_SOURCE).convert("RGB")
    arr = np.asarray(source).astype(np.float32)
    background = arr[0:40, 0:60].reshape(-1, 3).mean(axis=0)
    distance = np.sqrt(((arr - background) ** 2).sum(axis=2))

    alpha = np.clip((distance - LOGO_LO) / (LOGO_HI - LOGO_LO), 0, 1)
    alpha[alpha < LOGO_FLOOR] = 0.0
    top, bottom, left, right = LOGO_MASK
    alpha[top:bottom, left:right] = 0.0

    print(
        f"logo {source.width}x{source.height} keyed: "
        f"{(alpha < 0.02).mean():.0%} clear, {(alpha > 0.98).mean():.0%} solid, "
        f"{((alpha >= 0.02) & (alpha <= 0.98)).mean():.0%} partial"
    )
    return Image.fromarray(np.dstack([np.asarray(source), (alpha * 255).astype(np.uint8)]), "RGBA")


def fit_font(text, target_width, limit=200):
    """Pick the size whose rendered width is closest to the target."""
    best = None
    for size in range(12, limit):
        candidate = font(size)
        box = candidate.getbbox(text)
        width = box[2] - box[0]
        if best is None or abs(width - target_width) < abs(best[1] - target_width):
            best = (size, width)
    return font(best[0]), best[0], best[1]


def render_frames(logo, frames_total, fps):
    window = round(WIDTH * WORD_WIDTH)
    face, size, rendered = fit_font(LINES[0], window)
    spacing = round(rendered * LINE_SPACING_RATIO)

    # Centred vertically as a block, so the two lines sit where the eye expects a
    # title to be rather than where they happened to fall in the wide frame.
    block = spacing + size * 1.4
    first_top = round((HEIGHT - block) / 2)

    mark = logo.copy()
    mark.thumbnail((round(WIDTH * LOGO_SCALE), round(HEIGHT * LOGO_SCALE)), Image.LANCZOS)

    print(f"words: font {size}px, line 1 renders {rendered}px, spacing {spacing}px, block top {first_top}")
    print(f"logo: {mark.width}x{mark.height} at {LOGO_SCALE:.0%} of the canvas")
    print(f"timeline: {frames_total} frames at {fps} fps = {DURATION}s, transparent")

    frames = []
    for index in range(frames_total):
        elapsed = (index / (frames_total - 1)) * DURATION
        # RGBA from the start: there is no background to composite onto, which is
        # the whole point of this version.
        frame = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))

        mark_t = round(beat("logo_in", elapsed) * FADE_STEPS) / FADE_STEPS
        if mark_t > 0:
            grown = mark
            if mark_t < 1:
                grown = mark.copy()
                grown.putalpha(mark.getchannel("A").point(lambda v: int(v * mark_t)))
            frame.paste(
                grown,
                (
                    (WIDTH - grown.width) // 2,
                    (HEIGHT - grown.height) // 2 - round((1 - mark_t) * 14),
                ),
                grown,
            )

        draw = ImageDraw.Draw(frame, "RGBA")
        for offset, text, name in ((0, LINES[0], "line1"), (1, LINES[1], "line2")):
            appear = round(beat(name, elapsed) * FADE_STEPS) / FADE_STEPS
            if appear <= 0:
                continue
            alpha = appear * (1.0 - round(beat("lines_out", elapsed) * FADE_STEPS) / FADE_STEPS)
            if alpha <= 0.004:
                continue
            box = face.getbbox(text)
            x = (WIDTH - (box[2] - box[0])) // 2 - box[0]
            # The rise is driven by `appear` alone, so leaving does not drag the
            # line back down.
            y = first_top + offset * spacing + round((1 - appear) * 12) - box[1]
            draw.text((x, y), text, font=face, fill=(255, 255, 255, int(248 * alpha)))

        frames.append(frame)
    return frames


def contact_sheet(frames):
    """Frames shown on a dark grey, because the animation itself is transparent."""
    total = len(frames)
    picks = [
        0,
        round(total * 0.12),
        round(total * 0.30),
        round(total * 0.46),
        round(total * 0.58),
        round(total * 0.72),
        round(total * 0.88),
        total - 1,
    ]
    cell_w = 440
    cell_h = round(cell_w * HEIGHT / WIDTH)
    canvas = Image.new("RGB", (cell_w * 2, cell_h * 4), (10, 9, 13))
    for slot, index in enumerate(picks):
        tile = Image.new("RGB", (cell_w, cell_h), (24, 20, 30))
        shot = frames[index].resize((cell_w, cell_h), Image.LANCZOS)
        tile.paste(shot, (0, 0), shot)
        canvas.paste(tile, ((slot % 2) * cell_w, (slot // 2) * cell_h))
    out = ROOT / "docs" / "boot-frames.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out)
    print(f"wrote {out} (frames {picks}, on a dark grey standing in for the scrim)")


def encode(frames, base_ms):
    """Merge runs of identical frames into one frame with a longer duration.

    The tail of the timeline is a static hold. At 60 fps that is dozens of
    identical frames, and paying for them costs bytes while buying nothing —
    WebP stores whole frames, so a duplicate is not free the way it is in a
    delta codec.
    """
    merged = []
    durations = []
    for frame in frames:
        payload = frame.tobytes()
        if merged and payload == merged[-1][1]:
            durations[-1] += base_ms
            continue
        merged.append((frame, payload))
        durations.append(base_ms)
    return [frame for frame, _ in merged], durations


def main():
    for path in (SOURCE, LOGO_SOURCE):
        if not path.exists():
            raise SystemExit(f"missing source: {path}")

    fps = int(sys.argv[sys.argv.index("--fps") + 1]) if "--fps" in sys.argv else FPS
    quality = int(sys.argv[sys.argv.index("--quality") + 1]) if "--quality" in sys.argv else QUALITY
    alpha_quality = int(sys.argv[sys.argv.index("--alpha-quality") + 1]) if "--alpha-quality" in sys.argv else ALPHA_QUALITY
    frames_total = round(fps * DURATION)
    base_ms = round(1000 / fps)

    measure_source()
    logo = load_logo()
    check = Image.new("RGB", logo.size, (26, 22, 32))
    check.paste(logo, (0, 0), logo)
    check.save(ROOT / "docs" / "boot-logo-alpha.png", format="PNG")

    frames = render_frames(logo, frames_total, fps)
    contact_sheet(frames)
    encoded, durations = encode(frames, base_ms)
    print(f"encode: {len(frames)} rendered -> {len(encoded)} stored (holds merged)")

    if "--write" in sys.argv:
        OUT.parent.mkdir(parents=True, exist_ok=True)
        encoded[0].save(
            OUT,
            format="WEBP",
            save_all=True,
            append_images=encoded[1:],
            duration=durations,
            loop=0,
            quality=quality,
            alpha_quality=alpha_quality,
            method=6,
        )
        size = OUT.stat().st_size
        print(f"wrote {OUT} ({size / 1024:.0f} KB, {len(encoded)} frames, {fps} fps, quality {quality})")


if __name__ == "__main__":
    main()
