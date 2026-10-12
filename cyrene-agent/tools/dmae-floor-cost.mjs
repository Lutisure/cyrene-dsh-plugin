/**
 * 底座两条语义，对**你那 132 条**分别意味着什么。
 *
 * ## 为什么要这个
 *
 * 「地板还是起点」听着像哲学问题，其实是数的：
 *
 *   阈值 30，`A_base` 映到 `[18, 42]`（priority 30→18，90→42）
 *   **`A_base` ≥ 30 的那些条目，在 `permanent` 下永远在线。**
 *
 *   而一轮只挑 3 条（`DEFAULT_LIMIT`）。**永远在线的一多，那 3 个位置就被它们长期占住。**
 *
 * 所以要看的是：**两种语义下，各有多少条会长期在线？**
 *
 * 用法：
 *   node tools/dmae-floor-cost.mjs
 */

import { readFileSync } from 'node:fs';

import { DEFAULT_PARAMS as P, baseFromPriority, deriveState } from '../dmae.mjs';

const text = readFileSync(new URL('../worldbook/entries.yaml', import.meta.url), 'utf8');

// 只为统计，不解析 YAML —— 抓 id 和 priority 就够，省一个依赖。
// 条目形状是（`- id:` 前面**有缩进**，第一版写成行首于是零条匹配）：
//   - id: xxx
//     triggers: [...]
//     priority: 62
//     text: >-
const entries = [];
let current = null;
for (const line of text.split('\n')) {
  const id = /^\s*- id:\s*(\S+)/u.exec(line);
  if (id !== null) {
    current = { id: id[1], priority: null };
    entries.push(current);
    continue;
  }
  const p = /^\s+priority:\s*(\d+)/u.exec(line);
  if (p !== null && current !== null) current.priority = Number(p[1]);
}

const withPriority = entries.filter((e) => e.priority !== null);
console.log(`\n  132 条里抓到 priority 的：${withPriority.length} 条\n`);

const alwaysOn = withPriority
  .filter((e) => deriveState(baseFromPriority(e.priority, P), P) === 'active')
  .sort((a, b) => b.priority - a.priority);
const offline = withPriority.filter((e) => deriveState(baseFromPriority(e.priority, P), P) !== 'active');

console.log('  ── permanent（永久地板）──\n');
console.log(`    **长期在线 ${alwaysOn.length} 条**，另有 ${offline.length} 条在阈值下。\n`);
console.log(`    一轮只挑 ${3} 条。那 ${alwaysOn.length} 条里 priority 最高的会长期占住位置：\n`);
for (const e of alwaysOn.slice(0, 8)) {
  console.log(`      ${e.id.padEnd(26)}p${e.priority}`);
}
if (alwaysOn.length > 8) console.log(`      …… 另外 ${alwaysOn.length - 8} 条`);

console.log('\n  ── wake（醒来时的高度）──\n');
console.log('    **长期在线 0 条。** 一条都没聊到的时候，132 条全是 0 —— 谁也不占位置。\n');

console.log('  ── 所以差别在哪 ──\n');
console.log(`    permanent   最热的那几条永远在场。**但那正是现在的行为** ——`);
console.log(`                今天就是按 priority 排序取前 3，而 priority 高的永远是那几条。`);
console.log(`                换句话说：**permanent 等于「加了激活度但没改变什么」。**\n`);
console.log('    wake        不聊就淡出。**「最近在想什么」真的会随时间变。**');
console.log('                而归档的条目还在、还能被关键词命中、命中就唤醒 ——');
console.log('                **`anaxa-creed` 那个 case 要修的正是这一种，不是「永远在场」那一种。**\n');
