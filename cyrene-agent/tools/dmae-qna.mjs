/**
 * 带激活度的对答测试 —— 「打完之后她答得怎么样」。
 *
 * ## 它和 `dmae-baseline.mjs` 差在哪
 *
 * `dmae-baseline.mjs` 调 `explainEntries` **不传 `activations`** → 走纯 `priority` 排序。
 * 那量的是「**没开**的时候」，而今天填的 132 个 `intrinsicValue` **一个都测不到**。
 *
 * 这一个把 39 条问法当成**一场连续对话**：状态一轮一轮累积
 * （聊到的涨、没聊到的落），每轮用**当时**的激活度排序，记录注入了什么。
 *
 * **那才是真管线** —— 和 `worldbook.mjs` 里那条链是同一串调用：
 *
 *     load → activationsFor → explainEntries → stepAll → 下一轮
 *
 * ## 两种跑法
 *
 * 默认**并排跑两遍**：同一批问法、同一个次序，一遍带状态、一遍不带。
 * **差异就是「开了之后变了什么」** —— 而不是拿两个不同时间点比。
 *
 * ## ⚠️ 它不判断「变得对不对」
 *
 * 它只把差异摆出来。**「这条该不该换掉那条」是人的判断，不是脚本的。**
 *
 * 用法：
 *
 *     node tools/dmae-qna.mjs              并排跑，打差异
 *     node tools/dmae-qna.mjs --all        连没变的也打
 *     node tools/dmae-qna.mjs --save x.json  存下来（**UTF-8，别用 shell 重定向**）
 *     node tools/dmae-qna.mjs --sweep      扫一遍权重，每档打「几条变了」
 *     node tools/dmae-qna.mjs --weight 0.9 指定权重单跑一次
 *     node tools/dmae-qna.mjs --diff x.json  和之前存的那份比
 *
 * ⚠️ **`--save` 存下来的东西，要有 `--diff` 才用得上。**
 * 2026-10-11 我先加了 `--save`、过了一轮才发现没有比对方式 ——
 * **一个存了但读不回来的基线，和没存是一样的。**
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const logic = await import('../worldbook-logic.mjs');
const act = await import('../worldbook-activation.mjs');

const BOOK = new URL('../worldbook/entries.yaml', import.meta.url);
const CASES = new URL('../eval/retrieval.yaml', import.meta.url);

const SHOW_ALL = process.argv.includes('--all');
const SWEEP = process.argv.includes('--sweep');
const W_AT = process.argv.indexOf('--weight');
const WEIGHT = W_AT !== -1 ? Number(process.argv[W_AT + 1]) : null;
const SAVE_AT = process.argv.indexOf('--save');
const SAVE = SAVE_AT !== -1 ? process.argv[SAVE_AT + 1] : null;
const DIFF_AT = process.argv.indexOf('--diff');
const DIFF = DIFF_AT !== -1 ? process.argv[DIFF_AT + 1] : null;

const entries = logic.buildWorldbook(yaml.load(readFileSync(BOOK, 'utf8'))).entries;
const raw = yaml.load(readFileSync(CASES, 'utf8'));

/** 每一条用例问什么。`ask` 可能是数组，取第一条 —— 和基线工具保持一致。 */
const asks = raw.map((c) => {
  const list = Array.isArray(c.ask) ? c.ask : [c.ask];
  return { name: c.name ?? '', q: String(list[0] ?? '') };
}).filter((c) => c.q !== '');

/**
 * 跑一遍。
 *
 * @param {boolean} withState - 带不带激活度。
 * @returns {object[]} 每条问法注入了什么。
 */
function run(withState, weight = null) {
  let states = new Map();
  const out = [];
  for (const [i, c] of asks.entries()) {
    const turn = i + 1;
    const opts = {};
    if (withState) {
      opts.activations = act.activationsFor(entries, states);
      if (Number.isFinite(weight)) opts.activationWeight = weight;
    }
    const d = logic.explainEntries(entries, c.q, opts);
    out.push({ name: c.name, ask: c.q, chosen: d.chosen.map((e) => e.id) });

    if (withState) {
      // 和 `worldbook.mjs` 里那条链一样：选中 ∪ 命中 ∪ 没进去的，**再扣掉连带带出来的**。
      const linked = new Set((Array.isArray(d.linked) ? d.linked : []).map((e) => e.id));
      const hitIds = new Set([
        ...d.chosen.map((e) => e.id),
        ...d.hits.map((e) => e.id),
        ...d.dropped.map((it) => it.entry.id)
      ].filter((id) => !linked.has(id)));
      states = act.stepAll(entries, states, hitIds, turn);
    }
  }
  return out;
}

const off = run(false);

/* ------------------------------------------------------------------ *
 * 扫权重
 * ------------------------------------------------------------------ */

if (SWEEP) {
  // 权重 1.0 = 完全不听激活度 —— 那一档**必须和关着时一模一样**。
  // 它是这个扫描的**对照**：如果 1.0 都变了，说明有别的东西在动，那不是权重的事。
  const WEIGHTS = [0.8, 0.85, 0.9, 0.95, 0.98, 1.0];

  console.log('');
  console.log(`  权重扫描 —— ${asks.length} 条问法，当成一场连续对话`);
  console.log('');
  console.log('   权重   变了的   其中「换掉了内容」的');
  console.log('   ─────────────────────────────────────');

  for (const w of WEIGHTS) {
    const on = run(true, w);
    let setChanged = 0;
    let orderOnly = 0;
    for (const [i, a] of off.entries()) {
      const before = a.chosen;
      const after = on[i].chosen;
      if (before.join() === after.join()) continue;
      // 「换掉了内容」= 集合不一样；只是顺序变了的不算
      if ([...before].sort().join() === [...after].sort().join()) orderOnly += 1;
      else setChanged += 1;
    }
    const mark = w === 1 ? '  ← 对照档（该和「关着」一样）' : '';
    const bad = w === 1 && (setChanged > 0 || orderOnly > 0) ? '   **✗ 不该有变化**' : '';
    console.log(
      `   ${w.toFixed(2)}     ${String(setChanged + orderOnly).padStart(2)}        ` +
      `${String(setChanged).padStart(2)}（顺序变 ${orderOnly}）${mark}${bad}`
    );
  }
  console.log('');
  console.log('  ⚠️ 「变了几条」**不是越小越好** —— 有一条变化是**变好**的');
  console.log('     （问赛飞儿的预言，关着时冒出了缇宝那条）。看单档要加 --weight。');
  console.log('');
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * 单跑一次
 * ------------------------------------------------------------------ */

console.log('');
console.log(`  带激活度的对答测试 —— ${asks.length} 条问法，当成一场连续对话`);
console.log('');

const on = run(true, WEIGHT);

/* ------------------------------------------------------------------ *
 * 和存下来的那份比
 * ------------------------------------------------------------------ */

if (DIFF !== null) {
  let before;
  try {
    before = JSON.parse(readFileSync(DIFF, 'utf8'));
  } catch (error) {
    // 读不了就说清楚 —— 而**最可能的原因是编码**：
    // PowerShell 的 `>` 默认写 UTF-16，那个文件 JSON.parse 直接炸。
    console.log('');
    console.log(`  ✗ 读不了 ${DIFF}：${String(error?.message ?? error).slice(0, 80)}`);
    console.log('    ⚠️ 存的时候要用 --save，别用 shell 的 `>` —— 它默认写 UTF-16。');
    console.log('');
    process.exit(1);
  }

  console.log('');
  console.log(`  和 ${DIFF} 比`);
  console.log('');

  let n = 0;
  for (const [i, cur] of on.entries()) {
    const old = before.on?.[i];
    if (old === undefined) continue;
    if (old.chosen.join() === cur.chosen.join()) continue;
    n += 1;
    console.log(`  ⚠️ ${cur.name || cur.ask}`);
    console.log(`       旧  ${old.chosen.join(', ')}`);
    console.log(`       新  ${cur.chosen.join(', ')}`);
    console.log('');
  }
  console.log(`  开了激活度的那一侧，变了 ${n} 条。`);
  console.log('');
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * 打差异
 * ------------------------------------------------------------------ */

const changed = [];
for (const [i, a] of off.entries()) {
  const b = on[i];
  const same = a.chosen.join(',') === b.chosen.join(',');
  if (!same || SHOW_ALL) changed.push({ ...b, was: a.chosen, same });
}

console.log(`  注入结果变了的：**${changed.filter((c) => !c.same).length} / ${asks.length}**`);
console.log('');

for (const c of changed) {
  const mark = c.same ? '  ' : '⚠️';
  console.log(`  ${mark} ${c.name || c.ask}`);
  console.log(`       问   ${c.ask}`);
  if (!c.same) console.log(`       关着 ${c.was.join(', ')}`);
  console.log(`       开着 ${c.chosen.join(', ')}`);
  console.log('');
}

if (SAVE !== null) {
  writeFileSync(SAVE, `${JSON.stringify({ off, on }, null, 2)}\n`, 'utf8');
  console.log(`  存到 ${SAVE}`);
  console.log('');
}
