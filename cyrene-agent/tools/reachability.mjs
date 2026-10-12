/**
 * 可达性审计 —— 132 条，每一条能不能被推上前三。
 *
 * ## 它回答的是第 2 件的验收
 *
 * 目标里那条验收写的是：
 *
 *   > 那 74 条（23 条从没命中 + 51 条命中但一次没发出去）—— 它们能不能排进前三，就是判据。
 *
 * **但日志里没有 query 原文**（只记了 hits/sent/dropped），所以「拿当时那些问法去测」
 * 是做不到的。能做的是把问题反过来问：
 *
 *   > **存在一个问法，能把这条推上前三吗？**
 *
 * 对每一条，用它**自己的触发词**造一句最有利的问法，走**真管道**（`explainEntries`），
 * 看它进不进前三。**进不去，说明这条永远发不出来。**
 *
 * ## 为什么只用最有利的问法，不做更严的检验
 *
 * 这是**上界**不是平均值。真实对话里的问法只会更模糊，所以：
 *
 *   连最有利的问法都进不去 → **确定不可达**，这条是死的
 *   进得去                  → 只能说「可到达」，不代表常见问法下也进得去
 *
 * **一个方向确定的结论比一个平均值可靠。** 这一份只报「确定不可达」那部分。
 *
 * 用法：
 *   node tools/reachability.mjs           # 全部 132 条
 *   node tools/reachability.mjs --dead    # 只看进不去的那几条
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

import yaml from 'js-yaml';

const ROOT = `${REPO_ROOT}/cyrene-agent`;
const argv = process.argv.slice(2);

const L = await import(pathToFileURL(`${ROOT}/worldbook-logic.mjs`).href);
const book = yaml.load(readFileSync(`${ROOT}/worldbook/entries.yaml`, 'utf8'));
const built = L.buildWorldbook(book);

/**
 * 给一条造一句最有利的问法。
 *
 * 挑**最长的那条不带通配符的触发词**，套进一个问句里 —— 越长的触发词越具体，
 * 越容易把这一条顶上去。全都带通配符时退回第一条，把 `*` 去掉当普通词用。
 *
 * @param {object} entry - 条目。
 * @returns {string} 问句。
 */
function bestAsk(entry) {
  const triggers = (entry.triggers ?? []).map((t) => String(t));
  const plain = triggers.filter((t) => !t.includes('*'));
  const pick = (plain.sort((a, b) => b.length - a.length)[0] ?? triggers[0] ?? '').replace(/\*/g, '');
  if (pick === '') return null;
  // 触发词本身就是个名词时，套一句通用的问法；已经是问句的直接用。
  return /[？?]$/.test(pick) ? pick : `${pick}是怎么回事`;
}

/**
 * 连问同一句，最多跑几轮。
 *
 * ⚠️ 一开始只跑两轮，于是 `hyacine-self`（p50，风堇家最低的那条）被判成「死」——
 * **而它是第三轮才轮到。** 家族有七层的时候，两轮数不到底。
 */
const MAX_TURNS = 8;

const rows = [];
for (const e of built.entries ?? []) {
  const ask = bestAsk(e);
  if (ask === null) {
    rows.push({ id: e.id, ask: null, at: null, chosen: [] });
    continue;
  }
  // 连问同一句，每轮把给过的跳过 —— 直到它出现，或者轮次用尽。
  const seen = new Set();
  let at = null;
  let firstRound = [];
  for (let turn = 1; turn <= MAX_TURNS; turn += 1) {
    const decision = L.explainEntries(built.entries, ask, { skip: new Set(seen) });
    const chosen = decision.chosen.map((c) => c.id);
    if (turn === 1) firstRound = chosen;
    if (chosen.includes(e.id)) {
      at = turn;
      break;
    }
    // 这一轮什么都没给，再问下去也不会有了。
    if (chosen.length === 0) break;
    for (const id of chosen) seen.add(id);
  }
  rows.push({ id: e.id, ask, at, chosen: firstRound });
}

const first = rows.filter((r) => r.at === 1);
const later = rows.filter((r) => r.at !== null && r.at > 1);
const never = rows.filter((r) => r.at === null);

console.log(`\n  132 条可达性审计（用每条自己的触发词造一句最有利的问法）\n`);
console.log(`    第一轮就进前三     ${String(first.length).padStart(3)} 条`);
console.log(`    往后几轮才进      ${String(later.length).padStart(3)} 条   ← 等轮次，不是死`);
console.log(`    ${MAX_TURNS} 轮都进不去     ${String(never.length).padStart(3)} 条   ← **这些才是真进不去**\n`);

// ⚠️ 探针本身有偏差，写出来别让人当准数。
console.log('  ⚠️ 探针挑的是**最长的那条不带通配符的触发词**，而它常常是角色的别名');
console.log('     （「海列屈拉」而不是「结局」）。所以这一列量的是「光提这个名字，连问下去给什么」。\n');

if (later.length > 0) {
  const byTurn = {};
  for (const r of later) (byTurn[r.at] ??= []).push(r.id);
  console.log('    往后几轮才进的，按第几轮分组：\n');
  for (const turn of Object.keys(byTurn).sort((a, b) => a - b)) {
    console.log(`    第 ${turn} 轮   ${byTurn[turn].join(', ')}`);
  }
  console.log('');
}

if (never.length > 0) {
  console.log(`    **${MAX_TURNS} 轮都进不去的**：\n`);
  for (const r of never) {
    console.log(`    ${r.id.padEnd(22)} 问「${r.ask}」`);
    console.log(`      ${' '.repeat(22)} 第一轮拿到 ${r.chosen.join(', ')}`);
  }
  console.log('');
} else {
  console.log(`    **没有一条是 ${MAX_TURNS} 轮都进不去的。**\n`);
}

console.log('  ⚠️ 这是**上界**：用的是每条最有利的问法。真实对话只会更模糊，');
console.log('     所以「进得去」不代表常见问法下也进得去；「进不去」则是确定的。\n');
