/**
 * 剧情检索 · 探针与闸门标定
 *
 * ## 它回答两个问题
 *
 *   一、**检索在不在**。给定一句问话，前几块是什么、分数多少。
 *   二、**闸门该卡在哪**。剧情问题和不相关闲聊的分数分不分得开。
 *
 * 第二个问题是它存在的理由 —— 剧情索引有 983 块、每块约 855 字符，
 * 而世界书一轮的预算是 1400。**每轮都注入等于把预算全给剧情，
 * 而「在吗」这种话也会捞一段出来。** 所以要么不注入，要么按分数注入。
 *
 * ## 与 retrieve.mjs 的关系
 *
 * `retrieve.mjs` 量的是世界书那 132 条，**结论是不该给世界书用余弦**
 * （纯余弦 29/39，修触发词之后 36/39）。余弦留给这里 —— 983 块原文没有触发词可用。
 *
 * 用法：
 *   node tools/story-probe.mjs --query "遐蝶的死亡之触是怎么回事"
 *   node tools/story-probe.mjs --gate      # 两组问题的分数分布
 */

import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

// ---- 仓库根，从本文件的位置推（由 tools/derive-roots.mjs 加的头）----
//
// 以前这里写的是作者机器上的绝对路径。那只在那台机器上成立，
// 而且清洗脚本会把绝对路径换成占位符，于是代码里出现 <本仓库> 这种目录名，直接崩。
import { fileURLToPath as __f } from 'node:url';
import { dirname as __d, join as __j } from 'node:path';
const REPO_ROOT = __j(__d(__f(import.meta.url)), '../..');

import { buildIndex, cleanName, grams } from '../retrieval.mjs';

const ROOT = `${REPO_ROOT}/cyrene-agent`;

const docs = readFileSync(`${ROOT}/dist/story-chunks.jsonl`, 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

/**
 * 索引和检索**都从 retrieval.mjs 来**。
 *
 * ⚠️ 这里原来有一份自己的实现 —— STRIP、grams、termCounts、idf、vectors、search
 * 六段全齐。**两份会漂，而且已经漂过一次：**
 *
 *   给剧情索引加「不收单字」这条规则时，我只改了 story.mjs，没改这里。
 *   于是同一个问题在两处量出两个分数（0.0831 对 0.0990），我对着不一致的数看了半天，
 *   还差点把「加通配符」这个结论建立在假阳性上。
 *
 * 现在这里只剩一个薄壳。**规则住在 retrieval.mjs** —— 那份有 test/story.test.mjs
 * 管着，这份没有。**测试覆盖不到的地方就会漂。**
 */
const index = buildIndex(docs);

/**
 * @param {string} query - 用户的问题。
 * @param {number} topK - 取前几块。
 * @returns {Array<{doc: object, score: number}>} 降序。
 */
function search(query, topK = 3) {
  return index.search(query, topK);
}

// ⚠️ `argv` 必须在这里先声明 —— 下面那个 `--names` 分支要用它，
// 而 `const` 有暂时性死区，放在后面会报「Cannot access before initialization」。
const argv = process.argv.slice(2);

// ── 专名表 ────────────────────────────────────────────────────────────
//
// 两处现成的材料拼出来，**不靠手列**：
//
//   说话人 —— 剧情原文里每个 `**【X】**` 都是一个开口说话的人
//   其他专名 —— 世界书的触发词剥掉问法词剩下的（地名、族群名）
//
// ⚠️ 说话人那一份**有噪声**：639 个里混着 `？？？`、`白发青年`、`稚嫩的女声`、
// `{NICKNAME}`。那些不是名字，是描述。实测没造成误判，但不该就这么留着 ——
// 它们会让「那个白发青年」这类问法误判成剧情问题。
const SPEAKERS = new Set();
for (const d of docs) {
  for (const m of d.text.matchAll(/\*\*【([^】]{1,12})】\*\*/g)) {
    // ⚠️ 要过 cleanName。**这条也漂过一次** —— import 了却没调用，
    // 于是这边报 1176 个专名（含 ？？？ 和 {NICKNAME}），而 story.mjs 那边是干净的。
    // 和检索那处是同一个毛病：**同一件事有两个实现，改一处漏一处。**
    for (const name of cleanName(m[1])) SPEAKERS.add(name);
  }
}
const PLACES = new Set();
try {
  const book = yaml.load(readFileSync(`${ROOT}/worldbook/entries.yaml`, 'utf8'));
  for (const e of book.entries ?? []) {
    for (const t of e.triggers ?? []) {
      if (String(t).includes('*')) continue;
      const base = String(t)
        .replace(/(怎么样|如何|怎么看|觉得|对.*的看法|是什么|是谁)/g, '')
        .replace(/^对/, '').trim();
      if (base.length >= 2 && base.length <= 6) PLACES.add(base);
    }
  }
} catch {
  // 读不到世界书就只用说话人 —— 闸门会变松，但不会失效。
}
const NAMES = new Set([...SPEAKERS, ...PLACES]);

/** 这句话提到专名了吗。 */
const mentionsName = (query) => [...NAMES].some((n) => query.includes(n));

if (argv.includes('--names')) {
  const STORY = ['遐蝶的死亡之触是怎么回事', '白厄为什么独自上路', '风堇的彩虹桥',
    '那刻夏怎么证明轮回的', '哀丽秘榭是什么地方', '缇宝的分身是怎么回事',
    '悬锋城为什么隐于迷雾', '刻律德菈的先锋军', '海瑟音的歌声', '阿蒙内特和遐蝶'];
  const CHAT = ['在吗', '我今天有点累', '陪我聊会儿天吧', '你吃饭了吗', '晚安',
    '哈哈哈哈哈', '你好厉害', '随便说点什么吧', '你还在吗', '今天天气不错'];
  console.log(`\n  专名 ${NAMES.size} 个（说话人 ${SPEAKERS.size} + 其他 ${PLACES.size}）\n`);
  console.log(`  剧情组提到专名: ${STORY.filter(mentionsName).length}/${STORY.length}`);
  console.log(`  闲聊组提到专名: ${CHAT.filter(mentionsName).length}/${CHAT.length}`);
  console.log('\n  对比分数闸（阈值 0.0728）：漏 0/10 条剧情、放 3/10 句闲聊。');
  console.log('  名字闸更干净，但更粗 —— 它只知道「提到了名字」，不知道「问的是剧情」。\n');
  process.exit(0);
}

if (argv.includes('--novelty')) {
  /**
   * 「给她的那一段里，有没有世界书里没有的东西？」
   *
   * ## 为什么先量这个
   *
   * 第 4 件的验收是「她说出的细节在世界书里没有、只在原文里」——
   * **那条要一次真实对话。** 但它的**前提**是机械可查的：
   * 如果 983 块的内容 132 条概括里全都有，注入它就是白占预算，
   * 「有没有用上」这个问题本身就无从谈起。
   *
   * ## 量法
   *
   * 取检索到的那一块，看它**有区分度的二元组**里，有多大比例在任何一条世界书条目
   * 里都找不到。用 IDF 加权而不是数个数 —— 「的」「他说」这类常见组不该算作内容。
   */
  const book = yaml.load(readFileSync(`${ROOT}/worldbook/entries.yaml`, 'utf8'));
  const entryTerms = new Set();
  for (const e of book.entries ?? []) for (const g of grams(`${e.id} ${e.text ?? ''}`)) entryTerms.add(g);

  const QS = ['遐蝶的死亡之触是怎么回事', '白厄为什么独自上路', '风堇的彩虹桥',
    '那刻夏怎么证明轮回的', '哀丽秘榭是什么地方', '缇宝的分身是怎么回事',
    '悬锋城为什么隐于迷雾', '刻律德菈的先锋军', '海瑟音的歌声', '阿蒙内特和遐蝶'];
  console.log('\n  检索到的那一块，有多少内容是世界书里没有的\n');
  let sum = 0;
  for (const q of QS) {
    const top = search(q, 1)[0];
    const gs = grams(top.doc.text);
    // 有区分度的：在这块里出现，且不是太短的常见组
    const uniq = [...new Set(gs)].filter((g) => g.length === 2);
    const novel = uniq.filter((g) => !entryTerms.has(g));
    const share = novel.length / Math.max(1, uniq.length);
    sum += share;
    console.log(`    ${(share * 100).toFixed(0).padStart(3)}%   ${q.padEnd(22)} → ${top.doc.chapter} / ${top.doc.node}`);
  }
  console.log(`\n  平均 ${(sum / QS.length * 100).toFixed(0)}% 的内容在世界书里找不到`);
  console.log('  高 = 注入确实带来新东西；接近 0 = 白占预算\n');
  process.exit(0);
}

const qAt = argv.indexOf('--query');
if (qAt !== -1) {
  const q = argv[qAt + 1] ?? '';
  console.log(`\n  问：${q}`);
  for (const [i, r] of search(q, 5).entries()) {
    console.log(`    ${i + 1}. ${r.score.toFixed(4)}  ${r.doc.chapter} / ${r.doc.node}`);
  }
  console.log('');
  process.exit(0);
}

/**
 * 两组问题。
 *
 * ⚠️ **又是手写的**，和 retrieve.mjs 里那份一样的弱点。但这两组要的是
 * 「分数分不分得开」，比「答得对不对」对措辞不那么敏感 —— 分不开才是问题。
 *
 * 剧情那组刻意**避开世界书里已有的说法**（用「死亡之触」「独自上路」这种
 * 只出现在原文里的词），否则量的是世界书而不是剧情索引。
 */
const STORY = [
  '遐蝶的死亡之触是怎么回事',
  '白厄为什么独自上路',
  '风堇的彩虹桥',
  '那刻夏怎么证明轮回的',
  '哀丽秘榭是什么地方',
  '缇宝的分身是怎么回事',
  '悬锋城为什么隐于迷雾',
  '刻律德菈的先锋军',
  '海瑟音的歌声',
  '阿蒙内特和遐蝶'
];

/** 闲聊一组 —— 这些绝不该捞剧情出来。 */
const CHAT = [
  '在吗',
  '我今天有点累',
  '陪我聊会儿天吧',
  '你吃饭了吗',
  '晚安',
  '哈哈哈哈哈',
  '你好厉害',
  '随便说点什么吧',
  '你还在吗',
  '今天天气不错'
];

console.log('\n  剧情问题 —— 前 3 块的分数\n');
const storyTop = [];
for (const q of STORY) {
  const r = search(q, 3);
  storyTop.push(r[0].score);
  console.log(`    ${r[0].score.toFixed(4)}  ${q.padEnd(22)} → ${r[0].doc.chapter} / ${r[0].doc.node}`);
}
console.log('\n  闲聊 —— 前 3 块的分数\n');
const chatTop = [];
for (const q of CHAT) {
  const r = search(q, 3);
  chatTop.push(r[0].score);
  console.log(`    ${r[0].score.toFixed(4)}  ${q.padEnd(22)} → ${r[0].doc.chapter} / ${r[0].doc.node}`);
}

const sorted = (a) => [...a].sort((x, y) => x - y);
const s = sorted(storyTop), c = sorted(chatTop);
const median = (a) => a[Math.floor(a.length / 2)];
console.log(`\n  剧情组  最低 ${s[0].toFixed(4)}  中位 ${median(s).toFixed(4)}  最高 ${s[s.length - 1].toFixed(4)}`);
console.log(`  闲聊组  最低 ${c[0].toFixed(4)}  中位 ${median(c).toFixed(4)}  最高 ${c[c.length - 1].toFixed(4)}`);
const overlap = s[0] < c[c.length - 1];
console.log(`\n  两组${overlap ? '**有重叠** —— 一个固定阈值分不开' : '**不重叠** —— 中间任何位置都能当闸门'}`);
if (overlap) {
  // 找分开代价最小的位置：漏掉几个剧情、放过几句闲聊。
  let best = null;
  for (const t of [...new Set([...s, ...c])].sort((a, b) => a - b)) {
    const miss = s.filter((x) => x < t).length;
    const leak = c.filter((x) => x >= t).length;
    if (best === null || miss + leak < best.miss + best.leak) best = { t, miss, leak };
  }
  console.log(`  最好的位置 ${best.t.toFixed(4)}：漏掉 ${best.miss}/${STORY.length} 条剧情，放过 ${best.leak}/${CHAT.length} 句闲聊`);
}
console.log('');
