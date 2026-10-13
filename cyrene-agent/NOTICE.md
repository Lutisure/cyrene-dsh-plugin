# 第三方作品与授权

本项目自己的代码与数据以 MIT 发布。**人设正文不是本项目写的**，署名如下。

---

## 1. 人设正文（`persona-soul.md`）

| | |
|---|---|
| 文件 | [`persona-soul.md`](persona-soul.md) |
| 来源 | **从上游文档与剧情文本提炼获得** —— 上游为 **Cyrene-Agent**（Copyright (c) 2026 Playa，MIT） |
| 收录于 | **Cyrene-xl/DSH-Cyrene** — MIT，<https://github.com/Cyrene-xl/DSH-Cyrene> |
| 本仓库的使用 | 以 MIT 相同条款使用，未主张任何权利 |

这份正文**不是对上游文件的照搬**，而是在上游人设文档与剧情文本的基础上提炼成文的。

上游的 MIT 许可证原文见 [`LICENSES/Cyrene-Agent-LICENSE.txt`](LICENSES/Cyrene-Agent-LICENSE.txt)。

## 2. 用作参考、但**没有**任何文本进入本项目的

| 项目 | 用途 |
|---|---|
| [Cyrene-xl/DSH-Cyrene](https://github.com/Cyrene-xl/DSH-Cyrene) | 架构参考：预设怎么挂插件、世界书与记忆的形态、以及一份很有价值的 `docs/pitfalls.md` |
| [dsh-dream-skin](https://github.com/RevolutionLA/dsh-dream-skin)（RevolutionLA，MIT） | 只借了一个色值 `#f472b6`，用于 `dsh-theme-cyrene` 的强调色 |
| [dsh-ui-boost](https://github.com/DoshinJiu/dsh-ui-boost)（DoshinJiu，MIT）、[dsh-meme](https://github.com/yyh-001/dsh-meme)（yyh-001，MIT） | 只在选型时读过它们的存在，没有使用 |

## 3. 游戏素材

`dsh-theme-cyrene` 里的壁纸、音乐、Q 版表情、立绘，以及 `cyrene-agent` 的台词语料，
版权属于 **米哈游 / HoYoverse**，不适用本项目的 MIT。

- **npm 包里没有它们**：`package.json` 的 `files` 不含那几个目录。
- **分享副本里有它们**（`tools/make-share.mjs` 会把它们带上）—— 拿到的人只做个人使用，
  不要再往外分发素材本身。详见根目录 `NOTICE.zh.md` 的一节之二、一节之三。

## 4. embedding 模型（`cyrene_embedding/`）

| | |
|---|---|
| 模型 | [`Xenova/bge-small-zh-v1.5`](https://huggingface.co/Xenova/bge-small-zh-v1.5) |
| 原作 | [`BAAI/bge-small-zh-v1.5`](https://huggingface.co/BAAI/bge-small-zh-v1.5)（北京智源人工智能研究院） |
| 授权 | **MIT** |
| 形态 | int8 量化的 ONNX 转换，4 层、512 维，六个文件、23.4 MB |

**这一份和素材不是一回事：它是 MIT，随包发、进 git、进 npm 都没有问题。**
六个文件的 sha256 钉在 `tools/embedding-manifest.mjs`，用的时候逐个核对 ——
量化模型拷坏了不会报错，只会让检索悄悄变差。

**没有它也能跑。** `story.mjs` 会退回纯字符二元组（锚点命中 46%，有它是 54%），
一个字都不用改。见 `README.md` 的「第二层：向量」。

---

> 这份 NOTICE 是补齐一个疏忽：正文是上一轮采纳进来的，当时没有一并记录署名。
> 上游是 MIT，用了就该署名——不是法律风险的问题，是**这是别人的东西**。
