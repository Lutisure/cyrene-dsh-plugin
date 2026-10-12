/**
 * 检索 · 最小实现
 *
 * ## 为什么不是 fengjin-agent 那套
 *
 * 它那边是 323 KB 文档：切分、BM25 + 稠密双索引、RRF 融合、cross-encoder 重排。
 * **这里要检索的是 132 条短条目，挑三条。** 切分和重排两步根本用不上。
 *
 * ## 为什么先不做神经嵌入
 *
 * 先要一个**可比的基线**。如果简单的字面方法就够，「够」的判据应该是对着它，
 * 不是对着零 —— 否则会花大力气换来一个没必要的提升。
 *
 * 中文没有空格，所以用**字符二元组**当词。它有个正好需要的性质：
 * 「遐蝶后来怎么样了」和「遐蝶怎么样」共享「怎么」「么样」两个二元组 ——
 * 而现在的触发词是整串子串匹配，中间隔一个「后来」就断了。
 *
 * 用法：
 *   node tools/retrieve.mjs --query "遐蝶后来怎么样了"
 *   node tools/retrieve.mjs --selftest
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// ---- 仓库根，从本文件的位置推（由 tools/derive-roots.mjs 加的头）----
//
// 以前这里写的是作者机器上的绝对路径。那只在那台机器上成立，
// 而且清洗脚本会把绝对路径换成占位符，于是代码里出现 <本仓库> 这种目录名，直接崩。
import { fileURLToPath as __f } from 'node:url';
import { dirname as __d, join as __j } from 'node:path';
const REPO_ROOT = __j(__d(__f(import.meta.url)), '../..');

const ROOT = `${REPO_ROOT}/cyrene-agent`;

/** 中文里标点和其他符号不该进索引。 */
const STRIP = /[\s，。！？、；：「」『』（）()【】《》…—－\-~♪“”"'’‘]/g;

/**
 * 字符二元组。
 *
 * ⚠️ 单字也要留 —— 「花」这种一字条目在二元组里会消失。
 * 代价是短查询的噪声变大，但丢字比噪声难查得多。
 *
 * @param {string} text - 原文。
 * @returns {string[]} 二元组和单字。
 */
function grams(text) {
  const clean = String(text ?? '').replace(STRIP, '');
  const out = [];
  for (let i = 0; i < clean.length; i += 1) {
    out.push(clean[i]);
    if (i + 1 < clean.length) out.push(clean.slice(i, i + 2));
  }
  return out;
}

/** 词频表。 */
function termCounts(text) {
  const counts = new Map();
  for (const g of grams(text)) counts.set(g, (counts.get(g) ?? 0) + 1);
  return counts;
}

/**
 * 余弦相似度，带 IDF 加权。
 *
 * IDF 从**条目集合本身**算 —— 132 条足够估出哪些二元组是常见的（「的」「怎么」），
 * 不需要外部语料。
 */
function makeIndex(docs) {
  const docTerms = docs.map((d) => termCounts(`${d.id} ${d.text} ${(d.triggers ?? []).join(' ')}`));
  const df = new Map();
  for (const terms of docTerms) for (const g of terms.keys()) df.set(g, (df.get(g) ?? 0) + 1);
  const N = docs.length;
  const idf = (g) => Math.log((N + 1) / ((df.get(g) ?? 0) + 1)) + 1;

  const vectors = docTerms.map((terms) => {
    const vec = new Map();
    let norm = 0;
    for (const [g, c] of terms) {
      const w = (1 + Math.log(c)) * idf(g);
      vec.set(g, w);
      norm += w * w;
    }
    return { vec, norm: Math.sqrt(norm) || 1 };
  });

  return {
    /**
     * @param {string} query - 用户的问题。
     * @param {number} topK - 取前几条。
     * @returns {Array<{id: string, score: number}>} 按分数降序。
     */
    search(query, topK = 3) {
      const qc = termCounts(query);
      const qvec = new Map();
      let qnorm = 0;
      for (const [g, c] of qc) {
        // 查询里的二元组如果全库没有，idf 仍给一个下限 —— 否则新词会把向量归一化掉。
        const w = (1 + Math.log(c)) * (df.has(g) ? idf(g) : 1);
        qvec.set(g, w);
        qnorm += w * w;
      }
      qnorm = Math.sqrt(qnorm) || 1;
      const scored = vectors.map((d, i) => {
        let dot = 0;
        // 遍历短的那一侧。
        const [small, large] = qvec.size < d.vec.size ? [qvec, d.vec] : [d.vec, qvec];
        for (const [g, w] of small) {
          const other = large.get(g);
          if (other !== undefined) dot += w * other;
        }
        return { id: docs[i].id, score: dot / (qnorm * d.norm) };
      });
      return scored.sort((a, b) => b.score - a.score).slice(0, topK);
    }
  };
}

/**
 * 验收问法。
 *
 * ⚠️ **这份是手写的，不是从日志里捞的** —— 日志只记了命中了哪些 id，
 * **不记当时问的是什么**（字段只有 at/session/turn/hits/sent/dropped/chars）。
 * 所以「那 74 条能不能排进前三」原样跑不了，只能照着失败的样子造问法。
 *
 * 每条的写法刻意包含三种：**她现在能命中的**（对照）、**她命中不了的**（真问题）、
 * **完全换一种说法的**（看下限）。
 */
const CASES = [
  { want: 'view-castorice', q: '遐蝶怎么样' },
  { want: 'view-castorice', q: '你觉得遐蝶怎么样' },
  { want: 'view-castorice', q: '遐蝶后来怎么样了' },
  { want: 'view-castorice', q: '你对遐蝶是什么看法' },
  { want: 'view-anaxa', q: '那刻夏呢，你怎么看他' },
  { want: 'view-anaxa', q: '那刻夏是个什么样的人' },
  { want: 'view-hyacine', q: '风堇给你什么感觉' },
  { want: 'view-mydei', q: '万敌怎么样' },
  { want: 'view-mydei', q: '万敌这个人' },
  { want: 'view-aglaea', q: '阿格莱雅呢' },
  { want: 'view-cerydra', q: '刻律德菈怎么样' },
  { want: 'view-cipher', q: '赛飞儿呢' },
  { want: 'view-hysilens', q: '海瑟音怎么样' },
  { want: 'view-tribbie', q: '缇宝怎么样' },
  { want: 'view-danheng', q: '丹恒怎么样' },
  { want: 'view-march7th', q: '三月七怎么样' },
  { want: 'memory-tablets', q: '记忆石板是什么' },
  { want: 'memory-tablets', q: '那些石板' },
  { want: 'aedes-elysiae', q: '哀丽秘榭是什么地方' },
  { want: 'aedes-elysiae', q: '你家乡那个村子' },
  // ── 剩下那 9 条从没命中的（2026-10-11 补）────────────────────────────
  //
  // 头一批只覆盖了 14 条 view-*。日志里「从没命中」的是 23 条 —— 剩这 9 条
  // 原来一条都没测过。**没测过就没验过。**
  { want: 'music-motif', q: '你会唱歌吗' },
  { want: 'music-motif', q: '哼一段旋律给我听' },
  { want: 'reserved-now', q: '你以前不是这样的' },
  { want: 'which-self', q: '哪一个才是真正的你' },
  { want: 'afraid-to-trouble', q: '让你帮忙会不会添麻烦' },
  { want: 'how-she-tells-stories', q: '你讲故事的秘诀是什么' },
  { want: 'how-big-a-village-is', q: '你的村子有多大' },
  { want: 'sincerity-proves-itself', q: '怎么算真的' },
  // ── 从「命中过但一次没发出」那 51 条里抽几条 ───────────────────────
  //
  // 那 51 条的共同点是**触发词有效但 priority 太低，永远排不进前三**。
  // 它们不是触发词的问题，是排序的问题 —— 所以这批测的是「换个排法能不能露头」。
  { want: 'hyacine-people', q: '风堇怎么对待身边的人' },
  { want: 'castorice-cost', q: '遐蝶付出了什么代价' },
  { want: 'mydei-cost', q: '万敌失去了什么' },
  { want: 'anaxa-did', q: '那刻夏做了什么' },
  { want: 'tribbie-did', q: '缇宝做了什么' }
];

const book = JSON.parse(readFileSync(`${ROOT}/dist/worldbook.json`, 'utf8'));
const entries = book.entries ?? [];

/**
 * 触发词加成。
 *
 * ## 为什么是「叠」而不是「换」
 *
 * 纯余弦跑现有 39 条断言过 29 崩 10，而崩的两类**都不是相似度问题**：
 *
 *   一、事实 vs 看法。「白厄是谁」拿到 `view-phainon`，缺 `heir-phainon` ——
 *       而「她怎么看白厄」和「白厄是谁」字面上一样像。这一层世界书早分好了
 *       （`X-who` 对 `view-X`），**分它的是问法，不是相似度**。
 *   二、规则条目。`no-fabrication`、`goldens-roster` 不是内容，是策略 ——
 *       该被「问了哪一类」选中。
 *
 * 而余弦救的恰好是另一半：**触发词太窄**（十六条 `view-*` 就是「中间隔一个『后来』就断了」）。
 *
 * **两个短板刚好互补。** 所以：触发词命中的给一个大加成，余弦决定同档内部的顺序，
 * 触发词没命中的仍然能靠余弦挤进来 —— 但只有在命中池不够的时候。
 *
 * ⚠️ 加成必须**大于余弦的最大差**，否则等于没加。余弦落在 [0,1]，
 * 所以 1.0 就够把两档完全分开。
 */
const TRIGGER_BONUS = 1.0;

/** 触发词命中判定 —— 用世界书自己那套，不另写一份语义。 */
//
// ⚠️ 动态 import 在 Windows 上要 file:// 前缀。直接给 `F:/...` 会报
// ERR_UNSUPPORTED_ESM_URL_SCHEME —— 静态 import 没这个问题，动态的有。
const worldbookLogic = await import(pathToFileURL(`${ROOT}/worldbook-logic.mjs`).href);
const yaml = (await import('js-yaml')).default;
const built = worldbookLogic.buildWorldbook(yaml.load(readFileSync(`${ROOT}/worldbook/entries.yaml`, 'utf8')));
const normalized = new Map((built.entries ?? []).map((e) => [e.id, e]));

/**
 * @param {string} query - 用户的问题。
 * @returns {Set<string>} 触发词命中的条目 id。
 */
function firedIds(query) {
  const hay = worldbookLogic.normalise(query);
  const out = new Set();
  for (const [id, entry] of normalized) {
    // ⚠️ **没命中时 `firstHit` 返回 `-1`，不是 `null`。**
    //
    // 我第一版按 `!== null` 判断，于是 132 条全被标成「命中」，
    // 加成给了每一条 —— 排序退回纯余弦，而结果看起来只是「加成没用」。
    // 两处都是这一个错（另一处在通配符的可行性测试里）。
    //
    // **不知道一个函数失败时返回什么，就等于不知道它成功时返回什么。**
    if (worldbookLogic.firstHit(entry, hay) >= 0) out.add(id);
  }
  return out;
}

const index = makeIndex(entries);

/**
 * 叠起来排：触发词命中加成 + 余弦同档内排序。
 *
 * @param {string} query - 用户的问题。
 * @param {number} topK - 取前几条。
 * @returns {Array<{id: string, score: number, fired: boolean}>} 降序。
 */
function rank(query, topK = 3) {
  const fired = firedIds(query);
  return index.search(query, entries.length)
    .map((r) => ({ id: r.id, score: r.score + (fired.has(r.id) ? TRIGGER_BONUS : 0), fired: fired.has(r.id) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

const argv = process.argv.slice(2);
const qAt = argv.indexOf('--query');
if (qAt !== -1) {
  const q = argv[qAt + 1] ?? '';
  console.log(`\n  问：${q}`);
  for (const [i, r] of rank(q, 5).entries()) {
    console.log(`    ${i + 1}. ${r.score.toFixed(4)}  ${r.id}${r.fired ? '   ← 触发词命中' : ''}`);
  }
  console.log('');
  process.exit(0);
}

// ── 拿现有的 63 条断言量代价 ──────────────────────────────────────────
//
// **这一步不改任何生产代码。** 那些断言是照着触发词写的，余弦会打乱排序 ——
// 所以在把它接进管道之前，先知道有多少条会崩、崩在哪一类。
//
// 断言形状（eval/retrieval.yaml）：
//   injected:     {1: [id, id]}   第 1 轮应当注入这些
//   not_injected: {1: [id]}       第 1 轮不应当注入这个
//
// ⚠️ 只跑 `ask` 那一句，不模拟 `turns` 的多轮。所以多轮用例在这里是**近似** ——
// 它们真正测的是窗口去重，而余弦只决定排序。
if (argv.includes('--eval')) {
  const yaml = (await import('js-yaml')).default;
  const cases = yaml.load(readFileSync(`${ROOT}/eval/retrieval.yaml`, 'utf8'));
  let pass = 0;
  const fails = [];
  for (const c of cases) {
    // 多轮用例的 ask 可能是个数组或单句，统一取第一轮要问的那句。
    const asks = Array.isArray(c.ask) ? c.ask : [c.ask];
    const q = String(asks[0] ?? '');
    const got = rank(q, 3).map((r) => r.id);
    const need = Object.values(c.injected ?? {}).flat().filter((v, i, a) => a.indexOf(v) === i);
    const forbid = Object.values(c.not_injected ?? {}).flat().filter((v, i, a) => a.indexOf(v) === i);
    const missing = need.filter((id) => !got.includes(id));
    const leaked = forbid.filter((id) => got.includes(id));
    if (missing.length === 0 && leaked.length === 0) pass += 1;
    else fails.push({ name: c.name, q, got, missing, leaked });
  }
  console.log(`\n  现有断言 ${cases.length} 条，余弦排序过了 ${pass} 条、崩 ${fails.length} 条\n`);
  for (const f of fails.slice(0, 18)) {
    const why = [f.missing.length ? `缺 ${f.missing.join(',')}` : '', f.leaked.length ? `多 ${f.leaked.join(',')}` : ''].filter(Boolean).join('  ');
    console.log(`    ${f.q.padEnd(24)} ${why}`);
    console.log(`      拿到: ${f.got.join(', ')}`);
  }
  console.log('');
  process.exit(0);
}

// 自测：每条问法，目标条目排在第几
let hit1 = 0, hit3 = 0;
console.log(`\n  132 条，${CASES.length} 条问法\n`);
console.log('    排名  问的                                   要到       拿到');
console.log('    ' + '-'.repeat(78));
for (const c of CASES) {
  const got = rank(c.q, 3);
  // ⚠️ 这个局部变量**不能叫 `rank`** —— 那会在整个块里遮蔽外层的 `rank()`，
  // 于是上面那行调到的会是处于 TDZ 的同名 const，报
  // 「Cannot access 'rank' before initialization」。
  const where = got.findIndex((r) => r.id === c.want) + 1;
  if (where === 1) hit1 += 1;
  if (where >= 1) hit3 += 1;
  const mark = where === 0 ? '✗ 没进前三' : `第 ${where}`;
  console.log(`    ${mark.padStart(9)}  ${c.q.padEnd(36)}  ${c.want.padEnd(16)}  ${got[0]?.id ?? ''}`);
}
console.log(`\n  @1 ${hit1}/${CASES.length}   @3 ${hit3}/${CASES.length}\n`);
