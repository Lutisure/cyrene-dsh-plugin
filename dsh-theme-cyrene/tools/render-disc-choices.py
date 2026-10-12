"""Contact sheet for choosing the music player's disc artwork.

The disc (`.cy-disc`) is a 62 px circle with `cover` cropping and an 8 px dark
inset ring, and it spins. That combination is unforgiving in a specific way:
detail disappears at that size, and the outer 8 px of whatever you pick gets
darkened by the ring. So this sheet shows two things — everything that exists,
numbered, and then how the plausible ones actually look at 62 px with the ring
applied.

    python tools/render-disc-choices.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / "brand" / "pet"
EMOTES = ROOT / "GIF" / "emotes"
ASSETS = ROOT / "assets"
OUT = ROOT / "docs" / "disc-choices.png"

# Grouped by how well each kind survives being shrunk into a 62 px circle. The
# grouping is the useful part of this sheet: a splash art is a beautiful image and
# a grey smudge at 62 px.
GROUPS = [
    ("A", "Q 版表情（表情包本体）", [
        ("开心", EMOTES / "开心.webp"),
        ("得意", EMOTES / "得意.webp"),
        ("没错", EMOTES / "没错.webp"),
        ("期待", EMOTES / "期待.webp"),
        ("疑惑", EMOTES / "疑惑.webp"),
    ]),
    ("B", "头像类（本来就是做小图的）", [
        ("icon", BRAND / "character-cyrene-icon.webp"),
        ("portrait", BRAND / "character-cyrene-portrait.webp"),
        ("promise", BRAND / "profile-picture-cyrene---keeping-promise.webp"),
    ]),
    ("C", "命座立绘（细节多，缩小会糊）", [
        ("eidolon-1", BRAND / "character-cyrene-eidolon-1.webp"),
        ("eidolon-2", BRAND / "character-cyrene-eidolon-2.webp"),
        ("eidolon-3", BRAND / "character-cyrene-eidolon-3.webp"),
        ("eidolon-4", BRAND / "character-cyrene-eidolon-4.webp"),
        ("eidolon-5", BRAND / "character-cyrene-eidolon-5.webp"),
        ("eidolon-6", BRAND / "character-cyrene-eidolon-6.webp"),
    ]),
    ("D", "插画 / 立绘大图", [
        ("splash", BRAND / "character-cyrene-splash-art.webp"),
        ("intro", BRAND / "character-cyrene-introduction.webp"),
        ("art-2026", BRAND / "artwork-cyrene-2026-04-26.webp"),
        ("art-2025", BRAND / "cyrene-artwork-2025-11-02.webp"),
        ("odyssey", BRAND / "cyrene-gift-of-odyssey-3.7.webp"),
        ("valentine", BRAND / "valentines-day-2026-cyrene.webp"),
        ("written", BRAND / "as-ive-written-cyrene-5.webp"),
        ("hoyolab", BRAND / "hoyolab-article-chrysos-cyrene-4.webp"),
        ("longest-night", BRAND / "hoyolab-the-longest-night-cyrene.webp"),
        ("festive", BRAND / "festive-gifts-4.2-phainon-cyrene.webp"),
        ("still", ASSETS / "Default_cyrene-still.webp"),
    ]),
]

# What the CSS actually does, reproduced here so the preview does not lie.
DISC_PX = 62
RING_PX = 8
RING = (6, 4, 9, 140)

BG = (26, 22, 32)
CARD = (38, 32, 46)
TEXT = (232, 226, 240)
DIM = (168, 158, 182)
PINK = (238, 170, 200)


def font(size, bold=False):
    for name in (("msyhbd.ttc", "msyh.ttc") if bold else ("msyh.ttc", "msyhbd.ttc")):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def cover(img, size):
    """CSS `background-size: cover`, then the circular crop."""
    w, h = img.size
    edge = min(w, h)
    img = img.crop(((w - edge) // 2, (h - edge) // 2, (w + edge) // 2, (h + edge) // 2))
    return img.resize((size, size), Image.LANCZOS)


def as_disc(img):
    """The disc exactly as the panel draws it: circle, then the 8 px inset ring."""
    disc = cover(img.convert("RGBA"), DISC_PX)
    mask = Image.new("L", (DISC_PX, DISC_PX), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, DISC_PX - 1, DISC_PX - 1), fill=255)
    disc.putalpha(mask)

    ring = Image.new("RGBA", (DISC_PX, DISC_PX), (0, 0, 0, 0))
    ImageDraw.Draw(ring).ellipse(
        (RING_PX // 2, RING_PX // 2, DISC_PX - 1 - RING_PX // 2, DISC_PX - 1 - RING_PX // 2),
        outline=RING, width=RING_PX,
    )
    return Image.alpha_composite(disc, ring)


def main():
    rows = []
    for key, title, items in GROUPS:
        for index, (name, path) in enumerate(items, start=1):
            if path.exists():
                rows.append((f"{key}{index}", name, path))
            else:
                print(f"  missing: {path}")

    # --- sheet layout ---------------------------------------------------
    tile, gap = 96, 14
    label_h = 34
    per_row = 6
    section_gap = 16
    width = 40 + per_row * (tile + gap) - gap + 40

    # Height: a heading per group, then its rows, then the preview strip.
    height = 96
    for _, title, items in GROUPS:
        present = [i for i in items if i[1].exists()]
        if present:
            height += 30 + ((len(present) + per_row - 1) // per_row) * (tile + label_h + gap) + section_gap
    preview_h = 190
    height += preview_h + 60

    sheet = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(sheet)
    draw.text((40, 30), "昔涟 · 播放器转盘候选图", font=font(26, True), fill=TEXT)
    draw.text((40, 64), f"实际尺寸 {DISC_PX}px 圆形 · cover 裁切 · 外圈有 {RING_PX}px 深色内阴影", font=font(13), fill=DIM)

    y = 96
    index_of = {}
    for key, title, items in GROUPS:
        present = [(n, p) for n, p in items if p.exists()]
        if not present:
            continue
        draw.text((40, y), f"{key} 组 · {title}", font=font(16, True), fill=PINK)
        y += 30
        for i, (name, path) in enumerate(present):
            col = i % per_row
            row = i // per_row
            x = 40 + col * (tile + gap)
            # Every row needs its own y. Advancing only x drew row two straight on
            # top of row one, which silently hid the first five entries of the one
            # group long enough to wrap.
            ty = y + row * (tile + label_h + gap)
            with Image.open(path) as img:
                tile_img = cover(img.convert("RGBA"), tile)
            box = Image.new("RGBA", (tile, tile + label_h), CARD)
            box.paste(tile_img, (0, 0), tile_img)
            sheet.paste(box.convert("RGB"), (x, ty))
            code = f"{key}{i + 1}"
            index_of[code] = (name, path)
            draw.text((x + 6, ty + tile + 3), code, font=font(15, True), fill=PINK)
            draw.text((x + 6, ty + tile + 20), name[:14], font=font(11), fill=DIM)
        y += ((len(present) + per_row - 1) // per_row) * (tile + label_h + gap) + section_gap

    # --- the honest preview --------------------------------------------
    draw.text((40, y), f"按真实尺寸预览（{DISC_PX}px + 内圈，会旋转）", font=font(16, True), fill=PINK)
    y += 28
    draw.text((40, y), "小尺寸下的清晰度差别就是在这里看出来的", font=font(12), fill=DIM)
    y += 24

    picks = [c for c in ["A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3", "C2", "D1"] if c in index_of]
    x = 40
    for code in picks:
        name, path = index_of[code]
        with Image.open(path) as img:
            disc = as_disc(img)
        sheet.paste(disc.convert("RGB"), (x, y), disc)
        draw.text((x, y + DISC_PX + 6), code, font=font(13, True), fill=PINK)
        draw.text((x, y + DISC_PX + 22), name[:10], font=font(10), fill=DIM)
        x += DISC_PX + 26

    OUT.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(OUT, "PNG", optimize=True)
    print(f"  wrote {OUT.relative_to(ROOT)}  ({sheet.size[0]}x{sheet.size[1]}, {OUT.stat().st_size / 1024:.0f} KB)")
    print(f"  candidates: {len(rows)}")
    for code, (name, _) in index_of.items():
        print(f"    {code:<4} {name}")


if __name__ == "__main__":
    main()
