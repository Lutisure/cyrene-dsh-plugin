# cyrene-guard · 写完代码之后自动扫一遍

一个 DeepSeek Harness 插件：**挂在文件写入事件上，把刚写下的文件读回来，用一套本地正则规则扫一遍，
把发现当作提示词里的一块交给模型自己看。** 除此之外它什么也不做。

规则来自 [Unclecheng-li/DeepSec](https://github.com/Unclecheng-li/DeepSec) 的 Shield（MIT）。

---

## ⚠️ 先说清楚：**它不是安全闸门**

**它拦不住任何东西。**

宿主 `dsh-tool-fs` 的写入路径是：

```js
const intent = await ctx.waterfall("fs/write-intent", target, exec, …);
outcome = await ctx.fs.writeText(target, input.content, intent, …);
ctx.emit("fs/observed", target, { kind: "present", version: outcome.version }, exec);
```

本插件挂在 **`fs/observed`** 上 —— 那是**写完之后**才触发的事件。文件已经落盘了，
它才把内容读回来扫。命中什么都不会阻止写入，也不会回滚、不会改文件、不会弹确认框。

> 上游那个看着像能拦的钩子也不能用：`fs/write-intent` 是 waterfall，但它**只拿到
> `(target, exec)`，拿不到要写的内容**。想「写之前检查内容」这条路根本走不通。
>
> 出处：`index.js:8-19`。

**真正的边界是权限范围和人工确认**，不是这个包。它能让一个错误在**同一轮对话里**被看见、
被改掉 —— 这就是它的全部价值，也是它唯一声称的东西。

一个叫 guard 的插件最容易被误会成闸门，所以这一节放在最前面。
同样的说明也写在 `index.js` 文件头（`index.js:27-30`）和 `cordis.patch.yml` 末尾
（`cordis.patch.yml:22-26`）—— 三处都说，是因为它值得说三遍。

---

## 目录结构

```
cyrene-guard/
  index.js              宿主半体：挂在 fs/observed 上，读回文件，记进 ledger，注册提示词 section
  scanner.mjs           规则引擎：38 条规则 + 注释/字符串遮罩 + 严重度排序
  packages.mjs          两张包名种子表（KNOWN 103 条 / HALLUCINATED 25 条，5 个 registry）
                        ⚠️ 由 tools/gen-packages.mjs 生成，不要手改
  packages-scan.mjs     从源码或依赖清单里抓出包名；seedLookup 离线判一次
  cordis.patch.yml      bundle 补丁：一个 insert(id/name)，让 `dsh plugin add` 能挂上
  dsh.plugin.json       插件元数据，声明 contributes.hooks = ["fs/observed"]
  test/
    scanner.test.mjs    19 项：规则命中、遮罩语义、语言门控、假阳性防线
    packages.test.mjs   11 项：包名抽取、三态判定、Go module 转义
    skip-report.test.mjs 5 项：「扫过没问题」和「根本没扫」在报告上必须分得开
  tools/
    gen-packages.mjs    从抽取出的规则文件生成 packages.mjs
    preflight.mjs       把 apply() 在一个假宿主上真跑一遍（防「挂载时抛 → DSH 起不来」）
```

---

## 它做什么：三件事

### 1. 挂在 `fs/observed` 上，写完就看一眼

每一次写入 / 编辑之后触发一次。读回来、扫一遍、记进 ledger。

### 2. 把发现渲染成提示词里的一块

用 `ctx.systemPrompt.section({ name: 'cyrene-guard/scan', order: 9500, text: () => ledger.render() })`
注册 —— **同名即替换**，永远只有一块。

`order: 9500` 落在工具说明之后、`STRUCTURED_OUTPUT`（9900）之前：报的是她刚做的事，
放在她准备继续做事的位置。（顺序必须自己给数：`getSectionOrder(name)` 只认内核注册过的名字，
而 `section()` 见到非有限数会直接抛 —— `index.js:224-227`。）

块长这样：

```
【安全扫描 —— 你刚写下的文件里有这些，请自己看一眼再往下走】

src/app.js
  · 第 12 行「AKIA…CDEF」— 代码里有一个 AWS 访问密钥。
    把密钥移到环境变量或凭据文件，并立刻轮换这一个 —— 它已经进过上下文了。

这是本地正则扫描，**不是安全边界**：它按公开样本里的写法匹配，换个说法就漏，
也分不出这段代码到底会不会被跑到。判断权在你。
```

**没有发现时它返回空字符串**，提示词里不会多出任何东西 —— 不每轮塞一段「一切正常」的废话
（`index.js:118-119`，`tools/preflight.mjs:77` 有断言）。

密钥本体不进提示词：命中 `secret` 类规则的证据会被截成**首尾各 4 位**（`index.js:434-436`）。

### 3. 读不回来不算错误

文件可能已经被删了，或者这个后端不支持读。扫描器出问题**绝不该影响正常的写文件流程**，
所以整个读回 + 扫描包在 `try/catch` 里，失败就安静返回（`index.js:206-209`）。

---

## 它扫什么

**后缀白名单**（`index.js:55-61`）：

```
js  mjs  cjs  ts  tsx  jsx  py  java  kt  kts  go  rb  php  cs  rs
yml  yaml  json  toml  env  sh  ps1  txt
```

`.txt` 在里面是**专门为 `requirements.txt` 留的**——幻觉包名就落在那里，不白名单它就永远进不了清单检查。

**依赖清单另外识别**（`index.js:67`）：

```
package.json   package-lock.json   requirements*.txt   pyproject.toml
Cargo.toml     go.mod              pom.xml
```

## 它**不**扫什么

| 不扫 | 为什么 |
|---|---|
| **`.md`** | 结构说明和文档里的示例代码会被规则误伤，而那**不是需要修的东西**。DeepSec 的扫描后缀表里也没有 `.md`，同样的理由（`index.js:52-54`） |
| `node_modules/` `.git/` `dist/` `build/` `out/` `coverage/` `.venv/` `venv/` `__pycache__/` | 它们不是这个人写的，报出来也没法改（`index.js:77-79`） |
| 超过 **512 KB** 的文件 | 源码不会到这个量级（`index.js:42-43`） |
| 后缀不在白名单里的文件 | —— |
| 路径为空的目标 | —— |

**而且它不联网。** 联网查询刻意不放在写文件这条路径上：写文件是高频动作，
不该顺带发起网络请求（`index.js:179-180`）。包名判定走的是**离线种子表**
（见下），未命中的一律是「不知道」。

---

## 规则从哪来

`Unclecheng-li/DeepSec` 的 **Shield**（MIT）。原版是 CI 里的扫描器：`action.yml` 22 KB、
要 `npm ci && npm run build`、要 GitHub token、报告打到 PR 评论和 SARIF 里。
这里只要一件事 —— **她写完代码之后，同一轮就知道自己写了什么**。
所以只取规则本身，不取那套装置（`scanner.mjs:8-12`）。

**没有取的部分**：`Spear`（攻击侧）全部、CI 装置、SaaS 集成、Web 面板（`NOTICE.md`）。

### 三处刻意偏离上游，三处都是修

上游的规则库里有两个会**导致误报**的问题。照抄会把误报一起抄进来，所以这里改了：

1. **`exec(` / `eval(` 用 Python 侧的模式。**
   `(?<![.\w])` 而不是 `\b` —— 后者在 `obj.eval(` 的点号后面也成立。
   而且**真的加了语言门控**：`eval(` 只报 JavaScript，`exec(` 只报 Python。
   上游的 TS 侧用的是 `\b` 且没有门控，它自己的源码注释把这一版叫做
   *"the single largest source of false positives in the whole ruleset"*。
   出处：`scanner.mjs:243-252`，`NOTICE.md`。

2. **声明了却没执行的语言门控，现在真的生效。**
   上游的 `aiPatterns.ts` 在 24 条规则上填了 `languages` 字段，而 `detectAiPatterns`
   **从来没读过它**。这里 `scanText` 会检查 `rule.langs`（`scanner.mjs:397`）。

3. **种子表从抽取出的规则生成，不是手抄。**
   128 个包名手抄一遍，错一个字符就得到一条**永远查不到**的规则。
   生成它的同一次抽取里，子代理在自检时抓出自己 4 处转写错误 —— 这正好证明了手抄不可靠。
   生成器是 `tools/gen-packages.mjs`（`packages.mjs:1-3`，`tools/gen-packages.mjs:4-7`）。

### 假阳性是怎么压下去的

这些规则能用的前提是**它们不乱报**，而误报的规则会被关掉 —— 关掉之后它一条都拦不住。
四层防线：

| 层 | 做法 | 出处 |
|---|---|---|
| **语言门控** | `eval(` 只报 JS，`exec(` / `pickle.loads` / `yaml.load` 只报 Python，`os.system` 只报 Python | `scanner.mjs:40-43` |
| **注释与字符串遮罩** | 返回等长字符串，注释和字符串字面量的位置上是空格。**两种模式**：SAST 规则连字符串一起遮（字符串不是代码），密钥规则只遮注释（值就住在字符串里）。一个遮罩服务不了两个问题 | `scanner.mjs:45-123` |
| **负向排除** | `dangerouslySetInnerHTML` 后面跟了 DOMPurify / sanitizeHtml 就不算；`process.env` 取值不算硬编码密钥；`yaml.load` 带了 `SafeLoader` 就不报 | `scanner.mjs:305, 138, 345` |
| **占位符过滤** | 值短于 6 字符、或含 `changeme` / `example` / `your` / `placeholder` / `${` 等词的，不算密钥。枚举这些词是必要的：`your-password-here` 又长又没有重复串，**熵检测抓不到它** | `scanner.mjs:126-149` |

高熵判定的阈值逐字抄自 DeepSec 的 `secrets.ts`：有上下文时长度 ≥16 且熵 ≥3.8；
无上下文 ≥24 且熵 ≥4.5；并且无论哪种都必须同时含字母和数字、不同字符占比 ≥0.45、
最长重复串 <8（后面两条挡掉 `aaaaaaaa…` 这类假高熵）。UUID 和纯 hex 校验和被排除。

### 38 条规则

| 组 | 条数 | 例子 |
|---|---|---|
| 硬编码密钥 | 7 | AWS 访问密钥、GitHub 令牌、Slack 令牌、OpenAI / Anthropic 密钥、npm 令牌、私钥块 |
| 变量名 + 字面量 | 1 | 叫 `api_key` / `password` / `token` 的变量被赋了字面量（走原文，并查占位符与环境变量引用） |
| 配置 | 5 | `DEBUG=true`、CORS 通配来源、`eval` / `exec`、`pickle.loads`、不带安全 Loader 的 `yaml.load` |
| AI 错误模式 | 14 | 默认口令、写死的 JWT 密钥、前端前缀的密钥变量、`algorithm: none`、关掉 TLS 校验、`Math.random()` 生成令牌、`shell: true`、f-string 拼 SQL、`dangerouslySetInnerHTML`、公开读写 ACL、MD5/SHA1 哈希口令…… |
| SAST | 7 | `os.system`、`shell=True`、路径穿越、SSRF、SQL 字符串拼接、不安全反序列化、异常细节外泄 |
| Agent 自身 | 3 | 提示词注入句式、模型能影响的输入直达命令执行、带凭据的外发请求 |

规则表在 `scanner.mjs:196-366`。每条 `pattern` 逐字来自 DeepSec，
`langs` 是语言门控（`null` = 不限），`skip` 是额外的负向排除。
发现按严重度（critical → high → medium → low）再按行号排序（`scanner.mjs:449`）。

---

## 幻觉包检查：「不知道」不等于「不存在」

这是 DeepSec 里最有价值、也最难替代的一件：**向量嵌入做不到，正则也做不到** ——
它需要一张「真实存在」的名单加上一个存在性查询。

AI 写的代码特别容易编出看起来合理的包名。这个名字一旦落到磁盘上，就是一个现成的抢注目标：
攻击者注册它、放上恶意代码，下次安装就跑起来了。DeepSec 管这个叫 **slopsquatting**
（`packages.mjs:8-16`）。

### 判定是**三个值**，不是一个

```js
'exists'   查到了
'missing'  确定不存在      ← 只有这个会变成发现
'unknown'  没查到 / 没查
```

**把 `unknown` 当成 `missing`，规则就变成一台误报机器。**
一次断网、一个新包，就能让整份依赖清单报成幻觉包 —— 而误报的规则会被关掉，
关掉之后它一条都拦不住（`index.js:174-180`）。

所以种子表**只记明确知道的两头**：`KNOWN`（103 条，确定存在）和
`HALLUCINATED`（25 条，确定是编出来的，附最接近的真实替代）。表外的名字一律 `unknown`
（`packages-scan.mjs:184-193`）。

### 联网那一半写了，但**没接在写文件路径上**

`verifyPackage()` 实现了完整的三态查询（只有 **404 才算不存在**，429 / 5xx / 超时 / DNS 失败
都返回 `unknown` 并且**不写缓存** —— 把瞬时网络失败写进缓存会让某个包在恢复连接后仍被错误地记成
不存在，`packages-scan.mjs:116-173`）。但它**不在 `fs/observed` 这条路上被调用**：
写文件是高频动作，不该顺带发起网络请求。

**所以实际运行的判定是纯离线的**：只有种子表里 25 条明确记着的名字会报出来。
这是有意的取舍，不是遗漏。

### 覆盖 5 个 registry

| registry | 已知 | 幻觉 | 查询地址（联网那一半用） |
|---|---|---|---|
| npm | 31 | 5 | `registry.npmjs.org/{name}` |
| pypi | 27 | 5 | `pypi.org/pypi/{name}/json` |
| cargo | 16 | 5 | `crates.io/api/v1/crates/{name}` |
| gomod | 14 | 5 | `proxy.golang.org/{name}/@latest` |
| maven | 15 | 5 | `search.maven.org/solrsearch/select…` |

合计 **103 + 25 = 128 条**。

Go module 路径按规范做大写转义（大写字母写成 `!` 加小写，`!` 本身写成 `!!`）。
漏了这条，凡是名字里带大写的 module 都会查不到 —— 而查不到会被当成「不存在」，
于是报出一个假的幻觉包（`packages.mjs:324-342`）。

---

## 接入即接受的行为边界

这一节是「你把它装进来，就等于接受了下面这些」。逐条都能在上面的代码里核到。

1. **它不阻止任何操作。** 不拦写入、不回滚、不改文件、不弹确认。
   它只往提示词里加一块文字。
2. **判断权在模型和用户。** 报告最后一行逐字写着「**判断权在你**」。
   插件不仲裁、不自动修、不标为「必须处理」。
3. **它读你写下的文件内容。** 每次 `fs/observed` 之后，命中的路径会被读回来
   （≤512 KB）。内容**不落盘、不外发**。
4. **提示词里的密钥是被脱敏的。** `secret` 类规则的证据截成首尾各 4 位，
   完整密钥不进上下文（`index.js:434-436`）。但**命中的事实**会进上下文。
5. **它不联网。** 运行路径上一次网络请求都没有。
6. **它不覆盖任何权限机制。** 权限范围与人工确认仍然是唯一的真边界（见开头）。
7. **扫描器出错不影响你的写入。** 读不回来、解析失败、规则抛错 —— 一律吞掉，只留一行 stderr。
8. **它不知道代码会不会被跑到。** 正则匹配的是写法，不是可达性。一句写着
   `eval(` 的**死代码**和一句真的会被执行的 `eval(` 长得一模一样。

---

## Known Limitations

直说做不到的事。

- **事后检，不是事前拦。** 文件已经落盘。要拦住它需要另一个钩子，而那个钩子拿不到写入内容。
- **换个说法就漏。** 它按公开样本里的写法做正则匹配，挡不住改写过的写法，
  更挡不住一句通顺的普通话。上游在同类分类器上写着的那句话同样适用于这里：
  *"without an OS sandbox this classifier **is** the router that decides what runs unattended."*
- **分不出可达性。** 见上。死代码、注释里的示例（已被遮罩挡掉大部分）、
  测试夹具都可能是命中的来源 —— 这个仓库自己的 `tools/preflight.mjs` 每次跑都会
  因为里面**故意**写着测试用的假密钥而被报 3 条，这是**预期行为**。
- **依赖检查不联网。** 只有种子表里的 25 个名字会报。表外的包一律 `unknown`，
  哪怕是刚被抢注的。`verifyPackage()` 写好了但没接在写文件路径上。
- **不扫 Markdown、不扫依赖目录、不扫构建产物。** 见「它不扫什么」。
- **一次只展开 12 条发现，一次会话只留 40 个文件。** 超出的部分会以
  「（另外还有 N 条没有列出来。）」收尾，但**不展开**。
- **规则覆盖率的上限就是那 38 条。** 没有语义分析、没有数据流分析、没有依赖版本漏洞库。
- **不判断严重度以外的东西。** 它不知道你这段代码是本地脚本还是对外服务。
- **上限之外，报告里会写出来。** 文件超 512 KB、读回来不是文本、读的时候抛了 ——
  这三种都会进报告里的一段「【有文件没能扫到 —— 不代表它们是干净的】」，
  带上路径和原因。**「扫过没发现问题」和「根本没扫」在报告上必须是两回事。**
  （2026-10-11 改的。原来这条写的是「都是安静跳过，不会有记录」——
  那是改动前的实情，也确实是个缺口。）
  **仍然不报的只有一种：按设计跳过的。** 白名单外的路径（`node_modules`、构建产物）
  属于刻意不看，每轮报一遍会把真正该看的挤掉。

---

## 安装

```powershell
# 加进一个 profile（本机 DSH 桌面版）
$env:ELECTRON_RUN_AS_NODE="1"
& "<DSH 安装目录>\DeepSeek Harness.exe" `
  "<DSH 安装目录>/resources/app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" `
  plugin --profile desktop add "link:<本仓库>\cyrene-guard"
```

或者用裸包名 `... plugin --profile desktop add cyrene-guard`（发到 registry 之后）。

> ⚠️ **装完要重启 DSH。** 插件**源码**是启动时读的 ——
> loader 用裸 `import()`，没有缓存击穿。宿主半体（`index.js`）的改动**不重启不生效**。
> 提示词那一块（section）每次装配时求值，但**它得先被挂上**，而挂载发生在启动。

**它挂在预设外面。** 见 `index.js:21-25`：记忆那几个插件挂在 `preset-cyrene` 里面，
因为它们的提示词要跟着人设走；这个插件的目的正相反 ——
**不管挂哪个预设、开哪个会话，它都该在。**

## 卸载

```powershell
$env:ELECTRON_RUN_AS_NODE="1"
& "<DSH 安装目录>\DeepSeek Harness.exe" `
  "<DSH 安装目录>/resources/app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" `
  plugin --profile desktop remove cyrene-guard
```

卸载后重启一次 DSH。**它不写任何持久状态** —— ledger 只在内存里，
40 条记录随进程消失，没有文件、没有目录、没有缓存要清。

---

## 默认值表

| 项 | 默认值 | 出处 |
|---|---|---|
| **装完是否生效** | 是，**无需配置** | 没有配置项 |
| **挂在哪** | `fs/observed`（宿主侧，预设之外） | `index.js:213` |
| **注入的宿主服务** | `['fs', 'systemPrompt']` | `index.js:40` |
| **提示词块名 / 位置** | `cyrene-guard/scan`，`order: 9500` | `index.js:229-231` |
| **没有发现时** | 贡献**空字符串** | `index.js:119` |
| **单文件扫描上限** | 512 KB（超出不读） | `index.js:43` |
| **一次会话保留的扫描记录** | 40 个路径（超了丢最旧的；同路径写一次覆盖一次） | `index.js:46, 102-105` |
| **报告里最多列几条发现** | 12 条 | `index.js:49` |
| **扫描后缀** | 23 个（见上，含 `.txt`） | `index.js:55-61` |
| **识别的依赖清单** | 7 种文件名模式 | `index.js:67` |
| **规则条数** | 38 条 | `scanner.mjs:196-366` |
| **种子表条数** | 128 条（103 已知 + 25 幻觉）× 5 registry | `packages.mjs` |
| **是否联网** | **否** | `index.js:179-180` |
| **数据落在哪** | **哪也不落** —— ledger 在内存，无持久化文件 | `index.js:90-106` |
| **读不回来时** | 安静返回，不影响写入流程 | `index.js:206-209` |

---

## 开发

```powershell
cd cyrene-guard
node --test                    # 35 项（scanner 19 + packages 11 + skip-report 5）
node tools/preflight.mjs       # 在假宿主上真跑一遍 apply()
```

`tools/preflight.mjs` 存在的理由：**光看配置文件能解析是不够的** ——
崩的那次也可能是插件在挂载时抛，而 DSH 的启动路径是「读 profile → 挂载每个插件」，
任一插件抛就是整个进程起不来。假宿主照着 `dsh-fs` 和 `dsh-system-prompt` 的真实用法搭，
连「`section()` 见到非有限 `order` 会抛」这一点都复刻了 ——
**一个只在宿主宽容时才工作的插件，不是一个能用的插件**（`tools/preflight.mjs:1-12, 49-53`）。

`packages.mjs` 是生成物。改种子表要改源文件后重跑 `node tools/gen-packages.mjs`，
**不要直接改它**。

---

## 许可

本插件的**引擎与适配部分是自己的代码，MIT**（见 [LICENSE](LICENSE)）。

**检测规则来自 Unclecheng-li/DeepSec 的 Shield（MIT）。**
从 TypeScript 移植到 JavaScript，并修了原版两处会导致误报的问题（`exec(` 的语言门控、
以及声明了但没执行的 `languages` 字段）。完整署名见 [NOTICE.md](NOTICE.md)，
仓库根目录的 [NOTICE.zh.md](../NOTICE.zh.md) 里有更完整的三方说明。
