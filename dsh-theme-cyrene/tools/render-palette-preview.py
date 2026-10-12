"""Render a before/after preview of the theme palette.

This exists because the redesign is mostly *relational* — it is about how the
chrome sits against a wallpaper and against its own accent — and that is hard to
judge from a list of hex values in a chat window.

    <bundled python> tools/render-palette-preview.py docs/palette-before-after.png

The old values are hard-coded on purpose: they are the "before" side of a
comparison, so they must not follow future edits to the theme.
"""

import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

# ---------------------------------------------------------------- old palette
# The palette as it shipped before the Apple pass. Frozen: this is the "before".
OLD = {
    "inkDeep": "#1c1428",
    "ink": "#2b2140",
    "surface": "#3a2c52",
    "surfaceHigh": "#4b3a66",
    "mask": "#150e20",
    "borders": [(207, 168, 255, 0.16), (207, 168, 255, 0.24), (207, 168, 255, 0.34), (207, 168, 255, 0.46)],
    "shadow": (30, 12, 48, 0.40),
    "shadow_blur": 48,
    "shadow_offset": 18,
    "radius": 15,
    "hover": (255, 217, 239, 0.16),
    "spread": 24,
}

# ---------------------------------------------------------------- new palette
def load_new():
    """Read the derived palette from the theme itself.

    The theme is JavaScript, so the values are obtained by running the project's
    own dump helper rather than by reimplementing `mix()` here — a second
    implementation would silently drift from the one that ships.
    """
    import json
    import subprocess

    helper = Path(__file__).resolve().parent / "dump-palette.mjs"
    raw = subprocess.run(
        ["node", str(helper)],
        capture_output=True,
        text=True,
        check=True,
        cwd=str(Path(__file__).resolve().parent.parent),
    ).stdout
    data = json.loads(raw)
    surfaces = data["surfaces"]
    return {
        "inkDeep": surfaces["inkDeep"],
        "ink": surfaces["ink"],
        "surface": surfaces["surface"],
        "surfaceHigh": surfaces["surfaceHigh"],
        "mask": surfaces["mask"],
        "borders": [(255, 255, 255, a) for a in data["borders"]],
        "shadow": (0, 0, 0, 0.44),
        "shadow_blur": 56,
        "shadow_offset": 20,
        "radius": int(str(data["radius"]["md"]).rstrip("px")),
        "hover": (255, 255, 255, 0.07),
        "spread": data["spread"],
        "accent": data["accents"],
    }


NEW = load_new()

W, H = 1360, 1150
BG = (14, 12, 18)
FG = (240, 236, 246)
MUTED = (152, 146, 168)
ACCENT = (255, 217, 239)

FONT_PATH = r"C:\Windows\Fonts\msyh.ttc"
font_cache: dict = {}


def font(size, bold=False):
    key = (size, bold)
    if key not in font_cache:
        path = r"C:\Windows\Fonts\msyhbd.ttc" if bold and Path(r"C:\Windows\Fonts\msyhbd.ttc").exists() else FONT_PATH
        font_cache[key] = ImageFont.truetype(path, size)
    return font_cache[key]


def hx(value):
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def blend(fg, bg, alpha):
    return tuple(int(round(fg[i] * alpha + bg[i] * (1 - alpha))) for i in range(3))


def rgba(colour):
    """Normalise a colour whose alpha may be 0..1 or 0..255 into 0..255 ints.

    Pillow rejects float channel values, and the theme expresses alpha as a
    0..1 fraction, so every colour crosses this boundary before being drawn.
    """
    r, g, b = (int(round(c)) for c in colour[:3])
    raw = colour[3]
    a = int(round(raw * 255)) if isinstance(raw, float) and raw <= 1 else int(raw)
    return (r, g, b, max(0, min(255, a)))


def wallpaper(width, height):
    """A pink-purple diagonal wash, standing in for the user's wallpaper."""
    image = Image.new("RGB", (width, height))
    pixels = image.load()
    for y in range(height):
        for x in range(width):
            t = (x / width * 0.65 + y / height * 0.35)
            r = int(238 - 92 * t)
            g = int(170 - 74 * t)
            b = int(220 - 52 * t)
            # A soft highlight in the upper right, like a light source.
            glow = max(0.0, 1.0 - (((x - width * 0.78) ** 2 + (y - height * 0.2) ** 2) ** 0.5) / (width * 0.42))
            pixels[x, y] = (
                min(255, int(r + 46 * glow)),
                min(255, int(g + 40 * glow)),
                min(255, int(b + 30 * glow)),
            )
    return image


def superellipse(draw, box, radius, fill=None, outline=None, width=1, exponent=4.0, steps=180):
    """Approximate a squircle: CSS `corner-shape: superellipse` in spirit."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    r = min(radius, w / 2, h / 2)
    points = []
    # Sample one corner as a superellipse quadrant, as *offsets* from the corner
    # centre. Storing pre-mirrored coordinates here and then subtracting them in
    # the per-corner formulas double-applies the offset and draws a star.
    for i in range(steps + 1):
        angle = (i / steps) * (3.141592653589793 / 2)
        import math

        cos_a, sin_a = math.cos(angle), math.sin(angle)
        px = r * (abs(cos_a) ** (2 / exponent)) * (1 if cos_a >= 0 else -1)
        py = r * (abs(sin_a) ** (2 / exponent)) * (1 if sin_a >= 0 else -1)
        points.append((px, py))
    corners = [
        [(x0 + r - px, y0 + r - py) for px, py in points],
        [(x1 - r + py, y0 + r - px) for px, py in points],
        [(x1 - r + px, y1 - r + py) for px, py in points],
        [(x0 + r - py, y1 - r + px) for px, py in points],
    ]
    # Each corner is already generated in clockwise order, so the outline is a
    # straight concatenation. Reversing any of them makes the path cross itself,
    # which draws a star rather than a rounded rectangle.
    polygon = corners[0] + corners[1] + corners[2] + corners[3]
    if fill is not None:
        draw.polygon(polygon, fill=fill)
    if outline is not None:
        draw.line(polygon + [polygon[0]], fill=outline, width=width, joint="curve")


def panel(size, palette, squircle, backdrop):
    """Draw a mock chrome panel over the backdrop and return the image."""
    w, h = size
    image = backdrop.copy()
    draw = ImageDraw.Draw(image, "RGBA")

    # Shadow, drawn as stacked offset shapes to imitate a blur.
    if not squircle:
        for i in range(palette["shadow_blur"], 0, -3):
            a = palette["shadow"][3] * (1 - i / palette["shadow_blur"]) * 0.35
            draw.rounded_rectangle(
                (12 - i // 3, 12 + palette["shadow_offset"] // 3 - i // 4, w - 12 + i // 3, h - 12 + i // 4),
                radius=palette["radius"] + i // 2,
                fill=rgba(palette["shadow"][:3] + (a,)),
            )
    else:
        for i in range(palette["shadow_blur"], 0, -3):
            a = palette["shadow"][3] * (1 - i / palette["shadow_blur"]) * 0.30
            superellipse(
                draw,
                (12 - i // 3, 14 + palette["shadow_offset"] // 3 - i // 4, w - 12 + i // 3, h - 12 + i // 4),
                palette["radius"] + i // 2,
                fill=rgba(palette["shadow"][:3] + (a,)),
            )

    surface = hx(palette["surface"])
    if squircle:
        superellipse(draw, (12, 12, w - 12, h - 12), palette["radius"], fill=blend(surface, (0, 0, 0), 0.94) + (255,))
        superellipse(draw, (12, 12, w - 12, h - 12), palette["radius"], outline=(255, 255, 255, 40), width=1)
        # The specular top edge: a light line just inside the top border.
        superellipse(draw, (14, 14, w - 14, h - 14), palette["radius"] - 2, outline=(255, 255, 255, 26), width=1)
    else:
        draw.rounded_rectangle((12, 12, w - 12, h - 12), radius=palette["radius"], fill=blend(surface, (0, 0, 0), 0.94) + (255,))
        draw.rounded_rectangle((12, 12, w - 12, h - 12), radius=palette["radius"], outline=rgba(palette["borders"][2]), width=1)

    # Title, body, a divider, and a button.
    draw.text((44, 40), "设置 · 通用", font=font(21, True), fill=FG)
    draw.text((44, 78), "外观与行为", font=font(15), fill=MUTED)
    for row, label in enumerate(["跟随系统配色", "内容字号", "发送快捷键"]):
        y = 122 + row * 40
        draw.text((44, y), label, font=font(15), fill=FG)
        draw.text((w - 150, y), "›", font=font(17), fill=MUTED)
        draw.line((44, y + 27, w - 44, y + 27), fill=rgba(palette["borders"][0]), width=1)

    bx0, by0, bx1, by1 = 44, h - 84, 208, h - 40
    if squircle:
        superellipse(draw, (bx0, by0, bx1, by1), 12, fill=ACCENT + (255,))
        draw.text((bx0 + 26, by0 + 11), "应用", font=font(15, True), fill=hx("#141019"))
    else:
        draw.rounded_rectangle((bx0, by0, bx1, by1), radius=15, fill=ACCENT + (255,))
        draw.text((bx0 + 26, by0 + 11), "应用", font=font(15, True), fill=hx("#141019"))

    # Hover swatch, to show what a hover fill looks like.
    hx0 = bx1 + 24
    if squircle:
        superellipse(draw, (hx0, by0, hx0 + 150, by1), 12, fill=blend((255, 255, 255), blend(surface, (0, 0, 0), 0.94), 0.07) + (255,))
        superellipse(draw, (hx0, by0, hx0 + 150, by1), 12, outline=(255, 255, 255, 30), width=1)
    else:
        draw.rounded_rectangle((hx0, by0, hx0 + 150, by1), radius=15, fill=blend((255, 217, 239), hx(palette["surface"]), 0.16) + (255,))
    draw.text((hx0 + 26, by0 + 11), "悬停态", font=font(15), fill=FG)

    return image


def swatch_row(draw, x, y, palette, label):
    draw.text((x, y - 26), label, font=font(14, True), fill=MUTED)
    keys = ["mask", "inkDeep", "ink", "surface", "surfaceHigh"]
    for i, key in enumerate(keys):
        sx = x + i * 132
        draw.rounded_rectangle((sx, y, sx + 116, y + 56), radius=8, fill=hx(palette[key]) + (255,))
        draw.rounded_rectangle((sx, y, sx + 116, y + 56), radius=8, outline=(255, 255, 255, 22), width=1)
        draw.text((sx + 5, y + 60), palette[key], font=font(12), fill=MUTED)


def border_row(draw, x, y, palette, label):
    draw.text((x, y - 24), label, font=font(14, True), fill=MUTED)
    base = hx(palette["surface"])
    for i, colour in enumerate(palette["borders"]):
        sx = x + i * 168
        stroke = rgba(colour)
        draw.rounded_rectangle((sx, y, sx + 152, y + 34), radius=8, fill=base + (255,))
        draw.rounded_rectangle((sx, y, sx + 152, y + 34), radius=8, outline=stroke, width=1)
        draw.text((sx + 6, y + 9), f"{round(stroke[3] / 255 * 100)}%", font=font(12), fill=MUTED)


canvas = Image.new("RGB", (W, H), BG)
draw = ImageDraw.Draw(canvas, "RGBA")

draw.text((44, 34), "dsh-theme-cyrene · 苹果式材质改版对照", font=font(27, True), fill=FG)
draw.text((44, 76), "左：改前（紫调铺满整个 chrome）　右：改后（中性 chrome + 单一强调色）", font=font(15), fill=MUTED)

# --- chrome ladder
draw.text((44, 124), "一级：chrome 中性化", font=font(18, True), fill=ACCENT)
swatch_row(draw, 44, 182, OLD, "改前")
swatch_row(draw, 44, 302, NEW, "改后")
draw.text(
    (44, 396),
    f"色度扩散：改前 {OLD['spread']} → 改后 {NEW['spread']}（0 = 纯灰；苹果深色材质接近 0）",
    font=font(14),
    fill=MUTED,
)

# --- accents. Read from the theme, not written out by hand: this row was
# hardcoded and silently kept showing the old palette after the accent changed.
draw.text((716, 124), "二级：强调色", font=font(18, True), fill=ACCENT)
accents = NEW["accent"]
for i, name in enumerate(["pink", "pinkStrong", "pinkSoft", "purple"]):
    value = accents[name]
    sx = 716 + i * 155
    draw.rounded_rectangle((sx, 182, sx + 139, 238), radius=8, fill=hx(value) + (255,))
    draw.text((sx + 5, 244), name, font=font(12), fill=MUTED)
    draw.text((sx + 5, 260), value, font=font(11), fill=(120, 114, 134))
draw.text((716, 300), "pinkStrong 借自 Cyrene-xl/DSH-Cyrene", font=font(14), fill=MUTED)
draw.text((716, 322), "的 dsh-dream-skin:accent = #f472b6（MIT）。", font=font(14), fill=MUTED)
draw.text((716, 344), "只用在强调处，大面积填充仍是淡粉。", font=font(14), fill=MUTED)

# --- borders
draw.text((44, 436), "三级：描边", font=font(18, True), fill=ACCENT)
border_row(draw, 44, 482, OLD, "改前：紫色描边（整块 UI 都在发光）")
border_row(draw, 44, 558, NEW, "改后：白色发丝线 + 顶部高光")

# --- panels
draw.text((44, 620), "四级：把面板放到壁纸上（这才是最终观感）", font=font(18, True), fill=ACCENT)
backdrop = wallpaper(W, 300)
before = panel((620, 268), OLD, False, backdrop.crop((0, 0, 620, 268)))
after = panel((620, 268), NEW, True, backdrop.crop((0, 0, 620, 268)))
canvas.paste(before, (44, 664))
canvas.paste(after, (696, 664))

# The grain layer, on the "after" panel only. Rendered far stronger than the
# shipped 3 %: at the real strength it is invisible once the image is scaled
# down in a chat window, and the point of showing it is that it exists at all.
tile = canvas.crop((696, 664, 696 + 620, 664 + 268))
noise = Image.effect_noise(tile.size, 26).convert("RGB")
canvas.paste(Image.blend(tile, ImageChops.overlay(tile, noise), 0.22), (696, 664))
draw.text((44, 940), "改前：圆角 round、紫边、紫色重阴影 → 像一层发光的膜", font=font(13), fill=MUTED)
draw.text((696, 940), "改后：连续圆角、白边+高光、近黑柔影 → 像一块材质", font=font(13), fill=MUTED)
draw.text((696, 958), "「质感」开启时另加噪点（图中约为实际强度的数倍）", font=font(12), fill=(126, 120, 142))

# --- rounding comparison, zoomed
draw.text((44, 982), "圆角细节（放大 2.4 倍）", font=font(13, True), fill=MUTED)
zoom = 46
for i, (label, squircle, palette) in enumerate([("改前 round", False, OLD), ("改后 superellipse", True, NEW)]):
    zx = 210 + i * 210
    tile = Image.new("RGB", (zoom * 2, zoom * 2), (18, 16, 22))
    td = ImageDraw.Draw(tile, "RGBA")
    if squircle:
        superellipse(
            td,
            (0, 0, zoom * 2 - 1, zoom * 2 - 1),
            zoom,
            fill=hx(palette["surface"]) + (255,),
            outline=(255, 255, 255, 60),
            width=2,
        )
    else:
        td.rounded_rectangle(
            (0, 0, zoom * 2 - 1, zoom * 2 - 1),
            radius=zoom,
            fill=hx(palette["surface"]) + (255,),
            outline=rgba(palette["borders"][2]),
            width=2,
        )
    # Crop a corner, not the centre: the whole point of this row is the
    # curvature at the corner.
    tile = tile.crop((0, 0, 58, 58)).resize((104, 104), Image.LANCZOS)
    canvas.paste(tile, (zx, 1010))
    draw.text((zx, 1118), label, font=font(11), fill=MUTED)

out = Path(sys.argv[1] if len(sys.argv) > 1 else "docs/palette-before-after.png")
out.parent.mkdir(parents=True, exist_ok=True)
canvas.save(out)
print(f"wrote {out} ({canvas.width}x{canvas.height})")
