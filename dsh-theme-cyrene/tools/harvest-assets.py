"""Harvest Cyrene's cut-out artwork from the Honkai: Star Rail wiki.

Why the API and not the page. The wiki's HTML returns 403 to a script — the
`/api.php` endpoint does not, and it is JSON, so the whole asset list is
queryable. That is the single thing that makes this feasible at all.

Two traps this tool exists to avoid:

* **The page's image list is mostly other characters.** `Cyrene/Media`
  transcludes a navbox, so `prop=images` returns 99 `Character *` files of which
  all but a handful belong to somebody else. The filter below is an explicit
  allow-list, not a substring match.
* **The CDN blocks hotlinks.** `static.wikia.nocookie.net` answers 403 without a
  `Referer` header, so every download sets one.

    python tools/harvest-assets.py            # list what would be fetched
    python tools/harvest-assets.py --write    # download into brand/pet/
"""

import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "brand" / "pet"
DOCS = ROOT / "docs"

WIKI = "honkai-star-rail.fandom.com"
API = f"https://{WIKI}/api.php"
PAGE = "Cyrene/Media"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    # Required: without it the CDN refuses the asset.
    "Referer": f"https://{WIKI}/",
}

# Everything matching one of these is hers and is usable art.
#
# `Preview Details` is deliberately absent: those are 18 ability infographics,
# which look like character art by filename and are not.
#
# The sticker line was found the hard way. `list=search&srsearch=intitle:Sticker
# Cyrene` returns **zero** hits, because the real titles are
# `Sticker PPG 24 Cyrene 01.png` — a set number sits between the two words. Only
# pulling the page's full image list surfaced the official sticker set.
KEEP = (
    r"^Character Cyrene (Portrait|Splash Art|Icon|Introduction)",
    r"^Character Cyrene Eidolon \d",
    r"^Artwork Cyrene ",
    r"^Cyrene Artwork ",
    r"^As I've Written Cyrene ",
    r"^Sticker PPG \d+ Cyrene",
    r"^Profile Picture Cyrene",
    r"^Valentine's Day \d+ Cyrene",
    r"^Festive Gifts .* Cyrene",
    r"^Cyrene Gift of Odyssey",
    r"^HoYoLAB .* Cyrene",
)

# A pet sprite and a sticker set do not need 2K masters, and the plugin should
# not carry 30 MB of PNG. WebP keeps the alpha channel and is several times
# smaller.
MAX_EDGE = 1200
WEBP_QUALITY = 92


def api(params):
    url = f"{API}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def list_assets():
    """Every `File:` title on the page that belongs to her and is usable art."""
    import re

    pages = api({
        "action": "query",
        "titles": PAGE,
        "prop": "images",
        "imlimit": "500",
        "format": "json",
    })
    titles = []
    for page in pages["query"]["pages"].values():
        for entry in page.get("images", []):
            titles.append(entry["title"].removeprefix("File:"))

    patterns = [re.compile(p) for p in KEEP]
    kept = sorted(t for t in titles if any(p.match(t) for p in patterns))
    skipped = sorted(t for t in titles if "Cyrene" in t or "cyrene" in t)
    return kept, [t for t in skipped if t not in kept]


def resolve(titles):
    """File title → (url, mime, size). One round trip per batch of 50."""
    out = {}
    for start in range(0, len(titles), 50):
        batch = titles[start : start + 50]
        pages = api({
            "action": "query",
            "titles": "|".join(f"File:{t}" for t in batch),
            "prop": "imageinfo",
            "iiprop": "url|mime|size",
            "format": "json",
        })
        for page in pages["query"]["pages"].values():
            info = (page.get("imageinfo") or [None])[0]
            if info is not None:
                out[page["title"].removeprefix("File:")] = info
    return out


def slug(name):
    stem = name.rsplit(".", 1)[0]
    return stem.lower().replace("'", "").replace(" ", "-").replace("_", "-")


def download(info, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(info["url"], headers=HEADERS)
    with urllib.request.urlopen(request, timeout=300) as response:
        payload = response.read()
    temporary = target.with_suffix(".download")
    temporary.write_bytes(payload)
    try:
        image = Image.open(temporary)
        image.load()
    except Exception as error:  # noqa: BLE001 - report and continue
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"not a readable image: {error}") from error
    temporary.unlink(missing_ok=True)

    # Normalise: the CDN may answer with WebP even when the file is named .png.
    image = image.convert("RGBA")
    scale = min(1.0, MAX_EDGE / max(image.size))
    if scale < 1.0:
        image = image.resize((round(image.width * scale), round(image.height * scale)), Image.LANCZOS)
    image.save(target, format="WEBP", quality=WEBP_QUALITY, method=6)
    return image


def measure(image):
    alpha = np.asarray(image)[:, :, 3]
    return {
        "size": list(image.size),
        "transparent": round(float((alpha < 16).mean()), 4),
        "opaque": round(float((alpha > 239).mean()), 4),
        "corners": [int(alpha[0, 0]), int(alpha[0, -1]), int(alpha[-1, 0]), int(alpha[-1, -1])],
    }


def contact_sheet(entries):
    """One image to look at, instead of one per asset."""
    cell = 300
    columns = 4
    rows = (len(entries) + columns - 1) // columns
    canvas = Image.new("RGB", (cell * columns, cell * rows), (22, 19, 26))
    from PIL import ImageDraw, ImageFont

    face = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 13)
    draw = ImageDraw.Draw(canvas)
    for index, entry in enumerate(entries):
        tile = Image.open(entry["path"]).convert("RGBA")
        tile.thumbnail((cell - 16, cell - 34), Image.LANCZOS)
        x = (index % columns) * cell + (cell - tile.width) // 2
        y = (index // columns) * cell + 8
        canvas.paste(tile, (x, y), tile)
        draw.text(
            ((index % columns) * cell + 6, (index // columns) * cell + cell - 22),
            f"{entry['slug'][:34]}  {entry['transparent']:.0%}T",
            font=face,
            fill=(214, 208, 224),
        )
    DOCS.mkdir(parents=True, exist_ok=True)
    out = DOCS / "pet-assets.png"
    canvas.save(out)
    print(f"wrote {out} ({len(entries)} assets, shown as {columns}x{rows})")


def main():
    write = "--write" in sys.argv
    kept, other = list_assets()
    print(f"page {PAGE}: {len(kept)} matching asset(s), {len(other)} Cyrene-named file(s) excluded")
    for name in other:
        print(f"  excluded: {name}")

    infos = resolve(kept)
    missing = [t for t in kept if t not in infos]
    for name in missing:
        print(f"  could not resolve: {name}")

    if not write:
        print("\nwould fetch:")
        for name in kept:
            info = infos.get(name)
            if info:
                print(f"  {name:<44} {info['width']}x{info['height']}  {info['size'] / 1e6:.1f} MB")
        print("\nre-run with --write to download")
        return

    entries = []
    for name in kept:
        info = infos.get(name)
        if info is None:
            continue
        target = OUT_DIR / f"{slug(name)}.webp"
        try:
            image = download(info, target)
        except Exception as error:  # noqa: BLE001 - keep going, report at the end
            print(f"  FAILED {name}: {error}")
            continue
        stats = measure(image)
        entries.append({**stats, "slug": slug(name), "title": name, "file": target.name, "path": target})
        print(
            f"  {target.name:<40} {stats['size'][0]}x{stats['size'][1]}  "
            f"transparent {stats['transparent']:.0%}  {target.stat().st_size / 1024:.0f} KB"
        )

    manifest = [
        {k: v for k, v in entry.items() if k != "path"}
        for entry in entries
    ]
    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"\nwrote {OUT_DIR / 'manifest.json'} ({len(manifest)} entries)")
    contact_sheet(entries)


if __name__ == "__main__":
    main()
