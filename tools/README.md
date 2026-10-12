# tools —— 仓库自带的小工具

这些不是插件的一部分，是**维护这个仓库**用的脚本。

## 会话日志三件套

上一段工作时发生的事，只存在于会话日志里。而会话日志很大 —— 2026-10-10 那次导出的主日志
是 **75.9 MB / 21,118 条**。直接读它等于把上下文烧光。

**先记住两种形态，同一个会话同一个文件：**

| 形态 | 路径 | 谁给的 |
|---|---|---|
| 明文 `.jsonl` | 导出 zip 里的 `session.v4.jsonl` | 界面的「导出」 |
| 压缩 `.jsonl.zstd` | `~/.dsh/sessions/--<工作区>--/<会话 id>/` | 磁盘上本来就有的，**更新** |

压缩那份**不用导出就能读**，而且比导出包更全 —— 导出的那一刻之后就没了。
三个脚本按内容自动分流，两种都能吃。

> ⚠️ **`.zstd` 不是单个帧，是几百个 zstd 帧首尾相接，而且不是一行一帧。**
> 同一个日志 379 个帧；前 288 字节的明文就跨了 5 个帧边界。
> Node 的 `zstdDecompressSync` 只解第一个帧，紧接着报 `ZSTD_error_prefix_unknown`
> —— 看着像文件坏了，其实是读法错了。帧边界也**不能靠扫魔数**（魔数可省略，
> 压缩数据里本来就可能出现那四个字节）。`session-log.mjs` 让 zstd 自己报 `bytesWritten`，
> 这是唯一准的算法。

| 脚本 | 干什么 | 什么时候用 |
|---|---|---|
| `session-tail.mjs <file> [n]` | 打印最后 n 条的**原始形状**（字段名、类型） | 第一次拿到一份没见过的日志，先看它长什么样 |
| `session-brief.mjs <file> [cap]` | 每条记录压成一行：`U<seq>` 是用户说了什么，`A<seq>` 是助手回了什么 | 要快速通读一整段工作 |
| `session-dump.mjs <file> [fromSeq] [toSeq]` | 按序号区间展开：用户原文、助手正文、工具调用与参数 | 要细看某一段 |

自检一句话 —— 想看一份日志有多少帧、多少行、尾巴干不干净：

```powershell
& $node -e "const m = await import('./tools/session-log.mjs'); console.log(await m.describeLog(process.argv[1]));" <file>
# { frames: 379, lines: 603, parseable: 603, restBytes: 0 }
#   行数对不上 parseable → 有坏行；restBytes 非 0 → 解不动了，那是真异常，不是文件结束
```

典型用法 —— 接着上一段工作干：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

# 1. 先看它是什么形状（两种形态同一个命令）
& $node tools/session-tail.mjs C:\path\to\session.v4.jsonl.zstd 5
& $node tools/session-tail.mjs C:\path\to\session.v4.jsonl 5

# 2. 把「人说的话」抽成一份小的，通读
& $node tools/session-brief.mjs C:\path\session.v4.jsonl 400 > brief.txt
#    然后只挑用户那一侧看：
Select-String -Path brief.txt -Pattern '^U\s+[^<]'

# 3. 定位到要细看的那一段，按序号展开
& $node tools/session-dump.mjs C:\path\session.v4.jsonl 20500 21118
```

⚠️ **导出包里那些 `sha256:...` 的媒体文件在 Windows 上解不开** —— 文件名里有冒号，
`Expand-Archive` 会中途失败并且只留下一半目录。只解 `.jsonl` 就够读了：

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead($zip)
foreach ($e in $z.Entries) {
  if ($e.FullName -notlike '*.jsonl') { continue }
  $target = Join-Path $dst $e.FullName
  New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $target, $true)
}
$z.Dispose()
```

## 发布与移植（2026-10-11 这一组）

把仓库变成「别人能装起来的东西」，以及**验证它真的能装起来**。

一条命令的起点是最后一个 —— **它是这一组的验收**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/test-fresh-install.ps1
```

它造一个空的 `DSH_HOME`，把**给朋友的那份导出物**装进去，然后检查装完什么样。

> ⚠️ **为什么测导出物而不是测仓库。** 本仓库有 `dist/`、`deploy/`、`node_modules`、
> 游戏素材 —— 收件人一个都没有。**从本仓库装能过，证明不了从导出物装能过。**
> 第一次跑它就抓出七个 bug（BOM、定型 JSON 对象、漏链一个包、BOM 被洗掉、
> 不装依赖、写死路径、修了一半的路径）。

| 脚本 | 干什么 | 什么时候用 |
|---|---|---|
| `test-fresh-install.ps1` | **干净机器装一遍**：导出 → 装 → build → 校验 | 每次改了 `setup/`、`package.json` 或 build 流程之后 |
| `test-profile-conflict.ps1` | profile 里已有同名包时（链接指向别处 / 真目录占名 / 不存在） | 改了链接那一段之后 |
| `make-share.mjs` | 生成**给朋友**的副本（源码，不含 dist/deploy/素材） | 要发给人之前 |
| `make-npm.mjs` | 生成**能发 npm** 的包 —— 用**空的 memory** 重建 `dist/` | 要 `npm publish` 之前 |
| `set-owner.mjs` | 把 `<用户名>` 换成真实 GitHub 用户名（4 个文件、20 处） | 仓库推上去、知道地址之后 |
| `derive-roots.mjs` | 把工具里写死的绝对路径换成从 `import.meta.url` 推 | 新写了工具、或在别的机器上跑崩了 |
| `add-bom.mjs` | 给 `.ps1` / `.cmd` / `.vbs` 补 UTF-8 BOM | **每次用 `edit` 改过 `.ps1` 之后** |
| `audit-git-history.mjs` | 扫**历史提交**里有没有该洗掉的东西 | 要开源之前 |

### `add-bom.mjs` —— 这不是洁癖，是必需的

**PowerShell 5.1 读 `.ps1` 时按 ANSI（本机 GBK）解，除非文件带 UTF-8 BOM。**
无 BOM 的中文会解出半个字节序列，**吃掉一个引号或括号，整个脚本起不来**。

而 `setup/install.cmd` 调的正是 `powershell`（5.1），不是 `pwsh` ——
**所以这不是「少数环境」的问题，是主路径。**

> ⚠️ **`edit` 工具会抹掉 BOM。** 它重写整个文件，写的是无 BOM 的 UTF-8。
> 所以每次改完 `.ps1` 都跑一次 `node tools/add-bom.mjs`。
> `--check` 只报不改，适合放进流程里。

### `derive-roots.mjs` —— 修了一半比没修更难发现

它修的是「工具里写死 `<本仓库>`」。**清洗脚本会把那种字面量换成 `<本仓库>`，
于是代码里出现一个叫 `<本仓库>` 的目录名，直接崩。**

它 2026-10-10 就写好了，但**只跑过当时那几个文件**。后来新加的工具里又有六个写死了路径 ——
而在干净机器上崩的那个 `check-entry-shape.mjs` 更典型：**文件头已经加了根目录推导、
注释里还写明了这个坑，而下面那行用法没跟着改。**

## 记忆激活（DMAE）

**给世界书加一维时间**：让「常被提起」和「久没提起」产生差别。
公式、闸门、三档状态、两种底座语义的取舍，都写在 `cyrene-agent/dmae.mjs` 的注释里。

| 文件 | 干什么 |
|---|---|
| [`cyrene-agent/dmae.mjs`](<../cyrene-agent/dmae.mjs>) | **引擎，纯函数，没有 I/O。** 涨落公式、两个闸门、唤醒、三档状态 |
| [`cyrene-agent/worldbook-activation.mjs`](<../cyrene-agent/worldbook-activation.mjs>) | **状态落盘**：读写、合并、轮号 |
| [`cyrene-agent/test/dmae.test.mjs`](<../cyrene-agent/test/dmae.test.mjs>) | 公式与状态的单测 |
| `cyrene-agent/tools/dmae-sim.mjs` | 模拟器：常提起 vs 久没提起 |
| `cyrene-agent/tools/dmae-baseline.mjs` | 注入行为的基线，改动前后逐条对照 |
| `cyrene-agent/tools/dmae-qna.mjs` | 带激活度的对答：拿真实问法跑，看注入结果差在哪 |
| `cyrene-agent/tools/dmae-floor-cost.mjs` | 两种底座语义各会让多少条长期在线 |

### 怎么用

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

& $node cyrene-agent/tools/dmae-sim.mjs                  # 四组对照曲线
& $node cyrene-agent/tools/dmae-sim.mjs --sweep          # 扫 decayAlpha，看敏感性
& $node cyrene-agent/tools/dmae-sim.mjs --real           # 真实 priority 分布映出来什么样
& $node cyrene-agent/tools/dmae-sim.mjs --floor          # 两种底座语义并排

& $node cyrene-agent/tools/dmae-qna.mjs --sweep          # 权重扫描
& $node cyrene-agent/tools/dmae-qna.mjs --weight 0.9     # 单档看细

# 取一份注入基线，之后改动和它比
& $node cyrene-agent/tools/dmae-baseline.mjs --save 基线.json
& $node cyrene-agent/tools/dmae-baseline.mjs --diff 基线.json
```

> ⚠️ **要存文件就用 `--save`，不要用 `>` 重定向。**
> PowerShell 5.1 的 `>` 默认写 UTF-16，回头 `--diff` 读它 `JSON.parse` 直接炸。
> **用 shell 重定向存机器要读的文件，等于把编码交给一个不关心它的东西决定。**

### 量参数时容易踩的两个坑

**度量太钝，会假装参数不敏感。**
`--sweep` 第一版只打「第几轮跌破」，结果 α 从 1.0 到 3.0 六倍的范围给出同一个答案。
不是参数不敏感 —— 是那个度量把「跨在第 3 轮和第 4 轮之间」抹成了整数。

**「量出来是 0」和「没量到」长得一模一样。**
`--floor-cost` 的正则漏了缩进，输出「抓到 0 条」——
而那个 0 差点被当成「两种语义没差别」的结论。**尤其当它正好支持你原本想说的话。**

## 其余的

| 脚本 | 干什么 |
|---|---|
| `check-sandbox-acl.mjs` | **开工前自检**：某个目录能不能当 `workspace-write` 工作区用。只读，判定 `READY` / `NEEDS-ACE` |
| `preflight-profile.mjs` | 装补丁前干跑一遍，确认 DSH 能组合起来 |
| `sync-desktop-patch.mjs` | 把补丁同步进桌面 profile |
| `audit-shareable.mjs` | 检查哪些内容可以分享出去（版权、私钥、本机路径） |
| `daily-digest.mjs` | 每天凌晨把前 24 小时的会话与提交整理成素材（有 `.cmd` 包装，走计划任务） |

### check-sandbox-acl.mjs —— 为什么值得先跑一下

Windows 上的 `workspace-write` 要往工作区目录的**安全描述符**上写东西，
其中 **Low 完整性标签在 SACL 里** —— 改 SACL 要的是 **`WRITE_OWNER`**，
而那不是 `Modify` 权限能覆盖的。于是「能读能写能删」的普通目录照样开不了工，
报 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(<目录>)`。

F 盘根没有当前用户的显式项，所以**这个盘上新建的目录全都缺这一项**。

```powershell
& $node tools/check-sandbox-acl.mjs <你要当工作区的目录>
#   READY       → 可以开工
#   NEEDS-ACE   → 它会把那条 icacls 修复命令原样打出来，人工跑
```

`<你要当工作区的目录>` 换成你自己的路径。**盘根没有当前用户的显式项时，那个盘上新建的目录都会缺这一项** —— 所以第一次用某个盘，先跑一次。

为什么会这样（Low 完整性标签在 SACL 里、而改 SACL 要的是 `WRITE_OWNER`），写在 `check-sandbox-acl.mjs` 的文件头。
