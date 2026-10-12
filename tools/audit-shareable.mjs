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
import { homedir } from 'node:os';
import { extname, join, relative } from 'node:path';

const ROOT = process.cwd();
const JSON_OUT = process.argv.includes('--json');

// ---- 本机身份，从环境推，不写死 -------------------------------------------
//
// 规则必须含有它要匹配的字符串 —— 这件事躲不掉。躲得掉的是**把那些字符串
// 写进源码**：写进去，这个工具自己就成了导出物里的一处命中（2026-10-10 实际发生过）。
// 从环境取，源码里就没有可洗的东西，而且换一台机器它认得那台机器。
const userName = () => process.env.USERNAME ?? process.env.USER ?? '';
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
const repoDirName = () => {
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
/**
 * 按本机那份 `memory.md` 现生成「私人记忆内容」的匹配模式。
 *
 * ## 为什么要现生成，而不是写死
 *
 * 这一条原来是一条**写死的正则，里面抄着那两行记忆的原文**。
 *
 * **那是把要防的东西抄进了检测器。** 而这个文件本身要发布出去 ——
 * 于是「防止记忆外泄的脚本」自己带着两行记忆。**补漏的动作本身成了漏。**
 *
 * ⚠️ 而 2026-10-12 又发现：**这段话本身仍然在引用那两行原文。**
 * 也就是说上面那句「补漏的动作本身成了漏」，在第一版修完之后**依然成立** ——
 * 只是这次漏在注释里而不是在代码里。
 *
 * **所以规矩是**：描述「在哪、什么类型、多少字」就够了，**一个字都不要复述**。
 * 这个文件自己就是那条规矩最早的反例，所以写在这里，让下一个改它的人看见。
 *
 * ## 换一台机器它会匹配不到，那是对的
 *
 * 别人那台没有这段记忆可漏。规则在这里的意义是「本机发出去会漏什么」，
 * 不是「任何机器都会漏这两句」。
 *
 * ## 没有 memory.md 时
 *
 * 返回一个**永不匹配**的模式，而不是抛。收件人那台本来就没有 memory.md。
 *
 * @returns {RegExp} 匹配本机任何一条记忆内容的模式。
 */
function memoryContentPattern() {
  const never = /(?!)/u;
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    const file = join(home, 'cyrene-agent', 'memory.md');
    if (!existsSync(file)) return never;
    const escaped = readFileSync(file, 'utf8')
      .replace(/\r\n?/gu, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim())
      // 太短的片段会在任何文档里误伤，只拿真正有信息量的。
      .filter((entry) => entry.length >= 8)
      .map((entry) => entry.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
    if (escaped.length === 0) return never;
    return new RegExp(escaped.join('|'), 'u');
  } catch {
    return never;
  }
}

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
    // ⚠️ **`github.com/<用户名>/` 后面那个不算泄漏 —— 那是仓库地址，本来就该有。**
    //
    // 2026-10-11 撞上的：Windows 用户名和 GitHub 用户名常常是同一个
    // （这台机器就是），于是这条规则把 `package.json` 里的 URL 全报成泄漏，
    // **而导出物本身是对的。** 一个会误报的检查会被关掉，关掉之后一条都拦不住 ——
    // 上面那条 `home-path` 的注释里写着同一句话。
    match: userName() === '' ? /$^/u : new RegExp(`(?<!github\\.com/)\\b${userName().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'iu'),
    why: 'Windows 用户名。'
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

  for (const rule of RULES) {
    if (rule.kind === 'path') {
      if (rule.match.test(rel)) {
        findings.push({ rule: rule.id, file: rel, advisory: rule.advisory === true, why: rule.why, sample: '' });
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
    findings.push({
      rule: rule.id,
      file: rel,
      line,
      advisory: rule.advisory === true,
      why: isFixture ? `${rule.why}（疑似测试夹具，核实后可在规则里加例外）` : rule.why,
      sample: hit[0].slice(0, 60)
    });
  }
}

// `advisory` 的那些**不拦人**：它们该被看到，但那个决定已经有人做过了。
const blocking = findings.filter((f) => f.advisory !== true);
const advisory = findings.filter((f) => f.advisory === true);

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
  `${advisory.length === 0 ? '' : `，另有 ${advisory.length} 处只是提醒`}。\n`);
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
  console.log('');
}

console.log(
  blocking.length === 0
    ? (advisory.length === 0
      ? '  没有发现不该外发的内容。\n'
      : `  没有拦人的问题。另有 ${advisory.length} 处提醒（素材不适用 MIT，见 NOTICE.md）。\n`)
    : '  以上都要在打包之前处理掉。\n'
);
process.exit(blocking.length === 0 ? 0 : 1);
