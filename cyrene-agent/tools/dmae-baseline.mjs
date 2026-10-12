/**
 * 注入行为的基线：改动**前**是什么样，留一份能逐条对照的。
 *
 * ## 为什么要单独取一份
 *
 * `retrieve.mjs --eval` 量的是**余弦排序**那条路的代价（见那个文件的函数头）。
 * 而**真正决定注入哪些的是 `explainEntries`** —— 关键词 + priority + 两个上限。
 *
 * **所以那份基线不能拿来对照激活度的改动。** 这条链跑的是另一条路。
 *
 * ## 记什么
 *
 * 对评测里每一条问法，记下：
 *
 *   chosen      实际会被注入的（最多 3 条，受字数预算约束）
 *   hits        命中了但没排上的
 *   dropped     被挡下的，以及**理由**（recent / over-limit / over-budget / …）
 *   escalated   窗口耗尽时从里面捞回来的
 *
 * **`dropped` 那栏最要紧** —— 激活度要加的正是第五种理由。
 * 改动之后拿这一份逐条比，就知道哪些条目的命运变了、**变成了什么**。
 *
 * 用法：
 *   node tools/dmae-baseline.mjs --save <文件名>.json           存一份
 *   node tools/dmae-baseline.mjs --diff <旧的那份.json>          和一份旧的比
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const mod = await import('../worldbook-logic.mjs');

const HERE = new URL('..', import.meta.url);
const BOOK = new URL('../worldbook/entries.yaml', import.meta.url);
const CASES = new URL('../eval/retrieval.yaml', import.meta.url);

/**
 * 跑一遍所有问法。
 *
 * ## `--activations <状态文件>`：这就是「改动后」
 *
 * 不带那个参数时，`explainEntries` 收到空 `activations` → **退回纯 priority 排序**，
 * 也就是**改动前的行为**。带上之后，它按激活度加权排 —— **那就是改动后。**
 *
 * 所以同一把尺子能量两个时候：
 *
 *     & $node tools/dmae-baseline.mjs --save 前.json                      # 改动前
 *     & $node tools/dmae-baseline.mjs --activations data/worldbook-activation.json --save 后.json
 *     & $node tools/dmae-baseline.mjs --diff 前.json                      # 逐条比
 *
 * ⚠️ **第三次那个 `--diff` 比的是「现在这个环境」和「前.json」。**
 *    所以要比「后」，得先把开关打开、跑够轮次让状态积累起来，再来跑它。
 *
 * @returns {object[]} 每条问法的结果。
 */
function capture() {
  const raw = yaml.load(readFileSync(BOOK, 'utf8'));
  const book = mod.buildWorldbook(raw);
  const cases = yaml.load(readFileSync(CASES, 'utf8'));

  // `--activations <文件>` —— 不传就是改动前的行为
  const at = process.argv.indexOf('--activations');
  let activations;
  if (at !== -1) {
    const file = process.argv[at + 1];
    if (!file || !existsSync(file)) {
      console.log(`\n  ✗ --activations 指的文件不存在：${String(file)}\n`);
      process.exit(1);
    }
    const payload = JSON.parse(readFileSync(file, 'utf8'));
    activations = new Map(
      Object.entries(payload.states ?? {}).map(([id, st]) => [id, Number(st.activation)])
    );
    console.log(`\n  （按激活度加权 —— 读了 ${activations.size} 条状态）`);
  }

  return cases.map((c) => {
    const asks = Array.isArray(c.ask) ? c.ask : [c.ask];
    const q = String(asks[0] ?? '');
    const out = mod.explainEntries(book.entries, q, activations === undefined ? {} : { activations });
    return {
      name: c.name ?? '',
      ask: q,
      chosen: out.chosen.map((e) => e.id),
      hits: out.hits.map((e) => e.id),
      escalated: out.escalated.map((e) => e.id),
      dropped: out.dropped.map((d) => ({ id: d.entry.id, reason: d.reason }))
    };
  });
}

/* ------------------------------------------------------------------ *
 * 和一份旧的比
 * ------------------------------------------------------------------ */

const diffAt = process.argv.indexOf('--diff');
if (diffAt !== -1) {
  const oldFile = process.argv[diffAt + 1];
  if (!existsSync(oldFile)) {
    console.log(`\n  ✗ 找不到 ${oldFile}\n`);
    process.exit(1);
  }
  const before = JSON.parse(readFileSync(oldFile, 'utf8'));
  const after = capture();
  const byAsk = new Map(before.map((r) => [r.ask, r]));

  let changed = 0;
  console.log('\n  逐条对照：\n');
  for (const now of after) {
    const was = byAsk.get(now.ask);
    if (was === undefined) {
      console.log(`    ·  ${now.ask}  （旧那份里没有）`);
      continue;
    }
    const same = JSON.stringify(was.chosen) === JSON.stringify(now.chosen);
    if (same) continue;
    changed += 1;
    console.log(`    ⚠️ ${now.ask}`);
    console.log(`        旧: ${was.chosen.join(', ') || '（空）'}`);
    console.log(`        新: ${now.chosen.join(', ') || '（空）'}`);
    const gone = was.chosen.filter((id) => !now.chosen.includes(id));
    const came = now.chosen.filter((id) => !was.chosen.includes(id));
    if (gone.length) console.log(`        少了: ${gone.join(', ')}`);
    if (came.length) console.log(`        多了: ${came.join(', ')}`);
  }
  console.log('');
  console.log(changed === 0 ? '  没有任何一条的注入结果变了。\n' : `  ${changed} 条变了（共 ${after.length} 条）。\n`);
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * 取一份新的
 * ------------------------------------------------------------------ */

const rows = capture();

// ⚠️ `--save <path>` 让**脚本自己写文件**，而不是让调用方用 `>` 重定向。
//
// 2026-10-11 踩过：`& node … --json > file.json` 在 PowerShell 5.1 下
// **默认写 UTF-16**，于是 `--diff` 回头读它时 `JSON.parse` 直接炸。
// **用 shell 重定向存机器要读的文件，等于把编码交给一个不关心它的东西决定。**
const saveAt = process.argv.indexOf('--save');
if (saveAt !== -1) {
  const path = process.argv[saveAt + 1];
  if (!path) {
    console.log('\n  ✗ --save 后面要跟一个路径\n');
    process.exit(1);
  }
  writeFileSync(path, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  console.log(`\n  存了 ${rows.length} 条到 ${path}\n`);
  process.exit(0);
}

if (process.argv.includes('--json')) {
  // 写 stdout。**只在终端上看的时候用它** —— 要存文件请用 `--save`。
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  process.exit(0);
}

console.log(`\n  注入行为基线 · ${rows.length} 条问法 · 路径 explainEntries（关键词 + priority）\n`);
console.log(`  ${'问的'.padEnd(24)}${'注入的（最多 3 条）'}`);
console.log(`  ${'-'.repeat(76)}`);
for (const r of rows) {
  console.log(`  ${r.ask.slice(0, 22).padEnd(24)}${r.chosen.join(', ') || '（空）'}`);
}

// 统计一下「为什么没给」—— 那才是改动之后要对照的东西
const reasons = new Map();
for (const r of rows) for (const d of r.dropped) reasons.set(d.reason, (reasons.get(d.reason) ?? 0) + 1);

console.log('\n  被挡下的理由分布：\n');
for (const [reason, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(4)}  ${reason}`);
}
console.log('\n  ⚠️ 激活度要加的是**第五种**理由，不是替掉这几种。');
console.log('     改完之后拿这份比，看哪些条目的命运变了、变成了什么。\n');
