/**
 * 「这份仓库现在发出去，会漏什么」检查。
 *
 * 目标不是找漏洞，是找**不该离开这台机器的东西**。分四类：
 *
 *   1. 私人状态 —— 记忆、修正、会话状态。别人拿去用应该是**空白的自己**。
 *   2. 身份信息 —— 绝对路径、用户名、主目录。泄露的是「这是谁的机器」。
 *   3. 凭据 —— 密钥、令牌。
 *   4. 无权分发的内容 —— 游戏素材、他人的代码。
 *
 * 用法：
 *   node tools/audit-shareable.mjs            # 扫整个仓库
 *   node tools/audit-shareable.mjs --json     # 机器可读
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { extname, join, relative } from 'node:path';

import { memoryContentPattern } from './memory-pattern.mjs';

const ROOT = process.cwd();
const JSON_OUT = process.argv.includes('--json');

// ---- 本机身份，从环境推，不写死 -------------------------------------------
//
// 规则必须含有它要匹配的字符串 —— 这件事躲不掉。躲得掉的是**把那些字符串
// 写进源码**：写进去，这个工具自己就成了导出物里的一处命中（2026-10-10 实际发生过）。
// 从环境取，源码里就没有可洗的东西，而且换一台机器它认得那台机器。
const userName = () => process.env.USERNAME ?? process.env.USER ?? '';
/** 机器名。**「这是谁的机器」的正确判据是它，不是用户名** —— 见下面 `username` 那条规则。 */
const hostName = () => hostname();
/** 把一段字面量转义成能放进 `RegExp` 的形式。 */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * 机器名的匹配模式。
 *
 * **不只用全名。** Windows 的 NetBIOS 名是**大写且截断**的，`icacls` 之类的输出里
 * 印的就是那个形态（2026-10-12 实际撞上：全名 13 个字，注释里留下的是前 12 个）。
 * 只匹配 `os.hostname()` 会漏掉它。
 *
 * 所以把长度 ≥ 10 的前缀一并列进去。**再短的片段不行** —— 机器名里常常嵌着用户名，
 * 短到只剩用户名那一段就会在正常文字里误伤。
 */
const hostnamePattern = () => {
  const name = hostName();
  if (name === '') return /$^/u;
  const parts = [];
  for (let n = Math.min(10, name.length); n <= name.length; n += 1) parts.push(esc(name.slice(0, n)));
  return new RegExp(parts.join('|'), 'iu');
};
/** DSH 的安装目录名 —— 从 `DSH_ASAR` 推。 */
const installDirName = () => {
  // ⚠️ 一开始是从 `process.execPath` 推的，推出 `"Program Files"` —— 因为跑这个
  //    脚本的 node 是系统那个，不是 DSH 自带的。**用「当前进程在哪」去推
  //    「另一个程序装在哪」，前提就不成立。**
  //    `DSH_ASAR` 是这个仓库里已经在用的环境变量（`verify-real-prompt.mjs`），
  //    指向安装目录下的 app.asar —— 从它取盘符后的第一段才可靠。
  const asar = process.env.DSH_ASAR ?? '';
  const m = /^[A-Z]:[\\/]([^\\/]+)/u.exec(asar);
  return m === null ? '' : m[1];
};
/**
 * 仓库目录名。
 *
 * ⚠️ 2026-10-13：这个值取的是 `process.cwd()` 的末段。而 `make-share.mjs` 是把
 * 导出物拷到别处、**在导出目录里**跑这个脚本的 —— 那时 cwd 是导出目录，
 * 「源仓库叫什么」从根上取不到，`absolute-path` 这条规则于是在导出物上永远不匹配：
 * 同一份文本，在源目录里报 23 处，在导出目录里报 0 处。验导出物的意义就没了。
 *
 * `DSH_REPO_DIRNAME` 由调用方把源仓库名传进来，补上这一段。不设时行为不变。
 */
const repoDirName = () => {
  const fromEnv = process.env.DSH_REPO_DIRNAME ?? '';
  if (fromEnv !== '') return fromEnv;
  const m = /([^\\/]+)$/u.exec(ROOT);
  return m === null ? '' : m[1];
};

/** 不看这些目录：依赖、版本库、以及明确不外发的语料。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'dist-emotes-edit']);

/** 不扫这个文件本身：它的规则里写着要被找的字符串，扫自己必然自match。 */
const SELF = 'tools/audit-shareable.mjs';

/** 只看这些后缀。二进制靠下面的清单单独处理。 */
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.json', '.yml', '.yaml', '.md', '.txt',
  '.ps1', '.cmd', '.bat', '.py', '.html', '.css'
]);

/**
 * 规则。
 *
 * `why` 是给人看的 —— 一条检查说不出「为什么这算泄漏」，被报的人就只会把它当噪音。
 */
// 私人记忆的匹配模式**不在这里实现**。
//
// 它原来在这个文件里，是一条写死的正则 —— 里面抄着本机 `memory.md` 那两行的
// 原文。这个文件本身要发布出去，于是「防止记忆外泄的脚本」自己带着那两行：
// **补漏的动作本身成了漏**。第一版把它改成现读本机之后，那段**注释里**又
// 引用了一遍，等于同一个错犯了两次。
//
// 2026-10-12 发现 `tools/check-npm-publish.mjs` 里抄了**第三遍**（一并注释
// 写着「一个字都不要写全」）。规矩写在被违反的地方旁边是不够的 ——
// 所以它现在只有一份实现，在 tools/memory-pattern.mjs，那里记着完整来历。

// ---- 已知会被「发布 / 导出」那两条路处理掉的位置 -------------------------
//
// ⚠️ 这一块存在的理由和 `check-npm-publish.mjs` 里那条一模一样：
//    **检测器只知道「源码树里有这个东西」，不知道「出门之前会重建它」。**
//    于是每次跑都固定报「✗ 8 处要处理」—— 而跑的人两周之后就学会不看它了。
//
//    所以它们照样被列出来，但不拦人。前提是那两条路真的覆盖了它：
//      · `cyrene-agent/dist/` → `make-npm.mjs` 发布前用空记忆重建；`make-share.mjs` 不收
//      · `deploy/`            → 本机状态、被 `.gitignore` 挡住；`make-share.mjs` 不收
//
//    **加了新规则、或者改了那两条路的收件范围，这块要跟着重看。**
const PUBLISH_COVERED = [
  { prefix: 'cyrene-agent/dist/', why: '发布前由 make-npm.mjs 用空记忆重建；分享导出不收' },
  { prefix: 'deploy/', why: '本机状态、被 .gitignore 挡住；分享导出不收' }
];

const RULES = [
  // ---- 私人状态 --------------------------------------------------------
  {
    id: 'personal-memory',
    kind: 'path',
    match: /(?:^|[\\/])deploy[\\/]/u,
    why: 'deploy/ 是这台机器的运行状态：记忆、修正、主题状态、以及内联了这些的技能文件。别人拿去用应该是空白的。'
  },
  {
    id: 'personal-memory-content',
    kind: 'content',
    // ⚠️ **这里原来是硬编码的两句真话**（memory.md 里的原文）。
    //
    // 那是**把要防的东西抄进了检测器** —— 而这个文件本身要发布出去，
    // 于是「防止记忆外泄的脚本」自己带着两行记忆。**补漏的动作本身成了漏。**
    //
    // （改这一条时我把那两句抄进注释里解释了一遍 —— **同样的毛病换个位置又犯一次**。
    //   所以这条注释只描述、不引用。）
    //
    // 改成从本机那份 memory.md 现生成模式：
    //   · 本机有意义 —— 那才是要防的内容
    //   · 换一台机器就不匹配了，而那是**对的**：别人那台没有这段记忆可漏
    //   · 检测器里不再出现任何一句真话
    match: memoryContentPattern(),
    why: '这段文字是私人记忆的内容（模式按本机 memory.md 现生成）。'
  },

  // ---- 身份信息 --------------------------------------------------------
  //
  // ⚠️ 这几条**不写死作者的名字和目录**，改成从运行环境现取。
  //
  // 2026-10-10：原来这几条规则里直接写着要防的那些字面量。于是这个工具
  // **自己成了导出物里的一处命中** —— 清洗跑完之后，独立复查还能在
  // `tools/audit-shareable.mjs` 里找到用户名。
  //
  // 规则必须含有它要匹配的字符串，这件事本身躲不掉。躲得掉的是**把它写进源码** ——
  // 从 `process.env` 和 `DSH_ASAR` 取，源码里就没有可被洗的东西了。
  //
  // 附带的好处：这个工具换到一个用户名不同的机器上，仍然认得那台机器的名字。
  //
  // ⚠️ 而这一段的初版**又踩了一次同一个坑**：为了说明「别把要防的东西写进注释」，
  //    把那些字面量抄进了注释里。上一轮在 `make-share.mjs` 里刚犯过。
  //    **描述「在哪、什么类型」就够了，不要复述内容。**
  {
    id: 'absolute-path',
    kind: 'content',
    // 本机安装目录名从 execPath 推、仓库名从当前目录推，都不写死。
    match: new RegExp(`[A-Z]:[\\\\/](?:${[installDirName(), repoDirName()].filter(Boolean).map((n) => n.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})`, 'u'),
    why: '写死的绝对路径。换一台机器就失效，而且暴露了目录结构。'
  },
  {
    id: 'username',
    kind: 'content',
    // ⚠️ **只在路径里算泄漏。**
    //
    // 2026-10-11 撞上的第一次：Windows 用户名和 GitHub 用户名常常是同一个
    // （这台机器就是），于是这条规则把 `package.json` 里的 URL 全报成泄漏，
    // **而导出物本身是对的。** 那次的修法是加了一条 `(?<!github\.com/)`。
    //
    // 2026-10-12 撞上的第二次：三个包加了 npm 作用域，`@lutisure/<包名>` 满地都是 ——
    // 这条规则报出 **22 处，全是身份位置**（npm 作用域、署名、`LICENSE` 抬头、仓库地址）。
    // 而**就在同一天早些时候，正是「把作用域洗掉」这一个动作**让包名与客户端 loader id
    // 分了家，产物谁 clone 谁崩。
    //
    // 判据因此换了个方向：**不看「这个词出现了吗」，看「它出现在什么位置上」。**
    //
    //   `C:\Users\<用户名>`、`/home/<用户名>`       路径段 —— 泄露「这是谁的机器」→ 报
    //   `@lutisure/cyrene-agent`                    npm 作用域，必须原样保留      → 不报
    //   `"name": "Lutisure"`、`Copyright … Lutisure` 署名                        → 不报
    //   `github.com/Lutisure/…`、`repos/Lutisure/…`  地址，本来就该有            → 不报
    //
    // 机器名另立了一条 `hostname` 规则：**「这是我的机器」的正确判据是机器名。**
    // 用户名在这台机器上同时是三种身份，单靠它区分不了这两件事。
    //
    // 一个会误报的检查会被关掉，关掉之后一条都拦不住 —— 上面那条 `home-path`
    // 的注释里写着同一句话。
    match: userName() === '' ? /$^/u
      : new RegExp(`(?<=[\\\\/])(?<!github\\.com/)(?<!repos/)${esc(userName())}(?!\\w)`, 'iu'),
    why: '路径里写死的 Windows 用户名。'
  },
  {
    id: 'hostname',
    kind: 'content',
    // 「这台机器是谁的」—— 机器名直接回答这个问题，用户名回答不了（见上一条）。
    //
    // ⚠️ **这是一张网，不是一份证明。** Windows 在 `icacls` 这类输出里印的是
    //    NetBIOS 名，大小写可能不同、也可能被截断，`os.hostname()` 是匹配不全的。
    //    真正的修法是**别把机器名写进注释** —— 描述「那台机器的 NetBIOS 名」就够了。
    match: hostnamePattern(),
    why: '写死的机器名。'
  },
  {
    id: 'home-path',
    kind: 'content',
    // 排除已经脱敏的占位符。第一版把 `%USERPROFILE%` 报成泄漏，那是把「示例」当成
    // 「秘密」—— 而一个会误报的检查会被关掉，关掉之后一条都拦不住。
    match: /C:\\Users\\(?!(?:me|you|user|username|别人|某人|<[^>]+>|\$\{)[^\\\s"']*)[^\\\s"']+/u,
    why: '写死的主目录路径。'
  },

  // ---- 凭据 ------------------------------------------------------------
  {
    id: 'credential',
    kind: 'content',
    // 排除明显的夹具：全同一字符、递增字母表、以及测试文件。真的凭据不会是这些。
    // 报出夹具的代价是有人会去「修」一个不存在的问题，然后开始不信这份报告。
    match: /\bsk-(?!ant-)(?:proj-)?(?![a-z]{26}0-9)(?!a{20})[A-Za-z0-9_-]{32,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bnpm_[A-Za-z0-9]{36}\b/u,
    why: '看起来是真实凭据。'
  },

  // ---- 无权分发 --------------------------------------------------------
  //
  // ⚠️ 2026-10-11：这一条从「拦住」改成「记一笔」（`advisory`）。
  //
  // 他决定**把素材随包发出去** —— 原话「贴纸也要一起发，能让别人装上就能用」。
  // 理由站得住：装上之后没有小昔涟、没有人像、没有壁纸的主题不叫能用的主题。
  //
  // **但这条规则不该删。** 那个考虑是真的，只是决定变了：
  // 素材仍然不适用本项目的 MIT，仍然只该用于个人。
  // 所以它继续报出来，**但不再让导出失败** —— 该由人看一眼，而不是由脚本拦死。
  //
  // 配套改了 `NOTICE.md`：从「不包含素材」改成「包含，但不适用 MIT」。
  // **包里装着东西而声明说没有，那才是真问题。**
  {
    id: 'game-asset',
    kind: 'path',
    match: /\.(?:webp|png|jpe?g|gif|mp3|ogg|wav|m4a|flac)$/iu,
    advisory: true,
    why: '二进制素材。游戏美术与音频不适用本项目的 MIT 授权，仅供个人使用。'
  }
];

/** 递归收集文件。 */
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await walk(join(dir, entry.name))));
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const findings = [];
const files = await walk(ROOT);

for (const file of files) {
  const rel = relative(ROOT, file).replaceAll('\\', '/');
  const ext = extname(file).toLowerCase();
  if (rel === SELF) continue;

  // 按文件算一次就够了 —— 整条规则的值只取决于路径。
  // ⚠️ 这里原来是分开算的：内容规则算过，路径规则漏了。于是 `deploy/` 那五处
  //    永远进 blocking（它们**只**由路径规则命中），补了覆盖名单却一点没生效。
  //    教训：同一个概念在两处出现，就得在两处都接上 —— 或者只留一处。
  const covered = PUBLISH_COVERED.find((c) => rel.startsWith(c.prefix));

  for (const rule of RULES) {
    if (rule.kind === 'path') {
      if (rule.match.test(rel)) {
        findings.push({
          rule: rule.id, file: rel, line: 0, sample: '',
          advisory: rule.advisory === true || covered !== undefined,
          covered: covered?.why,
          why: rule.why
        });
      }
      continue;
    }
    if (!TEXT_EXT.has(ext)) continue;
    // 大文件跳过：50 KB 的技能文件扫起来慢，而且它已经在 personal-memory 那条里被覆盖。
    if (statSync(file).size > 512 * 1024) continue;

    const text = readFileSync(file, 'utf8');
    const hit = rule.match.exec(text);
    if (hit === null) continue;
    const line = text.slice(0, hit.index).split('\n').length;
    const isFixture = /test|spec|preflight|fixture/u.test(rel) && rule.id === 'credential';
    // 测试夹具不是泄漏。报它的代价是有人会去「修」一个不存在的问题 ——
    // 而一个会误报的检查会被忽略，然后真问题也跟着被忽略。
    if (isFixture) continue;

    // ⚠️ 2026-10-13：`absolute-path` 在**散文里**只作提醒，在代码里才拦人。
    //
    // 这条规则当初是为一场真事故立的：`check-grounding.mjs` 在别人机器上 ENOENT，
    // 因为源码里写死了 `<本仓库>`（见 `tools/derive-roots.mjs` 的注释）。
    // 那是**代码里**的路径 —— 该拦。
    //
    // 它同时也在二十几份文档、注释和 `.EXAMPLE` 块里命中。那些地方写的是
    // 「东西在这台机器的哪个盘上」，换台机器只是读起来不对，不会坏 ——
    // 何况仓库名本来就要公开（`github.com/<作者>/DSH_Plugins`）。
    // 拿二十几条这种东西去拦一次导出，代价是整条规则被关掉。
    const lineText = text.split('\n')[line - 1] ?? '';
    // ⚠️ PowerShell 的 `<# … #>` 块注释里也全是散文，而那些行自己不带标记 ——
    //    `.EXAMPLE` 里的示例路径就长这样（`pwsh D:\<仓库>\setup\install.ps1`）。
    //    数一下这行之前 `<#` 和 `#>` 各出现几次，多出来的就是还在块里。
    const upto = text.split('\n', line).join('\n');
    const inBlock = (upto.match(/<#/gu) ?? []).length > (upto.match(/#>/gu) ?? []).length;
    const inProse = rel.endsWith('.md') || inBlock || /^\s*(?:\/\/|#|rem\b|\*|<!--)/iu.test(lineText);
    const soft = rule.id === 'absolute-path' && inProse;

    findings.push({
      rule: rule.id,
      file: rel,
      line,
      advisory: rule.advisory === true || soft || covered !== undefined,
      covered: covered?.why,
      why: soft ? `${rule.why}（散文里只作提醒）` : rule.why,
      sample: hit[0].slice(0, 60)
    });
  }
}

// `advisory` 的那些**不拦人**：它们该被看到，但那个决定已经有人做过了。
const blocking = findings.filter((f) => f.advisory !== true);
const advisory = findings.filter((f) => f.advisory === true && f.covered === undefined);
const knownCovered = findings.filter((f) => f.covered !== undefined);

if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
  process.exit(blocking.length === 0 ? 0 : 1);
}

// ---- 报告 --------------------------------------------------------------
const byRule = new Map();
for (const f of findings) {
  if (!byRule.has(f.rule)) byRule.set(f.rule, []);
  byRule.get(f.rule).push(f);
}

console.log(`\n  扫了 ${files.length} 个文件，${blocking.length} 处需要处理` +
  `${advisory.length === 0 ? '' : `，另有 ${advisory.length} 处只是提醒`}` +
  `${knownCovered.length === 0 ? '' : `，${knownCovered.length} 处已知会被发布/导出那条路处理掉`}。\n`);
for (const [rule, list] of byRule) {
  const files = [...new Set(list.map((f) => f.file))];
  const mark = list[0].advisory === true ? 'ℹ️ ' : '⚠️ ';
  console.log(`  ${mark} ${rule}  —— ${list.length} 处，涉及 ${files.length} 个文件`);
  console.log(`      ${list[0].why}`);
  for (const f of files.slice(0, 5)) {
    const one = list.find((x) => x.file === f);
    console.log(`        ${f}${one.line ? `:${one.line}` : ''}${one.sample ? `   ${JSON.stringify(one.sample)}` : ''}`);
  }
  if (files.length > 5) console.log(`        …… 另外 ${files.length - 5} 个`);
  if (list[0].covered !== undefined) console.log(`        ↳ 已知覆盖：${list[0].covered}`);
  console.log('');
}

console.log(
  blocking.length === 0
    ? [
      '  没有拦人的问题。',
      knownCovered.length === 0
        ? ''
        : `  ${knownCovered.length} 处落在 dist / deploy 里 —— 发布前会重建或排除，但改了那两条路要回来看。`,
      advisory.length === 0
        ? ''
        : `  ${advisory.length} 处是素材与散文里的路径（素材不适用 MIT，见 NOTICE.md）。`,
      ''
    ].filter((l) => l !== '').join('\n') + '\n'
    : '  以上都要在打包之前处理掉。\n'
);
process.exit(blocking.length === 0 ? 0 : 1);
