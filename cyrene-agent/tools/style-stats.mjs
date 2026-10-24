/**
 * 文风基线：从游戏原文里量出来的分布，用来对照她的输出。
 *
 * ## 为什么基线必须是游戏原文
 *
 * CharacterEval 的「人格反测」之所以有说服力，是因为标准答案来自**第三方**
 * （personality-database 的 MBTI），不是他们自己标的。
 *
 * 文风这一层同理：说「她的话应当短一些」，凭什么？只能是**她真的这么说过**。
 * 所以基线取自 `cyrene-speaks-v3.txt` —— 她的 2,054 句，米哈游写的。
 *
 * ## 量什么
 *
 * CharacterEval 把「表达丰富度」列成一个维度但没有给出可算的定义。
 * 这里挑五个**能被机械数出来**的：
 *
 *   句长            中位数、≤12 字的占比
 *   ♪ 频率          每百句出现几次
 *   语气词          呀/啦/呢/吧/哦/吗/嘛 每百句几次
 *   省略号          每百句几次
 *   人家 : 我       比值
 *
 * ## 用法
 *
 *   node tools/style-stats.mjs                        # 打印基线
 *   node tools/style-stats.mjs --compare <文件>        # 和基线并排比
 *   node tools/style-stats.mjs --json
 */
import { readFileSync, existsSync } from 'node:fs';

// ---- 仓库根，从本文件的位置推（由 tools/derive-roots.mjs 加的头）----
//
// 以前这里写的是作者机器上的绝对路径。那只在那台机器上成立，
// 而且清洗脚本会把绝对路径换成占位符，于是代码里出现 <本仓库> 这种目录名，直接崩。
import { fileURLToPath as __f } from 'node:url';
import { dirname as __d, join as __j } from 'node:path';
const REPO_ROOT = __j(__d(__f(import.meta.url)), '../..');

const ROOT = `${REPO_ROOT}/cyrene-agent`;
const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const at = argv.indexOf('--compare');
const COMPARE = at === -1 ? null : argv[at + 1];

const BASELINE = `${ROOT}/corpus-raw/cyrene-speaks-v3.txt`;

/**
 * 三档基线。**不是挑一个当唯一标准，是并排摆出来。**
 *
 * 2026-10-11 对方指出来的：剧情里有些不是对开拓者说的（对别人、还有独白），
 * 语音是好感场合，短信是打字 —— **三档都是她，只是场合不同，各自都有意义。**
 *
 * 我原来的做法是拿剧情那一档当唯一基线，然后在脚注里写「语域不同本来就该有差别」。
 * 那句脚注每次都打印，我每次都读过去。**口号写在脚注里等于没写。**
 */
const REGISTERS = [
  { label: '剧情', file: `${ROOT}/corpus-raw/cyrene-speaks-v3.txt` },
  { label: '语音', file: `${ROOT}/corpus-raw/cyrene-voice.txt` },
  { label: '短信', file: `${ROOT}/corpus-src/message-conversations.md`, messages: true }
];

/**
 * 从短信语料里取她那一侧。
 *
 * 格式是 `**【昔涟】** ……`，只认这个前缀 —— 对面说的话也算进去的话，
 * 量出来的会变成「一场对话」，不是「她怎么打字」。
 */
function hersFromMessages(raw) {
  return raw
    .split('\n')
    .filter((line) => line.startsWith('**【昔涟】**'))
    .map((line) => line.replace(/^\*\*【昔涟】\*\*/, '').replace(/`\d+`/g, '').trim())
    .filter(Boolean)
    .join('\n');
}

function sentences(raw) {
  return raw
    .split('\n')
    .map((line) => line.replace(/^[^：]{0,12}：/, '').trim())   // 去掉「昔涟：」这类前缀
    .filter((line) => line.length > 0);
}

function metricsOf(lines) {
  const lengths = lines.map((s) => s.length).sort((a, b) => a - b);
  const per100 = (pattern) => (lines.filter((s) => pattern.test(s)).length / Math.max(1, lines.length)) * 100;
  const count = (pattern) => lines.reduce((sum, s) => sum + (s.match(pattern) ?? []).length, 0);
  const them = count(/人家/g);
  const me = count(/我/g);
  /** The n-th percentile of a sorted numeric list. */
  const pct = (list, at) => list.length === 0 ? 0 : list[Math.min(list.length - 1, Math.floor(list.length * at))];
  /** How often one specific word appears, as a share of sentences. */
  const share = (pattern) => per100(pattern);
  return {
    lines: lines.length,
    median: lengths[Math.floor(lengths.length / 2)] ?? 0,
    short: (lines.filter((s) => s.length <= 12).length / Math.max(1, lines.length)) * 100,
    note: per100(/♪/),
    particle: per100(/[呀啦呢吧哦嘛]/),
    ellipsis: per100(/…/),
    ratio: them + me === 0 ? 0 : them / (them + me),

    /* ---- added: the finer grain ----
     *
     * The five originals answer "how long" and "how decorated". They do not
     * answer what a sentence *ends on*, which is most of what a voice is. The
     * 「。」figure below is the one that surprised me: her lines almost never
     * close with a full stop, so a line that does reads as a report rather than
     * as speech — and reports are exactly what a technical answer drifts into.
     */
    p25: pct(lengths, 0.25),
    p75: pct(lengths, 0.75),
    p90: pct(lengths, 0.9),
    /** How the line closes. These five sum to roughly 100. */
    endFull: share(/。\s*$/),
    endQuestion: share(/[？?]\s*$/),
    endBang: share(/[！!]\s*$/),
    endOpen: share(/[^。！？?…\s]\s*$/),
    endEllipsis: share(/…\s*$/),
    /** Comma density: she runs clauses together instead of stopping them. */
    commas: lines.length === 0 ? 0 : count(/[，,]/g) / lines.length,
    /** Each particle on its own, so a total cannot hide a wrong mix. */
    pYa: share(/呀/),
    pLa: share(/啦/),
    pNe: share(/呢/),
    pBa: share(/吧/),
    pO: share(/哦/),
    pMa: share(/嘛/),
    pA: share(/啊/),
    /** Company words. She is rarely alone in a sentence. */
    we: share(/我们/),
    together: share(/一起/),
    /** Terms of address, which set the distance. */
    addressee: share(/开拓者/),
    /** The imagery soul.md lists, as one pool. */
    imagery: share(/花|种子|星|光|风|涟漪|海|明天|旅途|纸页|故事/)
  };
}

/**
 * 原始文本 → 指标。
 *
 * 句子怎么切只有 `sentences()` 一处，bootstrap 重抽的也是它切出来的那组句子：
 * 两处各切一遍的话，区间算的是另一批句子的分布，和表里的数对不上。
 */
function stats(raw) {
  return metricsOf(sentences(raw));
}

const base = stats(readFileSync(BASELINE, 'utf8'));
const rows = [
  ['— 长度 —', null, '', () => ''],
  ['句长中位数', 'median', '字', (v) => v.toFixed(0)],
  ['句长 25 分位', 'p25', '字', (v) => v.toFixed(0)],
  ['句长 75 分位', 'p75', '字', (v) => v.toFixed(0)],
  ['句长 90 分位', 'p90', '字', (v) => v.toFixed(0)],
  ['≤12 字的句子', 'short', '%', (v) => v.toFixed(0)],
  ['— 收尾 —', null, '', () => ''],
  ['以 … 收尾', 'endEllipsis', '%', (v) => v.toFixed(0)],
  ['以 ？ 收尾', 'endQuestion', '%', (v) => v.toFixed(0)],
  ['以 ！ 收尾', 'endBang', '%', (v) => v.toFixed(0)],
  ['以 。 收尾', 'endFull', '%', (v) => v.toFixed(0)],
  ['不收标点', 'endOpen', '%', (v) => v.toFixed(0)],
  ['— 节奏 —', null, '', () => ''],
  ['每句逗号数', 'commas', '个', (v) => v.toFixed(2)],
  ['带省略号的句子', 'ellipsis', '%', (v) => v.toFixed(0)],
  ['带 ♪ 的句子', 'note', '%', (v) => v.toFixed(0)],
  ['— 语气词分项 —', null, '', () => ''],
  ['呀', 'pYa', '%', (v) => v.toFixed(1)],
  ['啦', 'pLa', '%', (v) => v.toFixed(1)],
  ['呢', 'pNe', '%', (v) => v.toFixed(1)],
  ['吧', 'pBa', '%', (v) => v.toFixed(1)],
  ['哦', 'pO', '%', (v) => v.toFixed(1)],
  ['嘛', 'pMa', '%', (v) => v.toFixed(1)],
  ['啊', 'pA', '%', (v) => v.toFixed(1)],
  ['带语气词的句子', 'particle', '%', (v) => v.toFixed(0)],
  ['— 用词 —', null, '', () => ''],
  ['人家 占自称', 'ratio', '%', (v) => (v * 100).toFixed(0)],
  ['出现「我们」', 'we', '%', (v) => v.toFixed(0)],
  ['出现「一起」', 'together', '%', (v) => v.toFixed(0)],
  ['出现「开拓者」', 'addressee', '%', (v) => v.toFixed(0)],
  ['出现意象词', 'imagery', '%', (v) => v.toFixed(0)]
];

const other = COMPARE === null ? null : (existsSync(COMPARE) ? stats(readFileSync(COMPARE, 'utf8')) : null);

/**
 * 对照那一列的 bootstrap 95% 区间。
 *
 * 为什么要有它：对照文件常常只有十几句（`eval/samples/probe-answers.txt` 是 16 句）。
 * 十几句算出来的「带语气词的句子 87%」和基线的 71% 差 16 个点，读起来像个结论，
 * 其实换一组句子就能翻过来。区间是拿**句子**有放回地重抽一千次、每次重算这个
 * 指标、取 2.5% 与 97.5% 分位得到的。
 *
 * 区间跨过目标值的那一格标 `≈`：这一格看不出差别，不管两边的点估计差多少。
 */
const BOOT_ROUNDS = 1000;
/** 少于这么多句，整张对照表都只能当参考 —— 这是清单里提的百句下限。 */
const BOOT_MIN = 100;

function bootInterval(lines, key) {
  if (lines.length < 2) return null;
  const values = [];
  const pick = new Array(lines.length);
  for (let round = 0; round < BOOT_ROUNDS; round += 1) {
    for (let i = 0; i < lines.length; i += 1) pick[i] = lines[Math.floor(Math.random() * lines.length)];
    const value = metricsOf(pick)[key];
    if (typeof value === 'number') values.push(value);
  }
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const at = (q) => values[Math.min(values.length - 1, Math.floor(values.length * q))];
  return [at(0.025), at(0.975)];
}

const otherLines = COMPARE === null || !existsSync(COMPARE) ? [] : sentences(readFileSync(COMPARE, 'utf8'));
const otherCI = {};
for (const [, key] of rows) {
  if (key === null) continue;
  otherCI[key] = bootInterval(otherLines, key);
}

// 三档一起读。读不到的那一档给 null，表里显示「—」而不是 0 ——
// 「这一档没有」和「这一档量出来是零」是两件事。
const bands = REGISTERS.map((reg) => {
  try {
    const raw = readFileSync(reg.file, 'utf8');
    return { label: reg.label, data: stats(reg.messages ? hersFromMessages(raw) : raw) };
  } catch {
    return { label: reg.label, data: null };
  }
});

/**
 * 目标：三档平均。
 *
 * 对方 2026-10-11 提的：三档都有意义，那就平均。加成一列之后，「该往哪走」
 * 从一句聊天里的话变成每次都打印的东西 —— 写在聊天里它只是句话。
 *
 * ⚠️ **一处例外：`ellipsis` 不听平均，听短信那一档。**
 * 47 / 43 / 10 平均成 33 —— 而短信是唯一和聊天窗口**同格式**的一档（她也在打字）。
 * 33 是把剧情档的形状拉回来，**那正是我今天追错的那个数**。
 * 三档里有一档格式就对得上，这一档不该和另外两档等权。
 *
 * ⚠️ 这是**算术平均，不是加权**。剧情 2054 句、语音 49 句、短信 58 句 ——
 * 等于给那 49 句和 2054 句一样的权重。那是刻意的：按句数加权就绕回剧情档了。
 */
const AVERAGE_EXCEPTIONS = { ellipsis: '短信' };
const target = {};
for (const [, key] of rows) {
  if (key === null) continue;
  const pick = AVERAGE_EXCEPTIONS[key];
  if (pick !== undefined) {
    const band = bands.find((b) => b.label === pick);
    if (band !== undefined && band.data !== null) target[key] = band.data[key];
    continue;
  }
  const values = bands.map((b) => (b.data === null ? null : b.data[key])).filter((v) => typeof v === 'number');
  // 缺一档就不给目标 —— 宁可不给，也不要一个残缺的数冒充标准。
  if (values.length === bands.length) target[key] = values.reduce((sum, v) => sum + v, 0) / values.length;
}

if (AS_JSON) {
  console.log(JSON.stringify({
    registers: Object.fromEntries(bands.map((b) => [b.label, b.data])),
    target,
    compare: other,
    /** 对照文件的句子数 —— 太少的话 `compareCI` 比点估计更可信。 */
    compareLines: otherLines.length,
    /** 每个指标的 bootstrap 95% 区间：[lo, hi]。 */
    compareCI: other ? otherCI : null
  }, null, 1));
} else {
  const head = bands.map((b) => b.label.padStart(8)).join('');
  console.log(`\n  她的三档基线（游戏原文，不是我们写的）`);
  for (const b of bands) {
    console.log(`    ${b.label}  ${b.data ? `${b.data.lines} 句` : '读不到'}`);
  }
  console.log(`  目标：三档平均（省略号除外 —— 那一格按短信档）`);
  console.log(`  对照：${other ? `${COMPARE}（${other.lines} 句）` : '未提供（--compare <文件>）'}\n`);
  console.log(`    指标                ${head}${'目标'.padStart(8)}${other ? '      对照   95% 区间' : ''}`);
  for (const [label, key, unit, fmt] of rows) {
    // A section heading: `key` is null, and it only names the block below it.
    if (key === null) {
      console.log(`\n    ${label}`);
      continue;
    }
    const cells = bands.map((b) => {
      if (b.data === null) return '—'.padStart(8);
      return `${fmt(b.data[key])}${unit}`.padStart(8);
    }).join('');
    const aim = key in target ? `${fmt(target[key])}${unit}`.padStart(8) : '—'.padStart(8);
    const me = other ? `  ${`${fmt(other[key])}${unit}`.padStart(8)}` : '';
    let ci = '';
    if (other && otherCI[key]) {
      const [lo, hi] = otherCI[key];
      const spans = key in target && lo <= target[key] && target[key] <= hi;
      ci = `  ${`${fmt(lo)}–${fmt(hi)}`.padStart(11)}${spans ? ' ≈' : ''}`;
    }
    console.log(`    ${label.padEnd(18)}${cells}${aim}${me}${ci}`);
  }
  if (other && otherLines.length < BOOT_MIN) {
    console.log(`\n  ⚠️ 对照只有 ${otherLines.length} 句，少于 ${BOOT_MIN} 句 —— 这一列只能当参考，单格的差值不要当结论。`);
    console.log(`  「95% 区间」是句子级 bootstrap（${BOOT_ROUNDS} 次重抽）；标 ≈ 的那一格区间跨过了目标值，看不出差别。`);
  }
  console.log('\n  **三档的差别是场合，不是对错。** 剧情里有对开拓者的也有对别人的，');
  console.log('  语音是好感场合，短信是打字。聊天窗口该落在哪一格，三档都要看。');
  console.log('  这个表是拿来看的，不是拿来自动判的。\n');
}
