# 这是一份可以分享的副本

它**只有源码**，没有构建产物，也没有任何私人状态。

> **最好的装法：把仓库地址交给一个 AI agent，让它替你装。**
>
> 要 link 三个包进 profile、要跑构建、要装技能文件、还要在两个 profile 之间选 ——
> **让 agent 读着 `setup/` 和 [README.md](README.md) 来做，比照着步骤手抄可靠。**

---

## 你需要自己做的三件事

### 1. 跑安装脚本

```
setup\install.cmd
```

它会把三个包链接进你的 DSH profile、写进 profile 的 `package.json`，并把每个包
自己的依赖装上。它**不会**启动 DSH，也**不知道**你的 DSH 装在哪。

默认值不合适时可以给参数：

```
setup\install.cmd -DshHome "D:\somewhere\.dsh" -Profile desktop
```

**它要求 profile 已经存在** —— 先在这台机器上装好并启动一次 DSH，让
`~/.dsh/profiles/<名字>/` 出现在那儿。没有的话脚本会明说并停下，**不会造出一个
半成品安装。**

⚠️ **Windows PowerShell 5.1 或 PowerShell 7 都能跑。** 脚本是 UTF-8 **带 BOM** 的，
原因就在这儿：5.1 读 `.ps1` 时按 ANSI 解，除非有 BOM，而乱掉的中文会**破坏解析**。
`install.cmd` 调的是 `powershell`（5.1），不是 `pwsh` —— **所以不需要 PowerShell 7。**
（写这一条的那台机器上就没装 `pwsh`，而安装脚本一直是能跑的 ——
**它调的一直是 5.1。**）

### 2. 跑一次构建

```
cd cyrene-agent
node build.mjs
```

构建时会读**你自己的** `~/.dsh/cyrene-agent/memory.md` 和 `corrections.md`。
在一台新机器上它们是空的，所以构建出来的技能里也没有记忆 —— 这个 agent 会从零
开始认识你。

`node_modules` 没有随包发出：那是平台相关的产物，而且几百兆里绝大部分是别人的代码。
**安装脚本会替你装**；要是跳过了它，就自己在三个包目录里各跑一次 `npm install`。

### 3. 素材已经在包里了

`dsh-theme-cyrene` 的 `assets/`、`music/`、`GIF/`、`brand/` **都随包发** ——
壁纸、小昔涟的贴纸、人像、转盘、音乐、开场动画，装上就有。

（`docs/` 不发：那是预览图，运行时用不到。）

**而包里带的那几份只是**默认值**，换成你自己的很容易：**

| 想换 | 怎么做 |
|---|---|
| 壁纸（静态 / 动态） | 界面里点「景」→「＋ 添加壁纸」**直接导入**；或者丢进 `dsh-theme-cyrene/assets/` |
| 背景音乐 | 丢进 `music/`；封面放 `music/figure/` |
| 表情包（小昔涟的贴纸） | 丢进 `GIF/emotes/`，**文件名就是触发情绪** |
| 头像 | 面板里设 `avatarSource: custom` 再导入一张图 |

**界面导入的那条会把文件持久化到 `$DSH_HOME/theme-cyrene/uploads/`，换机器带走设置就还在。**
丢文件那条**刷新页面就行，不需要重新构建** —— 宿主半每次都实时扫那几个目录。

**换掉之后，随包发的那几份可以直接删。** 扩展名清单和目录约定见
`dsh-theme-cyrene/ASSETS.md`。

**剧情原文也在包里** —— `cyrene-agent/corpus-src/`（10.8 MB、15 个文件）。
剧情检索（RAG）靠它建索引，而**安装脚本会替你建好**，你不用自己跑构建。

**壁纸、贴纸、人像、音乐、开场动画，装上就有。**

**而剧情原文和这些素材是同一类**：游戏文本、美术与音频，版权属于米哈游 / HoYoverse，
不适用本项目的 MIT，**只做个人使用**。

拿到副本的人：**不要再往外分发这些素材。**

**代码和素材是两件事，这份副本里装着两样，所以要分开说：**

- 项目的**代码**是 MIT，随便用
- **素材不是**，只做个人使用，**不要再往外发**
- 细节见 [NOTICE.zh.md](NOTICE.zh.md) 第一节之二与一之三

---

## 没有包含的东西，以及为什么

| 没包含 | 原因 |
|---|---|
| `deploy/` | 原机器的运行状态：记忆、修正、主题状态 |
| `cyrene-agent/dist/` | 构建产物 —— 而构建时把记忆内联进了 `SKILL.md` |
| `docs/` | 游戏素材的衍生物（头像候选、开场帧预览），运行时不读它 |
| `corpus-raw/` `corpus-backup-*` `corpus/` | 抓取中间态与派生缓存，构建不读它们 |
| `cyrene-agent/docs/` | 迭代记录与设计档，运行时不读 |

**`assets/` `music/` `GIF/` `brand/` 不在这个表里了 —— 它们现在随包发。**
`cyrene-agent/corpus-src/` 同理（剧情检索要读它）。
见上面「素材已经在包里了」那一节。

第二行值得多说一句。`dist/` 是构建产物，但 `build.mjs` 在构建时把 `memory.md` 和
`corrections.md` **内联进生成的 `SKILL.md`**。所以 `dist/` 是机器相关的，发出去就是
把作者的私人记忆连同代码一起发出去。**只排除 `deploy/` 是不够的。**

这也顺带回答了「怎么让我这份和作者那份互不相干」：**你拿到的是源码，不是成品**。
自己构建一次，你的记忆就是空的。不需要额外的机制。

---

## 授权

- 本项目自己的代码：MIT
- `cyrene-agent/persona-soul.md`：整理自 Cyrene-Agent，Copyright (c) 2026 Playa，MIT，
  经 Cyrene-xl/DSH-Cyrene 收录。见 `cyrene-agent/NOTICE.md`
- `cyrene-guard` 的检测规则：取自 Unclecheng-li/DeepSec，MIT。见
  `cyrene-guard/NOTICE.md`
- **游戏素材与剧情文本不在本项目任何授权范围内**，版权属于米哈游 / HoYoverse，
  只做个人使用。**本副本包含它们** —— 见 [NOTICE.zh.md](NOTICE.zh.md) 第一节之二、一之三
- **版权方要求下架的话，本项目会在一周内照办** —— 见
  [NOTICE.zh.md](NOTICE.zh.md) 第一节之四

完整署名见 [NOTICE.zh.md](NOTICE.zh.md)。
