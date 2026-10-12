# 从公网获取昔涟的文本 · 实测记录

> 这份文档里的每个结论我都**亲手请求验证过**，并标注了观测到的 HTTP 状态与实测数字。
> 凡是我没能验证的，明确写「未验证」——这个领域最容易踩的坑就是把过期镜像当成活的。

---

## 一、先说结论

| 结论 | 证据 |
|---|---|
| 最著名的数据挖掘仓库 **已经死了** | `Dimbreath/StarRailData` → **HTTP 451**（因法律原因下架） |
| 全量配置镜像**看起来活着但内容过期** | 三个 300 MB 级镜像都**不含「昔涟」二字**——整份 TextMap 出现 0 次 |
| 有一个**当前版本**的镜像，但只发布派生表 | `theBowja/starrail-data`，`StarRailData.version` = **4.6**，MIT |
| 靠它我能**实际拿到她的 58 条台词** | 游戏内短信系统，含玩家一侧，**已跑通完整链路** |
| 任务台词（量大得多）需要 4.x 的 TextMap | 我拿到的配置镜像是旧版，**没有她的任务台词** |

**所以现在的现实是**：能自动拿到的只有短信系统的 58 条（质量很高，纯对话），任务台词需要另找**当前版本**的配置转储。往下看怎么做。

---

## 二、那条已经跑通的路（短信系统）

### 来源

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/theBowja/starrail-data`（MIT，实测可达） |
| 版本 | **4.6**（仓库根目录 `StarRailData.version`） |
| 中文数据 | `data/CHS/messagecontacts.json`（104 KB）、`data/CHS/messageconversations.json`（4.0 MB） |
| 语言 | CHS / CHT / DE / EN / ES / FR / ID / JP / KR / PT / RU / TH / VI 共 13 种 |

### 她的实测数据

```
Id 200   昔涟  签名「永恒属于每一刻」        版本 3.5   会话 14537
Id 1415  昔涟  签名「要相信浪漫一如初见♪」  版本 3.7   会话 20216 / 20217 / 20218
```

**两个联系人条目**，所以按名字匹配时必须都收——只匹配一个会丢掉一半。

### 数据形状（实测）

```jsonc
// messageconversations.json → 一棵树，不是线性记录
{
  "Id": "14537",
  "Sections": [{
    "StartingMessageId": "145370001",
    "Messages": {
      "145370001": {
        "Id": "145370001",
        "MessageType": "Text",      // Text | Choice | Image | Sticker | Video | Link | Raid
        "SenderType": "NPC",        // NPC | Player | PlayerAuto | System
        "SenderContactId": "200",   // ← 说话人就在这里
        "Text": "嗨，是我，想我了吗？", // ← 已是本地化文本，不需要查 TextMap
        "NextMessageId": "145370002"
      },
      "choice3": {
        "MessageType": "Choice",
        "Choices": [                // ← 玩家选项，每条带自己的分支
          { "ChoiceType": "Text", "Text": "是有点，快回来吧", "NextMessageId": "145370003" }
        ]
      }
    }
  }]
}
```

两个关键点：

1. **说话人自带**，`Text` 已是成品文本 —— 不需要 join TextMap。这比全量配置镜像省一整步。
2. **玩家一侧也在数据里**（`Player` / `PlayerAuto`），所以能抽出**真正的双向对话对**，而不是单向台词。

### 实测产量

```
台词 110 条（其中她的 58 条）
双向对话对 5 组
```

58 条听起来不多，但它是**纯对话语体**，比任务旁白更接近聊天。5 组对话对是意外收获。

### 跑法

```powershell
# 1. 下载两个文件（放到同一个目录）
$base = "https://raw.githubusercontent.com/theBowja/starrail-data/main/data/CHS"
Invoke-WebRequest "$base/messagecontacts.json"        -OutFile messagecontacts.json
Invoke-WebRequest "$base/messageconversations.json"   -OutFile messageconversations.json

# 2. 适配成 pairs
node tools/adapters/starrail-messages.mjs `
  --contacts messagecontacts.json `
  --conversations messageconversations.json `
  --aliases 昔涟,昔漣,Cyrene --out corpus-raw

# 3. 蒸馏
node tools/ingest.mjs --in corpus-raw/pairs.jsonl --aliases HER --out corpus
```

第 2 步会同时输出 `turns.yaml`（`dialogues:` 格式，可直接并入 `dialogues.yaml`）。

---

## 三、任务台词：量大，但要你自己找当前快照

### 需要哪两个文件

全量配置转储里，任务台词的说话人是这样 join 出来的（**实测确认**）：

| 文件 | 实测大小 | 内容 |
|---|---|---|
| `TextMap/TextMapCHS.json` | 22.5 MB，**230,701** 条 | `哈希 → 中文文本` |
| `ExcelOutput/TalkSentenceConfig.json` | 21.5 MB，**125,369** 条 | 每条形如 `{TextmapTalkSentenceName:{Hash}, TalkSentenceText:{Hash}}` |

- `TextmapTalkSentenceName` = **说话人**的哈希 → 查 TextMap 得到名字
- `TalkSentenceText` = **台词**的哈希 → 查 TextMap 得到文本
- **join 命中率实测 1999/2000**（第一条是占位记录）。注意哈希是数字，别把 `{Hash:n}` 这个对象当键去查——我第一次就是这么错的。

### 但是：我拿到的镜像是过期的

实测的三个 300 MB 级镜像（`iam-akuzihs` / `imakokoda` / `gffice`，都标记 updated 2026-08-18）：

```
TalkSentence 条目        125,369
不同的说话人             2,687
说话人里含「昔」的        若昔 / 往昔的回声 / 「往昔的声音」 …（都不是她）
TextMap 出现「昔涟」      0 次
```

**「昔涟」二字在全量中文 TextMap 里出现 0 次** —— 这份快照整份早于她的内容。

> ⚠️ **这是本领域最大的坑**：这些镜像的 `updated_at` 很新，仓库还活着，API 也正常返回，
> 但内容停在旧版本。**先看版本文件再动手**——`theBowja` 那份根目录有
> `StarRailData.version`（内容 `4.6`），配置镜像没有，所以只能靠「搜她的名字有没有出现」来判断。

### 找当前快照的四条路（按可靠性排序）

1. **自己跑提取**（最可靠）。`theBowja/starrail-data` 的 `extract/` + `main.js` 就是提取器，
   `extract/data/versioncache.json` 记录了版本。需要你本机有游戏。
   它的 README 甚至贴了哈希函数 `GetStableHash`，用来自己查 TextMap。
2. **homdgcat.wiki 的离线镜像**：`NewbieXvwu/HomDGCat`（实测可达，但仓库只有 83 KB ——
   它是**下载脚本**不是数据，靠 `main.py` + `filelist.txt` 拉取）。含多语言 TextMap。
3. **中文 wiki 抓取**：`https://wiki.biligame.com/sr/`（实测 200 可达）。
   按剧情逐页转写，结构化程度差、要写爬虫，但**按角色页面聚合**这一点很方便。
   Fandom 用脚本 HEAD 请求返回 **403**（Cloudflare 挡机器人），浏览器打开应该正常。
4. **GitHub 搜新仓库**：`q=StarRailData in:name&sort=updated`。
   我搜到的都停在 2024-10 或 2026-08，**没有找到 4.6 的全量配置镜像**（未验证是否存在，只是我没找到）。

### 未验证的部分

- 我没有确认 4.6 的 `TalkSentenceConfig` 字段名是否与旧版一致（旧版是
  `TextmapTalkSentenceName` / `TalkSentenceText`）。**先抓一条样本确认字段再写解析。**
- 我没有验证她是否真在 `TalkSentenceConfig` 里以「昔涟」为说话人。有可能她的主线台词
  在 `Config/Level/**/Talk/*.json` 与 `DialogueEvent` 里，而 `TalkSentenceConfig` 只覆盖
  野外 NPC 对话。**这条只是推测，别当结论。**

---

## 四、不要全塞进去

这是比「怎么找」更重要的一半。

| | 数量级 | 能进系统提示词吗 |
|---|---|---|
| 短信台词 | 58 条 / 约 1.2 千字 | **能**，但要挑 |
| 任务台词 | 可能数千条 / 数万到数十万字 | **不能** |

原因不是钱，是**效果**：几万字的台词塞进系统提示词会让信号被淹没，她反而更像背台词
而不像在说话。所以正确做法是三步（`tools/ingest.mjs` 就是干这个的）：

1. **统计出规则** —— 句长中位数、标点习惯、句尾语气词、反复出现的说法 → 写进 `persona.yaml`
2. **挑十几条彼此不像的样本** → 写进 `dialogues.yaml` 的 `voiceSamples`
3. **剩下的留作检索** —— 需要时按话题取几条，而不是常驻

### 实测已经纠正了我的一个错误假设

我手写 `persona.yaml` 时写的是「以短句为主」。真实数据：

```
句长中位数 19 字，平均 20.6 字，21% 不超过 12 字
「，」出现在 82% 的台词里；「。」只出现在 2%
「♪」9%    「？」16%    「——」7%    「…」「……」合计 10%
```

**她的句子偏长**，而且**几乎不用句号**——靠逗号一路连下去。这是我自己绝对猜不出来的，
也正是「投喂数据」的价值所在。

---

## 五、版权

游戏文本版权属米哈游 / HoYoverse。

- **自用**（做一个只有你自己用的角色人格）与同人二创的处境相同，一般无碍。
- **公开分发**——把台词库随包发布、或发布一个能重建它的抓取产物——是另一回事，别做。
- 数据挖掘仓库被下架是有先例的（第一节那个 451 就是），所以**拿到就存本地副本**，
  别让你的流程依赖某个仓库一直存在。

本文档只描述公开可获取的数据与解析方法，不附带任何游戏文本内容。
