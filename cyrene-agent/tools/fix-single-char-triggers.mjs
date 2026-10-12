/**
 * 第 4 轮：去掉十个单字触发词。
 *
 * ## 问题
 *
 * 触发词匹配是**子串**（`indexOf`）。而中文里**一个汉字不是一个词** ——
 * 「信」在「相信 / 信任 / 信息 / 微信」里到处都是。
 *
 * 实测 14 个「那个字只是顺带出现」的问句，**11 个误命中**：
 *
 *     他信任人家吗        → letters        （信 = 信件）
 *     信息量好大          → letters
 *     人家担心你          → heart-pages    （心 = 担心）
 *     你心里怎么想        → heart-pages
 *     做梦也没想到        → self-oracle    （梦）
 *     他养了一条狗        → unfinished-self（狗）
 *     这首歌真好听        → music-motif
 *
 * ## 为什么伤害比「多注入一条」大
 *
 * 一轮的预算是 **3 条 / 1400 字**。误命中不只是加噪音 —— 它**挤掉该命中的那几条**。
 * 问「死亡的代价」时 `aglaea-late`（触发词「死」）占掉一个位置，
 * 真正该给的条目就进不来了。
 *
 * ## 判据
 *
 * 用语料词频量过：心 1243、死 703、信 575、花 217、歌 130、梦 122、牌 94、哼 89、狗 47、毛 26。
 * 但**词频不是判据** —— 「白厄」2281 次、「遐蝶」1583 次，那是合理的，因为语料本来就讲他们。
 *
 * 判据是**「一个汉字构不成一个词」**。所以十个全部换掉：能删的删（同类触发词已经覆盖），
 * 不能删的加长成两三个字。
 *
 * 这个脚本只在原文里换 `triggers:` 那一行，不做 YAML round-trip —— 后者会把
 * 折行、注释、引号风格全改掉，diff 就没法看了。
 */
import { readFileSync, writeFileSync } from 'node:fs';

// ---- 仓库根，从本文件的位置推（由 tools/derive-roots.mjs 加的头）----
//
// 以前这里写的是作者机器上的绝对路径。那只在那台机器上成立，
// 而且清洗脚本会把绝对路径换成占位符，于是代码里出现 <本仓库> 这种目录名，直接崩。
import { fileURLToPath as __f } from 'node:url';
import { dirname as __d, join as __j } from 'node:path';
const REPO_ROOT = __j(__d(__f(import.meta.url)), '../..');

const FILE = `${REPO_ROOT}/cyrene-agent/worldbook/entries.yaml`;

/**
 * id → 新的触发词列表。
 *
 * 每一条的理由写在旁边。删掉的那个字如果同类词已经覆盖，就直接删。
 */
const REPLACEMENTS = [
  // 已有 写信/卡片/传讯/留言/短信 五个具体词，「信」纯属多余。
  ['letters', ['写信', '卡片', '传讯', '留言', '短信', '信件']],
  // 八个品种名都在，「花」删掉即可。
  ['flowers', ['玫瑰', '百合', '满天星', '桔梗', '向日葵', '风铃草', '花束', '水晶玫瑰']],
  // 「梦」太泛（做梦也没想到）。这条讲的是梦里听见神谕，用「梦里」。
  ['self-oracle', ['神谕', '预言', '梦里', '梦见神谕']],
  // 「歌」是「德谬歌」的子串 —— 问德谬歌会带出音乐那条，今晚实测过。
  // 「哼」当成语气词也常见，改成「哼歌」。
  ['music-motif', ['唱歌', '旋律', '哼歌', '歌谱', '哼唱']],
  // 「狗」在「他养了一条狗」里会误触发。保留 宠物/小动物 就够。
  ['unfinished-self', ['你是谁', '你是什么', '迷迷是什么', '宠物', '小动物']],
  // 「毛」改成「毛茸茸」—— 正文里正是这个说法。
  ['mimiform', ['迷迷', '毛茸茸', '粉色', '小动物', '变回来']],
  // 神谕牌/抽牌/占卜 都在，「牌」单独一个字会命中「车牌/牌子」。
  ['oracle-cards', ['神谕牌', '占卜', '塔罗', '抽牌', '占卜全书']],
  // 「心」1243 次，是十个里最泛的。正文说的是「名为『心』的书页」，用「心的书页」。
  ['heart-pages', ['心的书页', '书页', '保存', '记住此刻', '写下来', '铭记此刻']],
  // 「死」703 次。这条讲的是她把自己的退场排进日程，用「之死/死亡」。
  ['aglaea-late', ['阿格莱雅', '金织', '退场', '侵晨', '哈托努斯', '死亡', '之死']]
];

let text = readFileSync(FILE, 'utf8');
const report = [];

/**
 * ⚠️ 这个文件是 **CRLF**（880 处），而第一版脚本里写的是 `\n` —— 于是每条都「找不到」。
 *
 * 更麻烦的是它**混着**：880 个 CRLF 加 45 个单独 LF，那 45 个是合并工具写出来的
 * （`merge-worldbook-split.mjs` 拼 `\n`）。所以这里不能假定只有一种，
 * 匹配用 `\r?\n`，写回时**保持原样** —— 编辑只替换单行内容，不动周围的行尾。
 */
const EOL = text.includes('\r\n') ? '\r\n' : '\n';

for (const [id, triggers] of REPLACEMENTS) {
  // 定位这一条：从 `- id: <id>` 开始，到下一个 `- id:` 之前。
  const head = new RegExp(`\\r?\\n  - id: ${id}\\r?\\n`);
  const match = head.exec(text);
  if (match === null) { report.push(`✗ ${id} 找不到`); continue; }
  const start = match.index;
  // ⚠️ 必须从**头部之后**开始找下一个条目。
  //
  // 第一版写的是 `text.slice(start + 1)` —— 而 `start` 落在 `\r` 上，加一就是那个
  // `\n`。因为模式里的 `\r?` 是可选的，它**匹配上了当前条目自己的换行**，
  // 于是 index 是 0、block 只有一个字符、里面当然没有 triggers 行。
  // 报错信息（「里没有单行 triggers」）指错了方向，查了三轮才看出是这里。
  const afterHead = start + match[0].length;
  const nextMatch = /\r?\n  - id: /.exec(text.slice(afterHead));
  const end = nextMatch === null ? text.length : afterHead + nextMatch.index;
  const block = text.slice(start, end);

  // ⚠️ `\r?$` 不能省。`.`
  // 不匹配 `\n` 但**匹配 `\r`**，所以在 CRLF 文件上 `\[.*\]$` 永远不成立 ——
  // 中间隔着那个 `\r`。第一版就是这么又栽了一次。
  const line = block.match(/^(\s+triggers: )\[.*\]\r?$/m);
  if (line === null) { report.push(`✗ ${id} 里没有单行 triggers`); continue; }

  const before = line[0].trim();
  const after = `${line[1]}[${triggers.join(', ')}]`;
  text = text.slice(0, start) + block.replace(line[0], after) + text.slice(end);
  report.push(`✓ ${id}\n      ${before}\n   →  ${after}`);
}

writeFileSync(FILE, text);
process.stdout.write(`\n  行尾：${EOL === '\r\n' ? 'CRLF' : 'LF'}\n`);
process.stdout.write(report.join('\n') + '\n\n');
process.stdout.write(`  共改 ${REPLACEMENTS.length} 条。下一步：node build.mjs && node tools/eval.mjs\n\n`);
