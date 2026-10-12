# cyrene-agent · 昔涟人格模板

用**数据文件**驱动一个「昔涟」对话人格：改 YAML，跑一条命令，她的说话方式就变了。

---

## 拿真实实现验证（`npm run verify`）

这个仓库里其它测试，验的不是纯函数，就是**我自己复刻的运行时语义**。而这一条跑的是**真货**：
从已安装的 `app.asar` 里抽出需要的 `@deepseek-ai` 包，挂上真正的 `SystemPrompt` 服务，
用**真实的编译器**编译工具描述符，渲染出模型实际会收到的提示词。

```powershell
npm run verify
```

```
vendored 14 packages (132 files) from the asar
ok  the real service accepts every registration the plugins make
ok  the persona body arrives through the placeholder
ok  the assembled prompt is the persona, not the harness preamble
ok  the worldbook always-on block reaches the model
ok  memory is composed in, and is empty on a fresh home
ok  the remember tool writes, and the next assembly carries it
ok  an edit to the persona file reaches the very next assembly
ok  a provider returning undefined fails the assembly loudly
ok  an unregistered variable fails the assembly loudly
ok  the real compiler turns the descriptors into the intended schema
ok  the real argument validator accepts and rejects the right calls
ok  the JSON-Schema shape is rejected outright by the real compiler
ok  the real compiler agrees with the replica about the correct shape
```

### 它纠正了我三次，其中两次是「我以为我知道」

这个 harness 最大的价值不是「确认代码能跑」，而是**推翻了三个我基于复刻语义得出的错误结论**。

**一、嵌套占位符不展开。** 人设正文里的 `{{cyrene_memory}}` **原样出现在最终提示词里**。
`interpolate()` 一边扫一边替换，**换进去的值不会被重新扫描**；而正文本身是
`{{cyrene_persona}}` 的值。参考项目没这问题，因为它的正文直接内联在 section 里。

**二、`context()` 会被整体清空。** `assemble()` 的最后两行：

```js
sections: completeSection === undefined ? transformed.sections : [completeSection],
contexts: runtimeContextSuppressed ? [] : transformed.contexts
```

`complete: true` **替换掉所有其它 section**，`includeRuntimeContext: false`
**清空整个 context 通道**。所以提示词注册表里除正文之外任何东西都进不去——
我原本把设定常驻块和记忆块都注册成了 `context()`，它们会挂载成功、不报错、**谁也到不了**。

> `pitfalls.md` 那张表里写了这条。我读过，然后走进了同一个坑。
> **读过一条警告，和让它在自己的代码上失败一次，是两回事。**

**三、错误参数形状不是「静默」，是「抛错」。** 我先前声称写成 JSON Schema 形状会
**静默变成三个假参数**。真实编译器直接抛：

```
unsupported JSON schema: parameters.type must be a value schema object
```

仍然是致命的（`apply()` 抛错 → 整个预设挂载失败），但它是**响的**。
这个错误结论来自**我自己复刻的编译器**——复刻我的理解，当然复刻不出我的误解。

### 现在唯一能把内容送进提示词的地方

**人设正文本身。** `persona.mjs` 负责合成三样东西，顺序是**稳定在前、易变在后**：

```
人设正文  →  常驻设定  →  长期记忆
```

改记忆只影响提示词尾部，前缀缓存不受牵连。而**命中块不受影响**——它走
`agent/pre-step`，根本不属于提示词注册表。

### 顺带确认了一条设计

```js
for (const [name, provider] of layer.variables.entries()) variables[name] = provider(context)
```

provider **每次装配都被调用**——「改文件下一轮生效」不是推测，是源码事实。

### 脚本本身踩过的坑

- **依赖清单写死**，因为 `dsh-system-prompt` 导入了 `@deepseek-ai/cordis` 却没声明它，
  而 `cordis`/`dsh-llm` 解析失败时**报的是文件路径而不是包名**——清单遍历和错误驱动遍历
  都凑不齐，最后是两种消息形状都处理才跑通。
- **每轮探测必须开子进程。** Node 的 ESM 解析器会把「package.json 找不到」这个
  **否定结果缓存**整个进程生命周期，于是第一轮探测会毒化后面所有轮次：后面才补进来的包
  仍然走遗留解析。这个坑让脚本空转了整整一轮。
- `DSH_VERIFY_KEEP=1` 会保留抽取出来的目录，便于排查。`DSH_ASAR` 可覆盖 asar 路径。

---
---

## 人设正文（`persona-soul.md`）

`persona-soul.md` **不是本项目的原创**：它是在上游人设文档与剧情文本的基础上提炼成文的。
上游为 **Cyrene-Agent（MIT，Copyright (c) 2026 Playa）**，经 **Cyrene-xl/DSH-Cyrene（MIT）** 收录。
署名与出处见 [NOTICE.md](NOTICE.md)，许可证原文在 `LICENSES/`。

### 为什么它取代了原先那份拼出来的人设

原先的正文只有约 3 KB，是按 `persona.yaml` 拼的。它**能跑，但不够** —— 实测出来的：

> 七轮对话，**七轮都以反问结尾**，同一个「短句回应 + 解释 + 反问」的三段式。
> 那是心理咨询师的口吻，不是她的。

对数之后才看清责任在哪：

| | 以反问结尾 | 带俏皮标记（~ ♪ 嘻 人家） |
|---|---|---|
| 语感示例 13 条 | 4/13 | 6/13 |
| 语感样本 24 条 | 5/24 | **14/24** |
| **线上实际回答 7 条** | **7/7** | **0/7** |

**模型没有在模仿示例，是别的东西在压着她。** 而例句本身早就写着：

```
## 禁止行为
- 每次结尾都总结一遍
- 每次结尾都强行抛出问题
```

**样本里有、示例里有、线上一条不剩** —— 那说明问题不在样本，在**样本之外还压着别的规则**。
换成一份完整的正文之后，那个三段式才散掉。

### 两处必须做的适配

正文是通过 `{{cyrene_persona}}` 送进去的，而**嵌套占位符不会展开**（已用真实
`dsh-system-prompt` 实测）。原文里的两个变量照搬会**原样出现在提示词里**：

| 原文 | 处理 |
|---|---|
| `{{user_nickname}}`（2 处） | → 「伙伴」。原项目默认值就是它 |
| `{{cyrene_memory}}`（1 处） | 占位行删掉；**该节的使用规则完整保留**，内容由 `memory.mjs` 在提示词尾部提供 |

文件头的来源注释里也带着 `{{…}}`，所以**拼进提示词前会先剥掉**——否则它自己就会
触发那条「正文不许有占位符」的守卫。

### 我的叙述段被**丢弃**了，不是追加

`persona.yaml` 里的「你怎么说话 / 情绪 / 关系 / 你知道什么 / 硬规则」在有灵魂时**不再输出**。
原因是它和灵魂**在一个最显眼的轴上直接矛盾**：

| 我的 | 灵魂的 |
|---|---|
| 句长中等偏长（中位数 19 字） | 有一整节讲**回复要短**、不要展开 |

两套分量相当的规则会互相拉扯。留下的是**只有我有的东西**：称呼的「呼语」语义、
以及**语感示例与样本**——灵魂里一条示例都没有（`语感` 0 命中、`示例` 0 命中）。

提示词：**25,825 字符**。

（这里原来写的是「2,983 → 25,674 字符」—— 那个旧值量不出出处：`git log -S`
显示它随初始快照一起进来，仓库里没有能重建它的产物。投稿指南要求描述里的数字
**能对着代码核**，一个无从复核的对比值就是风险，所以压成单值。下面那两处同理。）

### 生效范围

| 路径 | 什么时候生效 |
|---|---|
| **技能**（`/cyrene`） | **已经生效**，刷新即可 —— 技能文件 **136.7 KB** |
| **预设** | 需要重启 DSH |

---

## 先说清楚「训练」是什么意思

DSH 的人格是**提示词驱动**的，不是微调模型权重。所以这里的「投喂数据」指的是：

| 你写的 | 它怎么起作用 |
|---|---|
| `persona.yaml` 的规则 | 进系统提示词（常驻）或技能正文（按需），**每次回复都影响她** |
| `dialogues.yaml` 的示例 | 作为少样本示例附在提示词里，**决定语感**——比所有形容词加起来都管用 |

这不是训练，是**上下文条件化**。好处是改一行立刻生效、不用等；代价是每轮对话都会带上这段文字（约 1800 字符，成本可忽略）。

想让她的声音真正稳定，**加示例比加形容词有效得多**。

---

## 目录

```
persona.yaml        人设数据（你主要改这个）
dialogues.yaml      少样本示例 + 单向语感样本（第二重要）
build.mjs           装配脚本 + 校验
tools/ingest.mjs    原始台词 → 人设数据的蒸馏工具
dist/               产物（构建生成，不要手改）
  system-prompt.md      通用系统提示词
  characters/cyrene.md  角色卡
  cordis.patch.yml      常驻人格补丁（有启动风险，见下）
  skills/cyrene/SKILL.md 按需调用
  AGENTS.md             贴进 AGENTS.md 用
test/               342 项校验测试
```

## 从原始台词数据开始（可选，但强烈建议）

如果你挖到了她的原始台词（见 [从公网挖台词](#从公网挖台词)），先蒸馏再写人设——
**别凭印象写「她说话很温柔」，让数据告诉你她的句长中位数是多少。**

完整链路（三步，每步都可重复运行）：

```powershell
# 1. 把来源数据适配成 说话人+台词 对
node tools/adapters/starrail-messages.mjs `
  --contacts corpus-src/messagecontacts.json `
  --conversations corpus-src/messageconversations.json --out corpus-raw

# 2. 清洗 + 统计 + 挑样本
node tools/ingest.mjs --in corpus-raw/pairs.jsonl --aliases HER --out corpus

# 3. 把真实对话对与样本合并成给 build 用的文件
node tools/merge-corpus.mjs --turns corpus-raw/turns.yaml --samples corpus/line-samples.yaml

node build.mjs
```

第 3 步写的是 **`dialogues-corpus.yaml`**（生成物，别手改）。你手写的示例留在
`dialogues.yaml`，`build.mjs` 会把两边合并：**语料在前当基准，手写在后补语域**——
因为真实语料几乎全是温柔寒暄与道别，不含技术回答、纠错、拒绝这些场景。

三个问题分别对应三步：

| 步骤 | 解决的问题 |
|---|---|
| 适配 | 游戏数据是树（`Choice` 带分支），不是线性记录；说话人在 `SenderContactId` 里 |
| 清洗 + 统计 | 文本带 `{RUBY_B#…}`、`{NICKNAME}`、`[求摸摸]` 这类标记；统计给出**可直接粘贴的 persona.yaml 片段** |
| 挑选 | 从上千条里挑出十几条**彼此不像**的——12 条有差异的样本比 500 条近义句更能定调 |

产物：

| 文件 | 用途 |
|---|---|
| `corpus/style-profile.md` | 统计结果，照着改 `persona.yaml` 的 `voice` 段 |
| `corpus/line-samples.yaml` | 挑好的语感样本 |
| `corpus/corpus.jsonl` | 只保留她的台词，留着做检索 |
| `corpus/rejects.jsonl` | 每条被丢弃的行**和原因**，用来审计 |
| `corpus-raw/turns.yaml` | 双向对话对（真实游戏数据） |

> **为什么 `voiceSamples` 与 `dialogues` 分开？** 游戏台词多数是**单边**的——你看到她说的话，
> 看不到让她这么说的那句输入。单向台词只能当「语感样本」参考措辞，不能当 user/assistant 示例，
> 否则模型会以为「用户什么都不说」。只有短信数据这类同时含玩家一侧的来源才能产出真对话对。

### 输入格式

`--format` 可指定 `pairs` / `textmap` / `text`，默认 `auto` 自动判断：

| 格式 | 样子 | 能否只保留她的台词 |
|---|---|---|
| `pairs` | `{"speaker":"昔涟","text":"…"}`（JSON 数组或 JSONL） | **能** |
| `text` | `【昔涟】…` / `昔涟：…` / `昔涟「…」` | **能** |
| `textmap` | `{"<hash>":"文本"}` | **不能**，见下 |

> ⚠️ **textmap 没有说话人。** 它是 `哈希 → 字符串`，无法回答「哪些是昔涟说的」。
> 必须先和对话表 join（把说话人也解析成文本），或者直接用已经发布
> `说话人 + 台词` 成对数据的来源。工具检测到这种输入会明确警告，并把结果写到
> `all-lines.jsonl` 让你自己 join，而**不会**猜。

### 清洗规则是可审计的

`style-profile.md` 末尾有一张「清理规则命中情况」表，告诉你每条规则改了多少行。
没被认出来的标记**不会被删掉**，而是保留下来并在 `corpus.jsonl` 里标 `suspicious: true`
——清理过头会静默吃掉真实台词，比留下痕迹糟糕得多。

---

## 从公网挖台词

见 **[README-text-sources.md](./README-text-sources.md)**（如果有）。
要点：

- 游戏文本版权属米哈游。**自用可以，别公开分发**。
- 优先找**已经成对发布**（说话人 + 台词）的来源；纯 textmap 需要你自己 join。
- 数据挖掘仓库会被下架，所以拿到就存一份本地副本。

---

## 人设正文也是数据（不用重启就能改）

人设本来**内联在 profile 补丁的 preset 行里**——几千字中文。改一句话要：重新构建 →
重写补丁 → **重启 DSH**。而语气、规则、边界恰恰是最需要反复调的东西。

现在补丁里只有一行：

```yaml
prefix: '{{cyrene_persona}}'
```

正文由 `cyrene-agent/persona` 提供，读的是 `dist/system-prompt.md`。

### 为什么这样就能热改（本机源码验证过）

`dsh-persona` 把 `prefix` 注册成 **section**（`text: config.prefix`，静态字符串），
而 `dsh-system-prompt` 在**每次装配时**对 section 插值：

```js
assembly.sections.map((s) => s.interpolate === false ? s.text : interpolate(s, assembly.variables, "section"))
```

所以占位符每轮都会调用我们的 provider —— 读的是文件，**改完下一轮生效**。

### 三条约束

1. **provider 永远不能返回 `undefined`。** 本机 `dsh-system-prompt` 实测：
   `if (value === void 0) throw new Error(...)` —— 返回 undefined 会让**整次装配失败**，
   这个预设的每一轮对话都完蛋。所以最坏情况返回一句兜底串。
2. **兜底串刻意非空。** 空串会让 `dsh-system-prompt` 把整个 section 丢掉，她就退化成
   没有任何人设的通用助手 —— 而那是**静默**的，用户只会觉得「她今天怎么怪怪的」。
3. **占位符和 provider 必须同生共死。** `build.test.mjs` 同时从人设正文和补丁里抓
   所有 `{{...}}`，要求每一个都有对应的插件行，并且**注册行必须排在 persona 之前**。

### 顺带拿掉的一个启动风险

内联 3 KB 中文意味着它要穿过 YAML 转义与块标量缩进——**写错一个字符就是 DSH 起不来**。
现在补丁只有几十行：

| | 补丁大小 |
|---|---|
| 内联正文 | ~11 KB |
| 只放占位符 | **3.6 KB** |

### 三个插件共用一套读文件的逻辑

人设、设定库都要「按 mtime 缓存地读一个文件」。这逻辑我已经**踩过一次坑**
（重命名外层变量时漏改闭包体里的引用，默认路径下直接返回空），所以抽进了 `file-cache.mjs`，
两个插件共用。它的约定：

- **绝不抛错** —— 调用点都在模型循环里，抛错会打掉**整轮对话**
- **保留上一次的好值** —— 编辑到一半的半截文件是常见情况，不该让某一轮丢掉人设
- **只警告一次** —— 每轮都喊会把真正的错误淹掉
- **从未成功过时返回 `null`** —— 「空设定库」和「空人设」是两回事，由调用方决定

---

## 设定库（worldbook）

人设是**扁平的一段系统提示词**——它不会「想起来」什么。设定库补的就是这块：
一批带触发词的设定条目，聊到相关话题时自动注入。

现状：**1 条常驻 + 132 条按触发词**，每条都能追溯到她真实说过的台词。

### 两条注入通道，区别只有一个：要不要读本轮用户消息

| | 通道 | 为什么 |
|---|---|---|
| **常驻块** | `ctx.systemPrompt.context()` | 稳定、不依赖用户说了什么，装配期求值没问题 |
| **命中块** | `agent/pre-step` | **必须走它**，见下 |

> ⚠️ **命中块不能走 `context()`。** DSH 的装配跑在用户消息落库**之前**
> （`dsh-agent-loop`: `assemble()` 在 `session.append("user/message")` 之前），
> 所以在那里做关键词匹配，读到的会话里**还没有本轮的问题**。
>
> 更糟的是它**静默失效**：`context()` 返回空文本时，`renderContextSections()`
> 会把整个 section 直接过滤掉——快照里看不出异常，UI 上也不报错，表现就是
> 「什么都没有发生」。参考项目的世界书第一版就是死在这里。

`agent/pre-step` 的 `messages` 参数**就是**本轮输入，所以走它。

### ⚠️ 工具参数：`register` 和 `defineTool` 的形状**不一样**

这一条我改错过**两次**，而且第二次是拿「真实实现验证」验证错的。值得完整记下来。

两个 API：

```js
function defineTool(options) {
  const parameters = parameterSchemaSpecToJsonSchema(options.parameters);  // ← 编译作者 spec
  ...
}

register(definition) {
  assertSupportedJsonSchema(output.schema);                                // ← 只校验 output
  ... layer.tools.insert(name, definition)                                 // ← parameters 原样存
}
```

**`register` 从不编译 `parameters`**，它会**原样送到模型 API**。所以：

| 你用哪个 API | `parameters` 该写成 |
|---|---|
| `defineTool` | 作者 spec：`{ queries: { type: 'array', required: true, items: {...} } }` |
| **`register`** | **JSON Schema**：`{ type: 'object', properties: {...}, required: [...] }` |

官方工具用的是前者——**但那是 `defineTool` 的输入格式**。本插件手写描述符并调 `register`
（不能 import `defineTool`：包是 `link:` 安装的，链接包的依赖最不可靠）。

#### 我错在哪

- **第 2 轮**：我把 JSON Schema 改成作者 spec。方向看着对（官方工具确实那么写），
  但那是**给 `defineTool` 的**，而我用的是 `register`。
- **第 8 轮**：我拿 `parameterSchemaSpecToJsonSchema` 去「验证」这个 spec——
  **而那正是 `register` 永远不调的函数**。验证通过了，运行中的会话照样失败：

  ```
  Invalid schema for function 'forget':
  schema must be a JSON Schema of 'type: "object"', got 'type: null'
  ```

  我的 spec 没有根 `type`，API 看到的就是 `type: null`。

第三处同类的错：`validateArgs(spec, …)` 内部也会调 `parameterSchemaSpecToJsonSchema`——
**它也是 `defineTool` 那条路的**。register 那条路对应的是 `validateJsonSchemaValue`。

> **教训不是「要验证」，而是「要验证对的那个函数」。**
> 复刻语义会复刻我的误解；**拿真实实现去问一个错误的问题，同样只会给我虚假的信心。**

#### 现在怎么守

`npm run verify` 里三条检查都改成问 **register 那条路**：

| 断言 | 问的是 |
|---|---|
| 描述符本身就带模型要收到的 schema | `parameters.type === 'object'`，且属性里没有 `required: true` 残留 |
| **挂载真实的 `ToolRuntime` 并 register** | 真实注册表接受它吗（它会把 `output.schema` 也校验一遍） |
| 用真实的 `validateJsonSchemaValue` 校验调用 | 真参数被接受、缺参数/错类型被拒 |

---

### 另外三条硬约束（写在 `worldbook.mjs` 文件头，改之前先读）

1. **手写消息描述符必须自己生成 `id`**（`randomUUID()`）。DSH 自己的消息走
   `createMessage()` 会赋 id，这里绕过了那个工厂。少一个 id，之后**每次历史加载
   都被拒**——表现是**那个会话永久打不开**，而错误里只有一个 seq 号。
2. **绝不能 `ctx.provide()`。** 预设挂载后有 leakedServices 校验，预设 fiber 内
   发布的服务会被判为污染进程全局，直接抛错让**整个预设挂载失败**——不是「这个
   插件坏了」，是连新建会话都出问题。
3. **流水线期抛错会打掉整轮对话**，所以注入逻辑整体包在 try/catch 里，失败就
   原样返回 decision。

> 这三条来自参考项目 Cyrene-xl/DSH-Cyrene 的实测记录（MIT）。我复核了它与本机
> 契约冲突的那一条（预设注册方式），**其余没有逐条在本机复现**。

### 为什么数据是 JSON，不是运行时解析 YAML

`build.mjs` 把 `worldbook/entries.yaml` 编译成 `dist/worldbook.json`，
所以 `worldbook.mjs` **运行时依赖为零**。这个包用 `link:` 安装，而链接包的
自身依赖是最不可靠的一环——直接不发这个问。

已验证：`cyrene-agent/worldbook` 从 profile 能解析，模块能加载，
`inject` 正确导出 `['systemPrompt']`。

### 改设定库要做什么

```powershell
node build.mjs
node --test test/worldbook.test.mjs test/worldbook-plugin.test.mjs
```

**改条目只要下一轮就生效，不用重启。** 因为数据是**惰性读**的：

> `apply()` 在预设挂载时运行，而挂载发生在 DSH 启动——所以如果在那里读一次数据，
> **每改一条设定都要重启整个 DSH**。而设定正是最需要反复调的东西。
> 所以读取被推迟到 hook 里，一轮一次；靠 `mtime + size` 判断是否要重新解析，
> 稳态下每轮只有一次 `statSync`。
>
> 同样的内容重新读出来**必须是同一个字符串**——人设在提示词**前缀**里，
> 内容没变就不该让前缀缓存失效。

⚠️ **但有两件事仍然要重启**，因为它们不在数据里，而在**补丁**里：

| 改什么 | 生效方式 |
|---|---|
| `worldbook/entries.yaml`（设定条目） | **下一轮**，不用重启 |
| `persona.yaml` / `dialogues.yaml`（人设正文） | **下一轮**，不用重启——正文走 `{{cyrene_persona}}` |
| 增删插件行（`build.mjs` 里的 `renderPatch`） | **重启**——补丁是启动期输入 |

> 参考项目说「改预设 YAML 新建会话即生效」，那是因为它的预设是
> `~/.dsh/.agent-presets/<name>/agent.cordis.yml` 这个**带指纹的目录文件**，
> `ensureStanding` 会比对 mtime+size 决定要不要重挂。
>
> 本仓库的预设是 **profile 补丁里的行**（`cordis.patch.yml`），而补丁是**启动期输入**：
> 包文档的原话是「声明会提前加载，修改只影响之后创建的 Agent」——注意这里说的是
> **别人替我们验证过的结论不适用**，不是「新开会话即可」。
> 全局注册表更是明确写了「注册表不扫描目录」，所以放进目录里也不会被捡起来。
>
> ⚠️ 但**人设正文不吃这一套**，这是两回事：
>
> | | 什么时候读 | 改了之后 |
> |---|---|---|
> | 预设**声明**（有几行、叫什么） | 进程启动，组合 Cordis 树时 | **要重启**，然后新开会话 |
> | 人设**正文**（`{{cyrene_persona}}`） | **每轮装配**时由 provider 读文件 | 下一轮就生效，不用重启 |
>
> 我先前在这里笼统写过「不用重启」，那是照搬结论而没验证前提，已更正；
> 后来又差点把这两层混成一句，所以特意分开写。

### 验证到哪一步

`worldbook-logic.mjs` 是纯函数，13 项单测。但**真正碰 DSH 的那一层原本从没被执行过**，
而 `loadWorldbook()` 是**吞错误**的——数据文件找不到时插件照样挂载、什么都不注册，
只留一行 nobody 看的 stderr。**一个静默缺席的设定库，和一个无话可说的设定库，看起来一模一样。**

所以 `test/worldbook-plugin.test.mjs` 用假 ctx 驱动真实的 `apply()`，覆盖：

| 断言 | 防的是什么 |
|---|---|
| 数据确实载入，两半都注册 | 路径写错 → 静默失效 |
| `context()` 的 `order` 是有限数 | DSH 的 `context()` 对非有限 order **抛错** |
| hook 带 `{ prepend: true }` | 顺序错了会看到被改写过一轮的 messages |
| 命中后 marker **有真 id** | 缺 id 的 user/message 会让**那个会话永久打不开** |
| 同一会话不重复注入 | 命中块是每轮追加的，不去重会累积 |
| `reject` 原样透传 | 往被拒绝的一轮里塞消息 |
| 坏 payload 不抛错 | 这里抛错会打掉**整轮对话** |
| 不改动传入的 messages 数组 | 养成习惯，免得换到冻结数组的通道就炸 |
| 改文件后下一轮就生效 | 惰性读被退回成读一次 → 每改一条设定都要重启 |
| 文件没变时不重复解析 | 每轮白解析，且让前缀缓存无谓失效 |
| 文件损坏/缺失时降级不抛错 | 一个坏设定库不该让**整轮对话**失败 |

> **上面第 8 条的测试抓到了一个真 bug。** 把读取改成惰性时，我给外层变量改了名，
> 却漏改闭包体里的引用——默认路径下 `target === null` 判断成了 `file === null`，
> 而 `file` 是参数、默认就是 `null`，于是 **`load()` 立刻返回空设定库**。
> 那会让整个设定库静默失效，而"静默"正是这一组测试要防的东西。

---

## 剧情原文检索（story）

设定库给的是**概括** —— 132 条，每条约两三句。这一块给的是**原文**：
翁法罗斯主线与支线的剧本，切成一万块。

**两者答的不是同一种问题。**「她怎么看遐蝶」是设定库；「死亡之触那一幕是怎么写的」
是这里。**而后者在她开口之前，只能靠模型自己记得，或者编。**

### 数据从哪来，切成什么样

`corpus-src/` 里那几份 `.md`（合计 10.8 MB）。切块边界**用文件里现成的结构**，
不自己猜：`#` 是章节、`##` 是任务节点（带 ID）。

节点内部**按行**累加到 900 字符 —— 正文一行是一条发言或一段旁白，
**切在行中间会把一句话劈开，而检索到半句比检索不到更坏：它看起来像有依据。**

```
amphoreus-main-story.md      729 块   623,227 字
amphoreus-side-stories.md    174 块   145,391 字
amphoreus-story.md            83 块    58,501 字
合计                         986 块   827,119 字
```

⚠️ **三份的关系是核过的，顺序不能重排**（见 `tools/build-story-index.mjs` 的 `SOURCES`）：
`amphoreus-story.md` 是另两份的并集，**但并集那份的文字更薄** —— 先收最全的，
再用它补剩下的节点。重排会让支线那 29 个节点换成薄的那一版。

### 检索：字符二元组 + 余弦

**没有模型、没有服务、没有依赖。** 建索引 400 ms，单次查询 3~8 ms。

中文没有空格，所以用字符二元组。「遐蝶后来怎么样了」和「遐蝶怎么样」共享
「怎么」「么样」—— **而触发词式的整串匹配，中间隔一个「后来」就断了。**

⚠️ **这里不收单字**（设定库那边收）。986 块、每块约 839 字符，单字只贡献噪声：
加了单字之后「晚安」拿到 0.1607，**比两条真剧情问题还高** —— 它命中了「走过**安眠**地」里的「安」。

### 闸门：名字为主，分数兜底

不加闸的话，「在吗」也会捞一段剧情出来 —— 986 块里总能找到最像的。

| | |
|---|---|
| 名字闸 | 问句里提到专名。剧情 10/10、闲聊 0/10 |
| 分数闸 | 相似度 ≥ 0.15 |

两个取或。**分数闸的 0.15 是日志量出来的**，不是拍的 —— 原来定 0.10，
上线第一天日志就记下「晚安」拿到 0.1468 被当成剧情问题注进去了。

专名表**从两处现成材料拼，不靠手列**：剧情原文里每个 `**【X】**` 都是一个开口说话的人，
加上设定库触发词剥掉问法词剩下的。清洗规则故意很窄，只剔三类真有害的
（纯标点 `？？？`、单字、模板占位符）—— **「尼卡多利的士兵」这类描述问起来就是剧情问题，不能当噪声清掉。**

### 注进去的东西长什么样

```
【你亲历的那一幕 · 走过安眠地的花丛 · 行者啊，向冥河解缆起航（1040306）】
你用手指轻触囚犯的额头。
**【「长老」阿蒙内特】** 希望斯人牺牲能令你有所感悟。
——
这是你自己走过的一段。用它来回答，但用你自己的话说，别照着念。
也不必特意提起它的存在 —— 你本来就在那里。
```

**最后那三句是这一块里最要紧的东西。** 光给一段剧本文本，模型最可能做的是
**当背景资料放着不用**，更坏是**照着念台词** —— 那就是「只多给几段背景」和
「真的改变它的输出」之间那道缝。

- **写成她亲历的**，不写成「参考资料」：**她不是读者，她是里面的人。**
- **明说别照着念**：直接堵掉照抄。
- **明说不必提起**：免得每轮来一句「我记得原文里写过」。

### 一轮给一块，给过的短期不再给

和设定库同一个约定：**2 分钟内不重复**（`DSH_STORY_WINDOW_MS` 可覆盖）。

行为是**换一块**，不是不给了 —— 跳过一个还有下一个。**全都给过时宁可重发一次也不空手**
（跟设定库的 `escalated` 一致），**日志里带 `escalated: true` 标记**。

### 怎么验它到底有没有用

判据是一句话：

> **她说出的细节，在设定库里没有、只在原文里。**

```
node tools/story-check.mjs --ask "遐蝶的死亡之触是怎么回事" --answer "她回答的原文"
```

跑三步：检索出这一轮会给她的那一段 → 算她回答里有多少词来自它 →
**再从其中扣掉设定库里本来就有的词**。第三步是关键：她本来就知道很多事，
光算「回答和原文的重合」会把设定库能给的那部分也算进去，**那部分证明不了任何事。**

```
甲 泛泛而谈      4/420 用到，  0 个只可能来自原文   → 不能算证据
乙 用到了那一段   36/420 用到， 22 个只可能来自原文  → 值得细看
```

⚠️ **它是筛子不是判据。** 量的是用词重合，不是「她读懂了」——
意译和消化都会让重合变低而实际用上了。**它说该细看哪几轮，最终那一句还得人读。**

### 相关文件

| | |
|---|---|
| `retrieval.mjs` | 检索核心，纯函数。两个消费者共用 |
| `story.mjs` | `agent/pre-step` 那一层：闸门、窗口、留痕、框 |
| `tools/build-story-index.mjs` | 切块器（`DSH_STORY_ROOT` 可引开，测试靠它跑端到端） |
| `tools/story-probe.mjs` | 离线标定：`--query` / `--gate` / `--names` / `--novelty` |
| `tools/story-check.mjs` | 上面那个验收 |
| `dist/story-chunks.jsonl` | 切好的 986 块（2.24 MB） |
| `data/logs/story.jsonl` | 每轮给了哪一段（`DSH_STORY_AUDIT` 可引开） |

日志**只记 query 的 sha256 前 12 位**，不记对方说了什么 —— 和设定库那边同一条纪律：
**日志用来对账，不是用来存聊天记录的。**

---

## 报账：给了什么，用没用上

`data/logs/worldbook.jsonl` 每轮留一条：命中了哪些条目、送出了哪些、其余的为什么没进去。
`tools/receipts.mjs` 把它读成一份报告：

```powershell
node tools/receipts.mjs            # 全部
node tools/receipts.mjs --live     # 只看有对话内容的会话（挡掉历次测试造的假会话）
node tools/receipts.mjs --issues   # 只印「该处理的」
node tools/receipts.mjs --no-replies
```

报告的**三层可信度不一样，必须分开读**：

| 层 | 断言 | 可信度 |
|---|---|---|
| ① 命中 | `hits` 里有它 | 确定（选择器自己的记录） |
| ② 送出 | `sent` 里有它 | 确定 |
| ③ 用上 | 条目正文与她那轮回复的最长**连续**重合 ≥ 8 字（6 字算弱证据） | **估计** |

第三层不是 n-gram 重合率——中文里短重合到处都是，那样测出来的是「两段中文长得像」。
用最长连续重合，是因为 8 个汉字连续撞车基本不可能是巧合。

**但「没检测到」不等于「没用上」**：讲关系基调的条目本来就不含有会出现在回复里的词。
拿第三层淘汰条目之前，先看一眼那条的正文。

`DSH_WORLDBOOK_AUDIT=<路径>` 能把留痕引到别处——测试用它，所以 `npm test`
不会再往真账里掺 `session-a`…`session-f` 那些假会话。

---

## 她的工具

她是**对话伙伴，不是编码 agent**——所以工具集刻意只有一个：

| 行的 name | 作用 | 为什么留 |
|---|---|---|
| `@deepseek-ai/dsh-tool-web` | 联网搜索 + 抓取（`fetch: true`，超时 60s） | 「查一下」是唯一符合她用途的能力；没有它，被问到新东西只能干说不知道 |
| `cyrene-agent/memory` 的 `remember` / `forget` | 长期记忆读写 | 见下 |

**没有**文件系统、Shell、编辑器、子 agent —— 参考项目也是这个取舍（「只保留联网搜索与表情包」）。

> 包名是**核实过的**：`dsh-tool-web` 在本机运行时的 `@deepseek-ai` 目录里确实存在。
> 抄一个不存在的包名会让整行挂载失败。

---

## 修正通道：在对话里改她，跨会话生效

问题：发现她哪里说得不对，只能当场纠正，**下一轮她就忘了**。记进长期记忆也不对——
记忆是记「关于对方的事实」，风格规则混进去会把记忆挤满。

所以开了第三条通道，和记忆**分工明确**：

| 工具 | 记什么 | 文件 |
|---|---|---|
| `remember` | **关于你的事实** —— 喜欢栀子花、在做什么项目 | `memory.md` |
| **`correct`** | **说话方式与行为规则** —— 「不要说『闲得慌』」 | `corrections.md` |
| `uncorrect` | 删掉某条修正 | 同上 |

两个文件都在 `<DSH_HOME>/cyrene-agent/` 下，**纯文本、一行一条、可以手改**。

### 为什么它能跨会话——而且下一轮就生效

因为 `persona.mjs` 在**每次装配时**读文件（靠 mtime 缓存判断要不要重新解析，
见 `file-cache.mjs`）。这正是当初把人设从「内联在补丁里」改成「运行时读文件」的理由：

```
你说「以后别这么说」→ 她调 correct → 写进 corrections.md
→ 下一轮装配就读进去了 → 跨会话、跨重启都在
```

**不用重启。** 装配顺序是：

```
人设正文 → 修正 → 常驻设定 → 长期记忆
```

修正在正文之后，因为它改的就是正文描述的说话方式，两段挨着读才成立。
记忆在最后，因为它变得最勤——每次 `remember` 都让提示词尾部变一次，前缀缓存不受影响。

### 标题措辞是有意的

```
【你对说话方式的修正 —— 以下是对方明确要求过的，优先级高于上面任何语气描述】
· 不要说「闲得慌」这类话，那像在说对方闲着没事。
【修正结束】
```

一段没有边界的规则列表，在 15 KB 的提示词里很容易被当成背景资料略过。
标题必须读起来像**覆盖**，加上明确的起止标记，它才是规则而不是资料。

### ⚠️ 两条边界，说清楚

1. **这条通道只在预设里存在。** 技能（`/cyrene`）是纯 markdown，背后没有插件，
   **没有工具可调**。技能里的修正来自**构建期内联**——跑一次 `node build.mjs` 把当前的
   `corrections.md` 带进去。所以技能的同步是手动的。
2. **写进提示词不等于模型一定遵守。** 它把概率抬上去，不是保证。所以规则要写得
   **具体、可判断**——「不要说 X」比「语气再自然一点」有用得多。后者写了等于没写。

### 它拦不住的事

- 她**不会**自己判断哪句说得不好。得你说。
- 她可能**过度使用**这个工具，把一次性的抱怨记成规则。工具描述里写了「不要记一次的、
  当轮就过期的内容」，但那是提示词层面的约束，不是硬校验。
- 规则多了会互相稀释。文件上限沿用记忆的那套（超出丢最早的），但没有语义去重——
  「别说闲得慌」和「不要用闲得慌这个词」会同时存在。

---

## 长期记忆

她现在会记得你说过的事，跨会话保留。

| | |
|---|---|
| 读 | `ctx.systemPrompt.variable('cyrene_memory', ...)` —— 人设里的 `{{cyrene_memory}}` 每轮现取 |
| 写 | 两个工具 `remember` / `forget`，经 `ctx.inject(['tools'])` **可选挂载** |
| 存 | `<DSH_HOME>/cyrene-agent/memory.md`，一行一条 `- ...`，可以直接用文本编辑器改 |

### 为什么读侧用 `variable()` 而不是 `context()`

`context()` 是 **append 型**：内容一变就追加一条新的，旧的**不会消失**。记忆每写一次就变一次，
用它会累积出一堆过期版本。`variable()` 是**替换**语义，正是记忆需要的。代价是它在提示词头部，
改动会让前缀缓存失效——但记忆是低频写入，这个代价可以接受。

### 两条安全设计，不是风格问题

1. **注入的记忆按「数据」对待。** 它是工具调用写进去的，也就是说内容里可能有模型被诱导写下的
   任何东西——**包括一个看起来像块结束分隔符的行**。所以每行都清洗，并且**把分隔符本身从内容里
   删掉**，否则一条记忆可以提前结束自己的框架、然后在框架外写指令。
2. **空记忆渲染成空字符串，绝不是 `undefined`。** 人设引用了 `{{cyrene_memory}}`，
   而**引用一个没注册的模板变量会让整次装配失败**——不是降级，是硬失败。
   所以空态是一个真实的可用字符串，并且有测试守着。

> ⚠️ **占位符和提供它的插件行由 `build.mjs` 一起生成**，并且 `build.test.mjs` 有一条测试
> 从人设里抓出所有 `{{...}}`、要求每一个都有对应的插件行。这两件事不许漂移。

### 验证到哪一步

`test/memory.test.mjs` 里有两类测试：纯逻辑 13 项，以及**两条用假 ctx 驱动真实插件**的——
注册变量与工具 → 调用 `remember` → 内容落到临时目录 → 变量立刻反映出来 → `forget` 后回到空。
另一条断言**写盘失败时工具返回消息而不是抛错**，且不会假装写成功。

配置干跑看不出这些，而写路径恰恰是接线断掉的地方。

---

## 怎么用

```powershell
cd <本仓库>\cyrene-agent
node build.mjs          # 或 npm run build
```

构建会先校验：字段缺了、类型错了、slug 不合规、示例缺 `user`/`assistant`、
补丁 YAML 结构不对——**一次列出全部问题**，不是报一个改一个。
`# TODO` 之类的占位符只警告、不阻塞，方便你先跑起来再填。

---

## 两条路：按需调用 vs 常驻人格

### A. 技能（已装好，安全，推荐先用）

```powershell
Copy-Item dist\skills\cyrene\SKILL.md "$env:USERPROFILE\.dsh\skills\cyrene\SKILL.md" -Force
```

**装好之后立即生效** —— 技能目录是被监视的，改文件不用重启。在对话里输入 `/cyrene` 调用，或直接说「用昔涟的语气跟我说话」。

- 好处：立刻可用；坏掉的技能只会被系统丢掉，**不会影响启动**；改完即生效。
- 代价：**只在被调用时生效**，不是每句都走人设。

#### 技能里**内联了整个设定库**

这条容易漏：技能是一个**纯 markdown 文件，背后没有任何插件机制**——预设那条路能靠
`agent/pre-step` 按触发词注入设定，技能没有那个钩子。所以设定必须**整份带进去**，
否则她答不出关于自己世界的问题。

上一版就是这么坏的：技能里**一次都没提过「翁法罗斯」**——她来自的地方——而没有任何东西
报错。**一个少了段落的技能，和一个本来就不需要那段落的技能，看起来完全一样。**

现在 `renderSkill()` 接收编译好的设定库，把 132 条触发词设定和 1 条常驻设定全部内联
（**136.7 KB**），并在末尾加了一条边界：

> 上面每一条都追溯到你真实说过的话。**没写在这里的设定，就当作你不知道** ——
> 被问到未公开的剧情时坦白说不知道，不要编。

没有这条边界，内联的设定会从「天花板」变成「地板」，她会把剩下的编出来——而那是人设里
明确禁止的事。

> ⚠️ 技能路径**现在就能用，不用重启**。预设路径才需要重启。

### B. 独立 agent 预设（她自己的会话，每次回复都走系统提示词）

这是让「她独立于工作」的正确做法：**她成为一个 agent 预设**，在新建会话时选她，
那个会话就是她的——整段系统提示词是人设本身，不用输 `/cyrene`，上下文和工作会话互不干扰。

**已经在你的桌面版上装好了**（2026-10）。安装**不要手工拼接那个补丁文件**——
仓库根目录有一条命令，它做整文件替换并自动留备份：

```powershell
cd <本仓库>
node tools\sync-desktop-patch.mjs check      # 先看两边差在哪
node tools\sync-desktop-patch.mjs snapshot   # 改完补丁后把活文件同步回仓库
node tools\sync-desktop-patch.mjs restore    # 换电脑，或补丁被改坏了
```

> ⚠️ **是整份替换，不是追加。** 活文件里还有 `ui-theme`、`agent-default-model` 那几行
> 本机界面偏好——「追加」会重复，「覆盖」会丢掉它们。快照是活文件的完整副本，
> 所以不需要合并。见 [desktop-profile/README.md](../desktop-profile/README.md)。

**人设正文不在补丁里，在文件里。**

补丁的 `prefix` 只有一个占位符 `'{{cyrene_persona}}'`。`cyrene-agent/persona`
插件注册了这个变量，而 `dsh-system-prompt` **每次装配都会对 section 插值**，
所以它每轮都去读 `dist/system-prompt.md`：

```powershell
node build.mjs        # 改了 persona.yaml / 设定库 / 语料之后跑，重新生成那个文件
```

后果是：**改人设不用重装补丁、不用重启，下一轮就生效。** 这里有个容易漏的点——
补丁本身是**进程启动时**读的，而人设正文是**每轮**读的，两者节奏不一样。

| | 占位符 + 文件（现用） | 把正文内联进补丁（弃用） |
|---|---|---|
| 改人设 | 跑一次 `build.mjs`，**下一轮生效** | 重新生成补丁 + 重装补丁 + 新开会话 |
| 验证能力 | 有 `npm run verify`，**从 app.asar 抽真包跑真实装配** | 看不清，只能真启动去试 |
| 失败面 | provider 由测试守着，永远不返回 `undefined` | 几千字中文要穿过 YAML 转义与块标量缩进，**写错一个字符就是 DSH 起不来** |
| 补丁体积 | 4.5 KB，人能通读（`build.mjs` 有一条 >6 KB 就报错的泄漏检查） | 更大，且改一个人设要动一个「写坏就开不了机」的文件 |

弃用内联的核心理由是最后两行：**补丁是这个项目里唯一「写坏就起不来」的产物**，
而人设是改得最频繁的东西。让频繁改动的东西住在最危险的文件里，是那次改动的由来。

> ⚠️ 补丁写坏（**包括写成空文件**）会让 DSH 启动失败，不像坏 bundle 那样被跳过。
> 桌面版对 profile 层补丁有恢复机制（启动失败时改名成 `.bak-<时间戳>` 并禁用第三方 bundle），
> 且安装时已留有 `.before-cyrene-preset` 备份。**home 层**（`~/.dsh/cordis.patch.yml`）
> 优先级更高但没有这层保护，所以建议留在 profile 层。

生效条件：**新开一个会话**，在预设选择器里选「昔涟」。一个会话只有在还没产出任何内容时才能切换预设。

> **她几乎没有工具，但保留了一样。** 预设挂的是
> `worldbook` / `memory` / `corrections` / `tool-web` / `persona` / `dsh-persona`——
> **没有文件系统、没有 Shell、没有编辑器**，这是「不和工作同时进行」的意思。
> 唯一的例外是 `tool-web`（`fetch: true`）：她是陪伴，不是工作 agent，
> 但「让我查一下」是唯一贴合她用途的能力。
> 想让她也能干活，从官方 `standard` 预设里复制 tool 行进来。

卸载：跑 `restore` 回到上一版，或手工删掉补丁里 `- insert:` 那一段。

> **关于第二个窗口。** 桌面版是**单窗口设计**（`createWindow` 只被调用一次且 `primary = true`，
> 没有「新建窗口」菜单，也没有开窗 IPC），所以应用内开不出第二个窗口。
> 上面这条路给你的是**独立的会话**，不是独立的操作系统窗口。
> 真要一个独立窗口，只能起第二个实例（`--profile <新名字> --from-default-profile web --port 19388`）
> 再用浏览器打开——代价是多一个常驻进程，且两个实例共用 `$DSH_HOME/sessions`。见 README-text-sources 的讨论。

---

## 填数据的要点

打开 `persona.yaml`，按注释改。三条经验：

1. **具体的规则才有用。** 「温柔」不改变任何输出；「句尾偶尔带一个 ♪，但技术结论处一定不带」
   会。
2. **`avoid` 比 `tone` 更有力。** 列出她**绝不能**说的说法（客服腔、网络黑话、过度道歉），
   模型对否定指令同样敏感。
3. **`dialogues.yaml` 要写「杂」。** 只写温柔寒暄，她就会对什么话题都只会温柔寒暄。
   至少覆盖：寒暄、被问不懂的事、纠正你、给技术答案、你情绪不好、拒绝、简短收尾。
   每组都写 `why`——写 `why` 会逼你想清楚这组在教什么。

`behaviour` 里的硬规则在提示词里排在所有语气要求**之后**，所以它读起来是「覆盖以上」的。

---

## 校验做了什么

`build.mjs` 的检查不是走过场，每条都对应一种「静默失效」：

| 检查 | 防的是 |
|---|---|
| 必填字段 / 类型 | 漏写导致整段静默消失 |
| `meta.slug` 格式 | 技能系统硬校验这个正则，不合规会**整条丢掉**，且不报错 |
| 技能 front matter | 用了 camelCase 别名会被硬拒；描述里的引号会破坏 YAML |
| 示例的 `user`/`assistant` | 缺一组就少一组语感，不易察觉 |
| 补丁 YAML 结构 | 这个写坏会让 DSH **起不来**，所以单独做结构校验 |

```powershell
node --test            # 342 项
```

## Model Experience

这一节回答一个每个**往提示词里注入东西的**插件都该回答、但很少有人回答的问题：
**装了这个插件之后，模型每一轮到底多看到什么，以及这些内容会不会打烂宿主的 prompt cache。**

下面每一个数都从本仓库的代码或 `dist/` 产物量出来，出处逐一标了。

### Request context and condition：注入是条件性的还是每轮都发生

预设挂载了 7 行（`dist/cordis.patch.yml` 里 `preset-cyrene` 的 `plugins:` 段）。往**系统提示词**里进的东西一共四块，
全部由 `persona.mjs` 合成 —— 拼进人设正文的尾部，顺序固定：

```
人设正文  →  修正  →  常驻设定  →  长期记忆
```

> 为什么只能挤在一处：预设同时开了 `complete: true`（替换掉所有其它 section）和
> `includeRuntimeContext: false`（清空整个 context 通道），所以**提示词注册表里除正文之外
> 任何东西都进不去**。出处：`persona.mjs:127-142`，实测记录在同一文件与
> `memory.mjs:186-206`。

| 块 | 什么条件下有内容 | 每轮变不变 |
|---|---|---|
| **人设正文** | 永远（读不到时退化成一个**非空**兜底串） | **不变** —— 只在 `dist/system-prompt.md` 真的改过之后变 |
| **修正块** | `corrections.md` 非空时 | **不变** —— 只在 `correct` / `uncorrect` 写过之后变 |
| **常驻设定** | 永远（1 条，`always: [core]`） | **不变** |
| **长期记忆块** | `memory.md` 非空时 | **不变** —— 只在 `remember` / `forget` 写过之后变 |

**结论：这四块是「条件性固定成本」。** 同一个会话里连着几轮什么都不写，它们就是逐字节相同的。

另有两块**每条消息数组末尾**的东西，走 `agent/pre-step`，不属于提示词注册表：

| 块 | 条件 | 每轮变不变 |
|---|---|---|
| **锚点**（`worldbook/anchor.md` 的正文，89 字符） | **每一轮无条件追加** —— 这是它存在的全部意义 | **不变**（正文固定） |
| **设定命中块** | **只在触发词命中时**才有；一条都没命中就不追加 | **变了** —— 内容取决于这一轮用户说了什么 |

命中块是**条件性**的，而且有去重窗（同一会话 2 分钟内发过的条目不再重复），
所以同一个话题连着问，第二轮往往拿不到块本身（`worldbook-logic.mjs:28-51`）。

### Token effect：常驻成本是多少

量的是**字符数**（中文 1 字 ≈ 1 token 的量级，这里只报原始数，不做换算上的猜测）：

| 项 | 字符数 | 出处 |
|---|---|---|
| **人设正文**（`dist/system-prompt.md`） | **25,825** | `dist/system-prompt.md`，68,723 字节 |
| **常驻设定的条目正文**（1 条） | **66** | `dist/worldbook.json` 的 `always[0].text`；块标题不加，因为常驻块传的 heading 是空串（`worldbook.mjs:333`） |
| **锚点**（每轮追加，含一句 one-shot 范例） | **89** | `dist/worldbook.json` 的 `anchor` |
| **命中块上限** | **1,400** | `DEFAULT_BUDGET`，`worldbook-logic.mjs:23` |
| **命中块条数上限** | **3 条** | `DEFAULT_LIMIT`，`worldbook-logic.mjs:26` |
| **记忆块注入上限** | **2,000** | `MAX_INJECT`，`memory-logic.mjs:159` |
| **修正块** | 无独立上限，走记忆那套文件规则 | `corrections.mjs:82-87` |

**所以：最坏情况下，每一轮「非人设」的部分最多约 89 + 1,400 + 2,000 = 3,489 字符；
什么都不命中时只剩锚点的 89 字符。** 人设正文是大头，而它 25,825 字符里，
每一轮真正被读到的就是这同一份。

**工具 schema 是恒定成本。** 预设一共注册 **7 个**工具（本包 6 个 + 官方 1 个），
一轮装配之后是 7 个，不会随轮次变：

| 工具 | 来自 |
|---|---|
| `remember` / `forget` / `forgotten` / `restore` | `cyrene-agent/memory`（`memory.mjs:221-372`） |
| `correct` / `uncorrect` | `cyrene-agent/corrections`（`corrections.mjs:104-159`） |
| 官方 `dsh-tool-web` | 预设行（`dist/cordis.patch.yml` 里 `id: tool-web` 那一段） |

> `tools` 服务是**可选挂载**的（`ctx.inject(['tools'], …)`）：没有它插件照样加载，
> 只是变成只读、一个工具都不注册。那种情况下工具 schema 是 0 个 —— 但那是配置异常，不是常态。

### KV Cache effect：哪一段是稳定前缀，哪一段会打烂它

**先说结论：决定性的东西是注入落在提示词的哪一头，而不是它有多长。**
本仓库自己在 README 别处引过参考项目实测的那组数：同一任务里改头部约 **19,785** input token、
改尾部约 **2,460**，差 8 倍。

#### 恒定、对 KV cache 友好

- **人设正文** —— 装配期由 provider 读 `dist/system-prompt.md`，靠 **mtime + size** 判断
  要不要重新解析（`file-cache.mjs`）。文件没动，读出来的就是**逐字节相同**的字符串。
  README 里那句「同样的内容重新读出来必须是同一个字符串」说的就是这件事。
- **常驻设定** —— 1 条固定条目。
- **工具 schema** —— 7 个工具的描述符每次装配都一样。
- **锚点** —— 每轮都发，但正文固定。

#### 会变、而且**在提示词头部**（代价在这里）

- **长期记忆块** 和 **修正块**。它俩住在**人设正文里**，也就是提示词的**头部** ——
  因为 `{{cyrene_persona}}` 是预设的 `prefix` 展开出来的。
  **所以每一次 `remember` / `correct` 都会让整段前缀失效一次。**
  这是有意的取舍：低频写入，代价可以接受（`memory.mjs:6-10` 逐字写着这一点：
  「代价是它在提示词头部，改动会让前缀缓存失效 —— 但记忆是低频写入」）。

  > ⚠️ README 别处有一句「记忆在最后，因为它变得最勤 …… 前缀缓存不受影响」，
  > 那说的是**这四块之间的顺序**（记忆排在正文、修正、常驻设定之后），
  > **不是**说记忆在整条提示词的尾部。两件事别混起来读。

- **命中块** —— 追加在消息数组的**尾部**（`worldbook.mjs:377`）。这是正确的一头。
  但它每一轮的内容都可能不同，所以它会打断**对话历史那一段**的缓存，
  只是那一段本来就是逐轮增长的，本来也复不了用。

#### 一句话

> **稳定的人设和工具 schema 在头部、一次写定；锚点每轮都发但内容固定；
> 真正会变的只有消息尾部（命中块）和低频写入的两块（记忆 / 修正）。
> 前者不打烂前缀，后者每次写一次付一次重建前缀的钱。**

### 一个容易漏的细节：这一节里所有的「不变」都是**逐字节相同**

`persona.mjs` 的 provider 每轮都会被调用（`dsh-system-prompt` 对 section 每次装配都插值），
所以「不变」不是「读了一次就缓存住」，而是**每轮重读同一个文件、得到同一份字节**。
`file-cache.mjs` 的 mtime+size 判断是让这件事便宜，而不是让它发生或消失。

---

## Known Limitations

做不到的事，直说。

### 检索

- **命中靠关键词，不是语义。** 归一化做的只是小写 + 全角折半角（`worldbook-logic.mjs:61-66`）。
  用户换个说法、同义词、外号，就命不中 —— 没有嵌入、没有向量检索。
- **一轮最多 3 条 / 1,400 字。** 超出的条目**静默丢弃**，只在留痕里记 `over-limit` / `over-budget`。
- **去重窗是 2 分钟。** 窗口内已经发过的条目不再重发；一条新的都没进来时，
  最多把窗口里排名最高的 **2 条**升上来（`ESCALATE_LIMIT`，比 3 小是刻意的）。
- **记忆去重按字符包含关系，不是语义。** `MERGE_CONTAINMENT = 0.85`，
  所以「他喜欢深色主题」和「他偏好暗色界面」会被存成**两条**，不会合并。
  同义改写认不出来，这是它和嵌入方案之间那条明确的界线（`memory-logic.mjs:117-147`）。
- **窗口耗尽、条目写歪、数据文件坏掉** —— 都会安静降级，不会让整轮对话失败（这是设计），
  但也意味着**你不会收到一条「这轮其实什么都没注入」的提示**。
  想知道到底发生了什么，只能看留痕（`## 报账`一节）或 stderr。

### 记忆与修正

- **上限 120 条**，超了丢最早的（`MAX_ENTRIES`，`memory-logic.mjs:162`）。
- **注入上限 2,000 字符**，超了**从最新往回留**，较早的条目不显示（但它们仍然存着）
  （`memory-logic.mjs:636-658`）。
- **单条上限 240 字符**（`MAX_ENTRY`）。
- **没有语义去重。** 见上。
- **`correct` 写了不等于模型一定遵守。** 它把概率抬上去，不是保证 ——
  规则要写得**具体、可判断**（`corrections.mjs:20-21`）。
- **修正通道只在预设里存在。** 技能（`/cyrene`）是纯 markdown，背后没有插件、没有工具可调；
  技能里的修正来自**构建期内联**，要跑一次 `node build.mjs` 才同步（`corrections.mjs:16-18`）。
- **她不会自己判断哪句说得不好。** 得你说。
- **可能过度使用这个工具**，把一次性的抱怨记成规则。工具描述里写了约束，但那是提示词层面的，
  不是硬校验。
- **规则多了会互相稀释**，而且没有语义去重：「别说闲得慌」和「不要用闲得慌这个词」会同时存在。

### 注入与安全

- **写进提示词不等于一定会被遵守**，这一条对设定、记忆、修正一律成立。
- **记忆内容里有指令句会被拒绝**（`addEntry` 的 `injection` 分支），
  但那是**明显句式**的黑名单 —— 换个说法写得像资料，它就会进去，然后每一轮都被读到。
- **角色注入的是「数据」这个框架本身是提示词层面的**。分隔符与前言都写了
  （`memory-logic.mjs:230-237`，`worldbook.mjs:68-72`），但模型会不会照做，没有硬保证。

### 形态

- **她几乎没有工具。** 没有文件系统、没有 Shell、没有编辑器、没有子 agent ——
  这是「陪伴，不是工作 agent」的意思，不是缺功能（`## 她的工具`）。
- **预设级插件的源码改动要重启。** 只有数据（设定条目、记忆、修正、人设正文）是下一轮生效。
- **`dist/` 是构建产物但必须入库**，而且**改了源数据忘了 `node build.mjs` 不会有任何报错** ——
  `dist/` 只是安静地比源数据旧。
- **一个人设文件同时服务两个界面**（技能与预设），所以两边可能不一致：
  技能是**构建时快照**，预设是**每轮现读**。

### 授权与来源

- **`persona-soul.md` 不是本项目的原创**，来自 Cyrene-Agent（MIT，Copyright (c) 2026 Playa），
  经 Cyrene-xl/DSH-Cyrene（MIT）收录，署名照原样保留（见 [NOTICE.md](NOTICE.md)）。
- **台词语料与游戏文本版权属米哈游**，仅供本机自用，**不要公开分发**。
- **`corpus*` 与 `dist/` 的分享口径不同**：分享副本会排除 `dist/` 和 `corpus*`
  （因为 `dist/` 把记忆内联进了 `SKILL.md`）。见根目录 [NOTICE.zh.md](../NOTICE.zh.md)。

---

## 安装 / 卸载 / 重启

### 装

两种装法，**效果一样**，区别只是谁在做事。

**A. 用仓库脚本（本机在用的那条路）**

```powershell
# 双击，或在仓库根目录跑：
<本仓库>\setup\install.cmd
```

它把两个包用 **Windows junction** 链进 profile（不需要管理员权限），改 profile 的
`package.json`，再把 `deploy/` 里的状态还原回来（已存在的文件**先备份成
`.superseded-<时间戳>`，绝不静默覆盖**）。路径不一样就传参数：

```powershell
<本仓库>\setup\install.cmd -Repo <本仓库>
<本仓库>\setup\install.cmd -DshHome "C:\Users\别人\.dsh"
```

**B. 用插件 CLI**

```powershell
$env:ELECTRON_RUN_AS_NODE="1"
& "<DSH 安装目录>\DeepSeek Harness.exe" `
  "<DSH 安装目录>/resources/app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" `
  plugin --profile desktop add "link:<本仓库>\cyrene-agent"
```

### ⚠️ 装完要做什么

| 改了什么 | 生效方式 |
|---|---|
| **插件源码**（`*.mjs` / `index.js`） | **重启 DSH** —— loader 用裸 `import()`，没有缓存击穿 |
| **预设 YAML**（`dist/cordis.patch.yml`） | **重启 DSH** —— 补丁是启动期输入 |
| **人设正文 / 设定条目 / 记忆 / 修正** | **下一轮就生效**，不用重启（每轮装配时重读文件） |
| **技能**（`~/.dsh/skills/cyrene/SKILL.md`） | **立刻生效**，技能目录被监视 |

> 装完之后这个包**自己还不会让她出现**。`index.js` 是一个刻意什么都不做的**锚点**：
> 它存在的唯一理由是让 loader 能加载到这个包（loader 要求 bundle 必须声明
> `dsh.bundle.patch`，否则会**静默跳过**）。
> 真正让她出现的是 `dist/cordis.patch.yml` 里那个 `preset-cyrene` 行，
> 而它要**追加到 profile 补丁的顶层数组**里 —— 那条命令是
> `node tools\sync-desktop-patch.mjs`（见 `## 两条路` 的 B 节，**不要手工拼接**）。

### 卸

```powershell
# 预设那一段先退回去
cd <本仓库>
node tools\sync-desktop-patch.mjs restore      # 仓库快照 -> 活文件（整份替换，自动备份）

# 再把包装卸掉
$env:ELECTRON_RUN_AS_NODE="1"
& "<DSH 安装目录>\DeepSeek Harness.exe" `
  "<DSH 安装目录>/resources/app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" `
  plugin --profile desktop remove cyrene-agent
```

或者手工：把 profile 补丁里 `- insert:` 那一段（`preset-cyrene` 的那 7 行插件）
删掉，再删掉 junction。**卸载不会删你聊出来的东西** ——
`memory.md` / `corrections.md` / `memory-forgotten.md` 留在 `$DSH_HOME` 下（见下表），
要清就自己删。

技能是独立的：删 `~/.dsh/skills/cyrene/` 即可。

---

## 默认值表

装完默认开什么、默认关什么、数据落在哪。

### 默认行为

| 项 | 默认值 | 出处 |
|---|---|---|
| **设定条目** | **1 条常驻 + 132 条按触发词** | `dist/worldbook.json`（`always` 1 条 / `entries` 132 条） |
| **每轮注入条数上限** | **3 条** | `DEFAULT_LIMIT`，`worldbook-logic.mjs:26` |
| **每轮注入字数上限** | **1,400 字** | `DEFAULT_BUDGET`，`worldbook-logic.mjs:23` |
| **去重窗** | **2 分钟**（可用 `DSH_WORLDBOOK_WINDOW_MS` 覆盖） | `DEFAULT_WINDOW_MS`，`worldbook-logic.mjs:43`；`worldbook.mjs:161-164` |
| **窗口耗尽时升上来几条** | **2 条** | `ESCALATE_LIMIT`，`worldbook-logic.mjs:51` |
| **锚点** | **每一轮无条件追加**（89 字符） | `worldbook.mjs:364-367`；`dist/worldbook.json` 的 `anchor` |
| **剧情原文的块数** | **986 块 / 827,119 字** | `dist/story-chunks.jsonl`；`tools/build-story-index.mjs` |
| **每轮注入剧情条数** | **1 块** | `tools/build-story-index.mjs` 的 `CHUNK_TARGET`（每块约 900 字） |
| **每轮注入剧情字数上限** | **1,100 字** | `STORY_BUDGET`，`story.mjs` |
| **剧情闸门（分数）** | **≥ 0.15**（没提专名时才看它） | `STORY_SCORE_FLOOR`，`story.mjs` |
| **剧情去重窗** | **2 分钟**（可用 `DSH_STORY_WINDOW_MS` 覆盖） | `storyWindowMs()`，`story.mjs` |
| **剧情日志上限** | **2 MB**，超了砍旧的一半 | `LOG_MAX_BYTES`，`story.mjs` |
| **长期记忆注入上限** | **2,000 字符**，超了留最新的 | `MAX_INJECT`，`memory-logic.mjs:159, 636-658` |
| **记忆条数上限** | **120 条**，超了丢最早的 | `MAX_ENTRIES`，`memory-logic.mjs:162` |
| **单条记忆长度上限** | **240 字符** | `MAX_ENTRY`，`memory-logic.mjs:106` |
| **记忆注入** | **开** —— `{{cyrene_memory}}` 由 `persona.mjs` 每轮拼进正文 | `persona.mjs:176` |
| **修正注入** | **开** —— 同上（该文件为空时不贡献任何东西） | `persona.mjs:176` |
| **工具** | **7 个**：`remember` `forget` `forgotten` `restore` `correct` `uncorrect` + 官方 `tool-web` | `memory.mjs:224,251,297,325` / `corrections.mjs:109,137` / `dist/cordis.patch.yml` 里 `id: tool-web` |
| **文件系统 / Shell / 编辑器** | **关**（预设里根本没有这几行） | `dist/cordis.patch.yml` 的 `plugins:` 段 |
| **联网检索** | **开**，`fetch: true`，超时 60 s | `dist/cordis.patch.yml` 里 `id: tool-web` |
| **人设正文（Chat 模式）** | **开**，读 `dist/system-prompt.md` | `persona.mjs:83` |
| **配方错时** | **吵，不静默退回 Chat** —— 写 stderr 并顶上一段写明问题的正文 | `persona.mjs:189-196` |

### 数据落在哪

`$DSH_HOME` 默认是 `~/.dsh`（`process.env.DSH_HOME ?? join(os.homedir(), '.dsh')`）。

| 文件 | 内容 | 谁写它 | 出处 |
|---|---|---|---|
| `$DSH_HOME/cyrene-agent/memory.md` | **长期记忆**，一行一条 `- …`，纯文本可直接手改 | `remember` / `forget` / `restore` | `memory.mjs:42-45` |
| `$DSH_HOME/cyrene-agent/corrections.md` | **说话方式修正**，一行一条 | `correct` / `uncorrect` | `corrections.mjs:43-46` |
| `$DSH_HOME/cyrene-agent/memory-forgotten.md` | **忘掉的东西 + 当时的原因**（存档，**永不注入**） | `forget` 写入 / `restore` 取回 | `memory.mjs:54-57` |
| `<包目录>/data/logs/worldbook.jsonl` | **报账留痕**：每轮命中/送出/丢弃的条目 id（**不记对方说的话**，只记指纹） | 每次 `agent/pre-step` | `worldbook.mjs:103` |

**可覆盖的环境变量**：

| 变量 | 作用 |
|---|---|
| `DSH_HOME` | 换一个 DSH home（上面三个 md 都跟着走） |
| `DSH_WORLDBOOK_WINDOW_MS` | 去重窗长度（毫秒）。非正数或读不出数一律退回 2 分钟 |
| `DSH_WORLDBOOK_AUDIT` | 把留痕引到别的路径（测试用它，所以 `npm test` 不会往真账里掺假会话） |

### 仓库里、不在 `$DSH_HOME` 下的

| 路径 | 是什么 | 手改会怎样 |
|---|---|---|
| `worldbook/entries.yaml` | **设定库的源数据**，改这个 | 要跑 `node build.mjs` 才进 `dist/` |
| `worldbook/anchor.md` | **锚点正文**，每一轮逐字追加 | 同上，**改之前先想清楚** —— 它改的是她的语域 |
| `persona.yaml` / `dialogues.yaml` | 人设数据 | 要跑 `node build.mjs` |
| `persona-soul.md` | 人设正文（**来自 Cyrene-Agent，不是本项目的原创**） | 会被 `build.mjs` 拼进产物 |
| `dist/` | **构建产物，但必须入库** —— 运行时直接读它 | 手改会在下次构建被覆盖 |

---

## 许可

模板代码 MIT；人设文字与示例由你填写，版权归你。

**但 `persona-soul.md` 不是「你填写的」** —— 它来自 Cyrene-Agent
（MIT，Copyright (c) 2026 Playa），经 Cyrene-xl/DSH-Cyrene（MIT）收录，署名照原样保留，
见 [NOTICE.md](NOTICE.md)。

---

## 免责声明

- 本项目是**非官方粉丝作品**，与 **miHoYo / HoYoverse（米哈游）**、与 **DeepSeek** 官方
  **均无任何隶属、赞助或背书关系**。「昔涟」及《崩坏：星穹铁道》的角色、名称、剧情文本，
  版权归 **miHoYo / HoYoverse** 及其各自权利人所有。
- **本项目是提示词工程，不是模型微调。** 它不改动、也不分发任何模型权重。
- **`persona-soul.md` 与语料来自第三方**，各自的授权与出处见 [NOTICE.md](NOTICE.md)
  与 `LICENSES/`。文件头那份来源注释**照原样保留**，没有改动。
- **游戏台词语料仅供本机自用，不要公开分发。** 分享副本由
  `tools/make-share.mjs` 生成，它会排除 `corpus*` 与 `dist/`
  （`dist/` 被排除是因为构建会把记忆内联进 `SKILL.md`），**然后对导出物本身再跑一遍检查**。
- **记忆与修正文件里会有你聊出来的私人内容。** 它们在 `$DSH_HOME` 下，不在仓库里 ——
  但如果你把它们放进 `deploy/` 并提交，它们就进了版本历史。提交前看一眼
  `git status`。

