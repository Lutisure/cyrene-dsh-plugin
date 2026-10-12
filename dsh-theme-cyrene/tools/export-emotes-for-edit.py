"""Package the emote set for hand-editing.

The shipped files are WebP because that is what the overlay loads, but WebP is a
poor format to *edit* in: many tools will not open it, and the animated one is
harder still. So this writes a working copy alongside — PNG for the stills, GIF
plus a frame sequence for the animation — without touching what actually ships.

    python tools/export-emotes-for-edit.py
"""

import shutil
import zipfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
EMOTES = ROOT / "GIF" / "emotes"
SOURCE = ROOT / "brand" / "pet"
OUT = ROOT / "dist-emotes-edit"

# The shipped label -> what it looks like, so the mapping is not guesswork.
MEANING = {
    "开心": "闭眼吐舌大笑 · 触发词：谢谢 / 太好了 / 太棒 / 厉害 / 绝了 / 感谢 / 辛苦",
    "得意": "托腮得意 · 触发词：搞定 / 完成 / 成功了 / 已解决 / 通过了",
    "没错": "自信眨眼 · 触发词：没错 / 正是 / 确实 / 对的 / 就是这样",
    "期待": "星星眼期待 · 触发词：发我 / 提供 / 给我 / 发一下 / 贴一下",
    "疑惑": "抱臂怀疑 · 触发词：确认一下 / 要我 / 可以吗 / 是否 / 确定吗"
}

# The art each shipped file was built from, so an edit can start from the source
# rather than from an already-processed output.
ORIGIN = {
    "开心": "sticker-ppg-24-cyrene-01.webp",
    "期待": "sticker-ppg-24-cyrene-02.webp",
    "得意": "sticker-ppg-24-cyrene-03.webp",
    "疑惑": "sticker-ppg-24-cyrene-04.webp",
    "没错": "sticker-ppg-24-cyrene-05.webp"
}

READ_ME = """\
昔涟 · 表情包 —— 可编辑副本
================================

## 文件名就是接线，不能改

客户端不查任何注册表：它拿触发的词去比对**条目的 label**，
而 label 就是**去掉扩展名的文件名**。

所以 `开心.png` 之所以能弹出，是因为它叫「开心」。
改名成 `开心2.png`、或者写成 `开心 副本.png`，
**那个词就再也不会弹东西，而且不报任何错。**

改完放回 `GIF/emotes/` 时，请保持：

    · 文件名与这里完全一致（含中文）
    · 扩展名用 .webp / .gif / .png 三者之一
    · 静图仍然带透明通道（PNG 的 alpha 会自动保留）

## 目录里有什么

    开心.png / 得意.png / 没错.png / 期待.png / 疑惑.png
        256×256，带透明通道，可直接编辑。
        这几张就是官方 Q 版表情本身，没有做过任何加工，只调整了尺寸。

    source/             每一张的来源素材（原图，未经处理）

    映射.txt            文件名 → 触发词 的对照

## 尺寸

覆盖层按 **148px 宽**渲染。素材是 256×256，
所以在这个尺寸下是清晰的；改的时候不必放大。

## 想加新的表情（比如「害羞」）

文件名不够——**还改一处代码**：`lib/client/80-emotes.js` 里的 `EMOTE_TRIGGERS`，
每条是 `{ label, words }`。加一项、把文件放进去、重新构建，那个词才会触发。

已经用掉的 label：开心 / 得意 / 没错 / 期待 / 疑惑

## 重新生成

把改好的文件放回 `GIF/emotes/`，然后：

    cd <本仓库>\\dsh-theme-cyrene
    node build.mjs          # 让清单收录
    npm run check-live      # 确认运行中的界面能取到（要重启过 DSH）

`docs/emote-set.png` 是一张总览图，改之前可以先看它。
"""


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "source").mkdir(parents=True)

    written = []
    for path in sorted(EMOTES.iterdir()):
        if path.name.startswith("."):
            continue
        label = path.stem

        if path.name.endswith(".gif"):
            continue

        with Image.open(path) as image:
            frames = getattr(image, "n_frames", 1)
            if frames > 1:
                # Animated: keep a GIF anyone can edit, the shipped WebP for
                # comparison, and the frames for a real redo.
                gif = OUT / f"{label}.gif"
                rgba = []
                for index in range(frames):
                    image.seek(index)
                    rgba.append(image.convert("RGBA"))
                # GIF has no partial alpha, so composite onto the overlay's surface
                # rather than onto black — same choice the builder makes.
                flat = []
                for frame in rgba:
                    canvas = Image.new("RGB", frame.size, (24, 20, 30))
                    canvas.paste(frame, (0, 0), frame)
                    flat.append(canvas)
                flat[0].save(gif, format="GIF", save_all=True, append_images=flat[1:],
                             duration=image.info.get("duration", 80), loop=0, disposal=2)
                written.append(gif)

                frames_dir = OUT / f"{label}-frames"
                frames_dir.mkdir(exist_ok=True)
                for index, frame in enumerate(rgba, start=1):
                    frame.save(frames_dir / f"frame-{index:02d}.png")
                shutil.copy2(path, OUT / f"{label}.webp")
                written.append(OUT / f"{label}.webp")
                print(f"  {label}: {frames} frames -> gif + webp + {frames} frame PNGs")
            else:
                png = OUT / f"{label}.png"
                image.convert("RGBA").save(png, format="PNG", optimize=True)
                written.append(png)
                print(f"  {label}: still -> png ({png.stat().st_size / 1024:.0f} KB)")

        origin = SOURCE / ORIGIN.get(label, "")
        if origin.exists():
            shutil.copy2(origin, OUT / "source" / origin.name)

    mapping = ["文件名 → 触发词", "=" * 40, ""]
    for label in MEANING:
        mapping.append(f"{label}.webp")
        mapping.append(f"  {MEANING[label]}")
        mapping.append(f"  来源：source/{ORIGIN.get(label, '?')}")
        mapping.append("")
    (OUT / "映射.txt").write_text("\n".join(mapping), encoding="utf-8")
    (OUT / "读我.txt").write_text(READ_ME, encoding="utf-8")

    archive = ROOT / "dist-emotes-edit.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for path in sorted(OUT.rglob("*")):
            if path.is_file():
                bundle.write(path, path.relative_to(OUT.parent))
    print(f"\n  wrote {OUT.name}/ ({len(list(OUT.rglob('*')))} entries)")
    print(f"  wrote {archive.name} ({archive.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
