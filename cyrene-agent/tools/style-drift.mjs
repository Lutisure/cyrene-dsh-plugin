/**
 * 漂移：把一份会话按先后切成窗口，看她的文风往哪边走。
 *
 * ## 为什么要有这个工具
 *
 * 对方 2026-10-10 报的问题：「聊得够久的时候，她说话的方式渐渐脱离了昔涟。」
 *
 * 这不是感觉。文献里三条都对得上：
 *
 *   · Persistent Personas —— 100 轮后人设保真度下降，目标导向对话里更严重
 *   · ContextEcho —— 漂移跨厂商普遍存在；**压缩不能可靠地重置它**；
 *     「一次单发锚定」能把它拉回来
 *   · SPASM —— 多轮里会累积 persona drift、角色混淆，以及 **echoing**：
 *     一方逐渐模仿另一方的说话方式
 *
 * 前两条说的是「会漂」。第三条说的是「往哪漂」—— 而那是可以验的：
 * **如果她在往对方那边漂，那对方的文风窗口就应该是她窗口的终点。**
 * 所以这个工具同时量两个人的。
 *
 * ## 怎么切窗口
 *
 * 按**轮**等分，不按条数 —— 一轮可以有好几条发言，按条数切会把长的那些
 * 集中到某个窗口里，量出来的差可能只是「这几轮话多」。
 *
 * ## 读的时候要小心什么
 *
 * 窗口越小噪声越大。最后一个窗口只有十几条时，「比中位数短了 6 个字」这类
 * 结论撑不住。所以每个窗口都报条数，**条数少于 15 的两个窗口之间的差不要当结论**。
 *
 * 用法：
 *
 *   node tools/style-drift.mjs <会话.jsonl>             # 默认切 4 个窗口
 *   node tools/style-drift.mjs <会话.jsonl> --windows 3
 */

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const FILE = argv[0];
const at = argv.indexOf('--windows');
const WINDOWS = at === -1 ? 4 : Math.max(2, Number(argv[at + 1]) || 4);

if (!FILE) {
  console.log('用法：node tools/style-drift.mjs <会话.jsonl> [--windows 4]');
  process.exit(1);
}

/** 会话文件里两种发言人。她的是 assistant，对方的是 user。 */
const SPEAKERS = { her: 'assistant/message', him: 'user/message' };

/** 从一行记录里取正文。工具调用、思考、附件都不算说话。 */
function bodyOf(row) {
  const content = row?.data?.message?.content ?? row?.data?.content ?? [];
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

/**
 * 判断一行是不是「对方真的说了话」。
 *
 * 系统提示、注入的世界书、工具结果都会以 user 身份出现，那些不算他说的。
 * 所以只认 type 是 user/message 的。
 *
 * ⚠️ 位置用 `seq`，不用 `data.turn`。**`user/message` 没有 turn 字段**
 * （它的 data 只有 content/source/role/id），拿 turn 当刻度会让对方所有的话
 * 落进同一个桶里 —— 第一版就是这么错的，对方的窗口 1 有 55 条，其余三个是空的。
 * `seq` 是全文唯一的序号，两个 type 都有。
 */
function collect(rows, type) {
  const out = [];
  for (const row of rows) {
    if (row?.type !== type) continue;
    const text = bodyOf(row);
    if (!text) continue;
    // 注入的块（世界书、记忆、修正）会以特定标记开头，这里按标记剔掉。
    if (/^【(设定检索|你对对方|长期记忆|修正)/.test(text)) continue;
    out.push({ text, seq: Number(row?.seq ?? 0) });
  }
  return out;
}

/** 把发言按 seq 等分成窗口。 */
function split(items, count) {
  if (items.length === 0) return [];
  const marks = items.map((item) => item.seq);
  const low = Math.min(...marks);
  const high = Math.max(...marks);
  const span = Math.max(1, high - low + 1);
  const buckets = Array.from({ length: count }, () => []);
  for (const item of items) {
    const slot = Math.min(count - 1, Math.floor(((item.seq - low) / span) * count));
    buckets[slot].push(item);
  }
  return buckets;
}

/**
 * 一套文风指标。定义和 tools/style-stats.mjs 保持一致。
 *
 * 这里重复了一份而没有 import —— style-stats.mjs 是个脚本，导入它会直接执行
 * 并打印。真要抽公用的那天，该抽的是两处都要改的地方，不是在这里 import。
 */
function metrics(items) {
  const lines = items
    .flatMap((item) => item.text.split('\n'))
    .map((line) => line.trim())
    .filter(Boolean);
  const n = lines.length;
  if (n === 0) return null;
  const lengths = lines.map((line) => line.length).sort((a, b) => a - b);
  const share = (re) => (lines.filter((line) => re.test(line)).length / n) * 100;
  const count = (re) => lines.reduce((sum, line) => sum + (line.match(re) ?? []).length, 0);
  const them = count(/人家/g);
  const me = count(/我/g);
  return {
    turns: new Set(items.map((item) => item.seq)).size,
    speeches: items.length,
    lines: n,
    median: lengths[Math.floor(n / 2)],
    short: share(/^.{0,12}$/),
    particle: share(/[呀啦呢吧哦嘛]/),
    ellipsis: share(/…/),
    endEllipsis: share(/…\s*$/),
    endQuestion: share(/[？?]\s*$/),
    endFull: share(/。\s*$/),
    note: share(/♪/),
    we: share(/我们/),
    addressee: share(/开拓者/),
    ratio: them + me === 0 ? null : them / (them + me)
  };
}

const rows = readFileSync(FILE, 'utf8').split('\n').filter(Boolean)
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter(Boolean);

const her = collect(rows, SPEAKERS.her);
const him = collect(rows, SPEAKERS.him);

const ROWS = [
  ['发言条数', 'speeches', (v) => String(v)],
  ['句子数', 'lines', (v) => String(v)],
  ['句长中位数', 'median', (v) => v.toFixed(0)],
  ['≤12 字的句子', 'short', (v) => v.toFixed(0) + '%'],
  ['带语气词的句子', 'particle', (v) => v.toFixed(0) + '%'],
  ['带省略号的句子', 'ellipsis', (v) => v.toFixed(0) + '%'],
  ['以 … 收尾', 'endEllipsis', (v) => v.toFixed(0) + '%'],
  ['以 ？ 收尾', 'endQuestion', (v) => v.toFixed(0) + '%'],
  ['以 。 收尾', 'endFull', (v) => v.toFixed(0) + '%'],
  ['带 ♪ 的句子', 'note', (v) => v.toFixed(0) + '%'],
  ['出现「我们」', 'we', (v) => v.toFixed(0) + '%'],
  ['出现「开拓者」', 'addressee', (v) => v.toFixed(0) + '%'],
  ['人家 占自称', 'ratio', (v) => v === null ? '—' : (v * 100).toFixed(0) + '%']
];

/** 打印一个人的窗口表。 */
function table(label, items) {
  const buckets = split(items, WINDOWS);
  const cells = buckets.map((b) => metrics(b));
  console.log(`\n  ${label}（${items.length} 条）`);
  console.log('    ' + ''.padEnd(20) + cells.map((_, i) => ('窗口' + (i + 1)).padStart(9)).join(''));
  for (const [name, key, fmt] of ROWS) {
    const row = cells.map((cell) => cell === null ? '—' : fmt(cell[key]).padStart(9)).join('');
    console.log('    ' + name.padEnd(20) + row);
  }
  const thin = cells.filter((cell) => cell !== null && cell.lines < 15).length;
  if (thin > 0) console.log(`    ⚠️ ${thin} 个窗口的句子数少于 15，那几个窗口之间的差撑不住结论`);
}

console.log(`\n  文件：${FILE}`);
console.log(`  窗口：${WINDOWS} 个，按轮等分`);
table('她', her);
table('对方', him);

console.log('\n  读法：如果她的窗口是单调往对方那边走的（比如句长一路掉、语气词一路少），');
console.log('  那是 echoing；如果每一列都在乱跳，那只是噪声，别说成漂移。\n');
