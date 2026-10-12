/**
 * 剧情检索 · 验收
 *
 * ## 它判的是一句话
 *
 * > **她说出的细节，在世界书里没有、只在原文里。**
 *
 * 这是第 4 件的验收判据。`data/logs/story.jsonl` 能告诉人「哪一轮给了她哪一段」，
 * 但**对不上的是「她说的那句话是哪来的」** —— 而这句话是判据的全部。
 *
 * ## 判法
 *
 * 一次问一答，跑三步：
 *
 *   一、用问题去检索，拿到这一轮**本来会给她**的那一段
 *   二、算她回答里有多少词来自那一段
 *   三、**再从其中扣掉世界书里本来就有的词** —— 剩下的才是「只因原文而知道」的部分
 *
 * 第三步是关键。**她本来就知道很多事**（132 条概括），所以光算「回答和原文的重合」
 * 会把世界书能给的也算进去，那部分证明不了任何事。
 *
 * ## 它不能证明的事
 *
 * 它量的是**用词重合**，不是**她真的读懂了**。同义改写、意译、把一段话消化成一句，
 * 都会让重合变低而实际是用上了。**所以它是筛子不是判据** —— 它告诉人该细看哪几轮，
 * 最终那一句还得人读。
 *
 * 用法：
 *   node tools/story-check.mjs --ask "遐蝶的死亡之触是怎么回事" --answer "..."
 *   node tools/story-check.mjs --ask "..." --answer "..." --show
 */

import { readFileSync } from 'node:fs';

// ---- 仓库根，从本文件的位置推（由 tools/derive-roots.mjs 加的头）----
//
// 以前这里写的是作者机器上的绝对路径。那只在那台机器上成立，
// 而且清洗脚本会把绝对路径换成占位符，于是代码里出现 <本仓库> 这种目录名，直接崩。
import { fileURLToPath as __f } from 'node:url';
import { dirname as __d, join as __j } from 'node:path';
const REPO_ROOT = __j(__d(__f(import.meta.url)), '../..');

import yaml from 'js-yaml';

import { buildIndex, grams } from '../retrieval.mjs';

const ROOT = `${REPO_ROOT}/cyrene-agent`;

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] ?? null;
};

const ask = arg('--ask');
const answer = arg('--answer');
if (ask === null || answer === null) {
  console.log('\n  用法：--ask "问题" --answer "她的回答"  [--show]\n');
  process.exit(0);
}

// ── 原文那一段 ────────────────────────────────────────────────────────

const docs = readFileSync(`${ROOT}/dist/story-chunks.jsonl`, 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const index = buildIndex(docs);
const [top] = index.search(ask, 1);

// ── 世界书里本来就有的词 ──────────────────────────────────────────────

const book = yaml.load(readFileSync(`${ROOT}/worldbook/entries.yaml`, 'utf8'));
/** 132 条概括里出现过的二元组 —— 她本来就可能知道这些。 */
const known = new Set();
for (const e of book.entries ?? []) {
  for (const g of grams(`${e.id} ${e.text ?? ''}`)) known.add(g);
}

// ── 三步 ──────────────────────────────────────────────────────────────

/** 出现过的二元组（去重，因为比的是「用过没用过」不是「用了几次」）。 */
const uniq = (text) => new Set(grams(text).filter((g) => g.length === 2));

const passage = uniq(top.doc.text);
const reply = uniq(answer);
/** 回答里用到的、原文里也有的词。 */
const shared = [...passage].filter((g) => reply.has(g));
/** 其中**世界书里没有**的 —— 这一部分只能是从原文来的。 */
const onlyFromStory = shared.filter((g) => !known.has(g));

const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(0)}%`);

console.log('\n  这一轮本来会给她的一段\n');
console.log(`    ${top.doc.chapter} · ${top.doc.node}（${top.doc.nodeId}）   分数 ${top.score.toFixed(4)}\n`);

console.log('  三步\n');
console.log(`    一、回答用到了原文里的词        ${String(shared.length).padStart(4)} / ${passage.size}   ${pct(shared.length, passage.size)}`);
console.log(`    二、其中**世界书里没有**的         ${String(onlyFromStory.length).padStart(4)} / ${passage.size}   ${pct(onlyFromStory.length, passage.size)}`);
console.log(`    三、回答自己的词                 ${String(reply.size).padStart(4)}`);

const verdict = onlyFromStory.length === 0
  ? '回答里没有一个词是只能从原文来的 —— **这一条不能算证据。** 可能她答的是世界书里那层，'
  : `有 ${onlyFromStory.length} 个词只能从原文来 —— **这一轮值得细看。**`;
console.log(`\n  ${verdict}`);

if (onlyFromStory.length > 0) {
  console.log(`\n    那些词：${onlyFromStory.slice(0, 24).join('  ')}`);
}
console.log('\n  ⚠️ 量的是用词重合，不是「她读懂了」。意译和消化都会让重合变低而实际用上了。');
console.log('     所以它是筛子 —— 它说该看哪几轮，最终那一句还得人读。\n');

if (argv.includes('--show')) {
  console.log('  ── 原文那一段 ──\n');
  console.log(String(top.doc.text).split('\n').map((l) => `    ${l}`).join('\n'));
  console.log('\n  ── 她的回答 ──\n');
  console.log(String(answer).split('\n').map((l) => `    ${l}`).join('\n'));
  console.log('');
}
