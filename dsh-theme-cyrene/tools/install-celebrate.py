"""Install the end-of-turn animation.

    python tools/install-celebrate.py <path-to.gif>

Writes three things into `brand/`:

    celebrate.webp        the animation, background removed
    celebrate-last.webp   the final frame, held after the animation finishes
    celebrate.json        { "ms": <animation duration>, "frames": <count> }

## The background

Removed by **flood fill from the corners**, not by a colour threshold. The obvious
approach — make every white pixel transparent — also eats her hat, the highlights
in her hair and the whites of her eyes, because they are the same white as the
backdrop. Flood filling only the region actually connected to the edges takes the
backdrop and leaves everything inside the frame alone.

The frame in this artwork is opaque and encloses her, which is what makes the fill
safe: it cannot leak inward. Pass `--no-key` for an image that already has alpha.

## Fitting a long animation into a short slot

`--fit-ms 3000` scales every frame delay so the whole sequence lands inside three
seconds, ending with a brief rest on the last frame. Without it the animation plays
at its authored speed, however long that is. Scaling is the honest way to shorten:
dropping frames would break the sequence, and truncating it would cut the motion
mid-gesture.

## The timing

The client has to know when the animation ends so it can swap to the still — a GIF
loops by a count baked into the file, so an `<img>` cannot be told to stop on the
last frame. Measuring that means reading every frame's delay, which is a decoding
job; `build.mjs` only builds. So it is measured here, once, at the only moment the
artwork can change.

Then rebuild:

    node build.mjs
"""

import json
import sys
from collections import deque
from pathlib import Path

from PIL import Image, ImageSequence

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "brand"

# How close to the corner colour counts as backdrop. Generous, because GIF
# palettes quantise and the edge is rarely a flat value.
TOLERANCE = 30

# Must match CELEBRATE_FADE_MS and CELEBRATE_TOTAL_MS in lib/client/85-celebrate.js.
FADE_MS = 320

# The last frame's rest before the fade. Must match CELEBRATE_HOLD_MS in
# lib/client/85-celebrate.js — the client is what actually holds it, and a report
# quoting a different number than the code applies is worse than no report.
HOLD_MS = 700


def key_out(img, tolerance=TOLERANCE):
    """Make the corner-connected background transparent, in place."""
    img = img.convert("RGBA")
    width, height = img.size
    pixels = img.load()

    # The four corners are the background by definition; the fill starts there.
    seeds = [(0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)]
    reference = [pixels[x, y] for x, y in seeds]

    def is_background(pixel):
        for ref in reference:
            if (
                abs(pixel[0] - ref[0]) <= tolerance
                and abs(pixel[1] - ref[1]) <= tolerance
                and abs(pixel[2] - ref[2]) <= tolerance
            ):
                return True
        return False

    seen = bytearray(width * height)
    queue = deque()
    for x, y in seeds:
        seen[y * width + x] = 1
        queue.append((x, y))

    cleared = 0
    while queue:
        x, y = queue.popleft()
        if not is_background(pixels[x, y]):
            continue
        pixels[x, y] = (0, 0, 0, 0)
        cleared += 1
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < width and 0 <= ny < height and not seen[ny * width + nx]:
                seen[ny * width + nx] = 1
                queue.append((nx, ny))

    return img, cleared / (width * height)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    do_key = "--no-key" not in sys.argv

    fit_ms = None
    for index, value in enumerate(sys.argv):
        if value == "--fit-ms" and index + 1 < len(sys.argv):
            fit_ms = int(sys.argv[index + 1])
        elif value.startswith("--fit-ms="):
            fit_ms = int(value.split("=", 1)[1])

    if not args:
        print(__doc__)
        return 1

    src = Path(args[0])
    if not src.exists():
        print(f"  no such file: {src}")
        return 1

    OUT.mkdir(exist_ok=True)

    with Image.open(src) as im:
        frames = getattr(im, "n_frames", 1)
        size = im.size
        print(f"  source : {src.name}")
        print(f"  size   : {size[0]}x{size[1]}   frames: {frames}")

        rgba = [f.convert("RGBA") for f in ImageSequence.Iterator(im)]
        delays = []
        with Image.open(src) as again:
            for frame in ImageSequence.Iterator(again):
                delays.append(frame.info.get("duration", again.info.get("duration", 0)) or 0)

        if do_key:
            rgba[0], share = key_out(rgba[0])
            print(f"  keyed  : {share * 100:.1f}% of frame 1 was corner-connected background")
            for index in range(1, len(rgba)):
                rgba[index], _ = key_out(rgba[index])

        total = sum(delays)
        if fit_ms is not None and total > 0:
            # The animation gets the total minus the fade minus a short rest, so
            # the last frame is held rather than passed through at speed.
            budget = max(1, fit_ms - FADE_MS - HOLD_MS)
            factor = budget / total
            delays = [max(1, round(delay * factor)) for delay in delays]
            scaled = sum(delays)
            print(f"  fit    : {total} ms -> {scaled} ms (x{factor:.3f}, all {frames} frames kept)")
            total = scaled
        if total == 0 and frames > 1:
            # A GIF whose delays are all zero still animates: browsers substitute
            # their own default. Reporting a zero-length animation would make the
            # client swap to the still instantly, which looks like a broken image.
            total = frames * 100
            print(f"  ⚠️ no frame delays in the file; assuming 100 ms/frame -> {total} ms")
        print(f"  total  : {total} ms  ({total / 1000:.2f} s)")

        common = {"duration": delays if sum(delays) > 0 else 100, "loop": 0, "quality": 92, "method": 6}
        rgba[0].save(OUT / "celebrate.webp", "WEBP", save_all=True, append_images=rgba[1:], **common)
        rgba[-1].save(OUT / "celebrate-last.webp", "WEBP", quality=92, method=6)

    (OUT / "celebrate.json").write_text(
        json.dumps({"ms": total, "frames": frames, "width": size[0], "height": size[1]}, indent=2) + "\n",
        encoding="utf-8",
    )
    for name in ("celebrate.webp", "celebrate-last.webp", "celebrate.json"):
        print(f"  wrote brand/{name}   {(OUT / name).stat().st_size:,} bytes")

    slot = fit_ms if fit_ms is not None else total + FADE_MS + HOLD_MS
    hold = HOLD_MS if fit_ms is None else max(0, slot - FADE_MS - total)
    print(
        f"\n  overlay {slot / 1000:.2f} s total: {total / 1000:.2f} s animating, "
        f"{hold / 1000:.2f} s resting on the last frame, {FADE_MS / 1000:.2f} s fading"
    )
    print("  next: node build.mjs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
