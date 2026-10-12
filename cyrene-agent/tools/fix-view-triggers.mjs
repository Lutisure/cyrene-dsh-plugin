/**
 * 第 9 轮：把 `view-*` 那一族的触发词从「光名字」换成「提问形状」。
 *
 * ## 问题
 *
 * `view-phainon` 写的是**她对白厄的看法**（「白厄在你眼里一直是那个在哀丽秘榭的
 * 田野中奔跑的孩子」），而它的触发词只有「白厄」一个。
 *
 * 同一个名字下，事实层的优先级是 60~65，它只有 45 —— 于是一轮 3 个位置里
 * **永远轮不到它**。问「你觉得白厄怎么样」，拿到的是事实层三条，
 * **她对他的看法永远进不来**。
 *
 * 121 条里有 11 条是这样，10 条是 `view-*`。
 *
 * ## 为什么不动优先级
 *
 * 抬高它会让「白厄是谁」也给出看法那条 —— 而 L1 有一条用例钉着
 * 「问白厄，第一轮给事实层」。**方向不能反。**
 *
 * 真正的杠杆是触发词：让这一族**只在被问看法时**命中。
 *
 *     「你觉得白厄怎么样」  含「白厄怎么样」 → 命中 view-phainon
 *     「白厄是谁」          不含任何一个     → 命中事实层
 *
 * 这才是它本来该有的行为 —— 触发词没写对，不是优先级排错了。
 *
 * ## 顺带
 *
 * `castorice-people` 写的是「遐蝶对身边人的做法」，而它的触发词是
 * **白厄 / 阿格莱雅 / 缇安 / 缇宁** —— 别人的名字。所以问白厄会把它带出来，
 * 而问「遐蝶怎么对朋友」带不出它。也一起改。
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
 * 一条 [名字] 触发词该展开成什么。
 *
 * 挑的是**中文里问看法时最常用的几种说法**，都能塞进一个句子里当子串。
 * 不做「怎么看」这种不带名字的 —— 那个太泛，会命中任何一句「你怎么看……」。
 */
const shapeOf = (name) => [
  `${name}怎么样`,
  `${name}如何`,
  `怎么看${name}`,
  `觉得${name}`,
  `对${name}的看法`
];

/** 手工那一处。理由在文件头。 */
const MANUAL = [
  ['castorice-people', ['遐蝶对', '遐蝶待', '遐蝶怎么对', '遐蝶和身边']]
];

let text = readFileSync(FILE, 'utf8');
const report = [];

/** 定位一条条目的正文块（从 `- id: x` 到下一个 `- id:`）。 */
function blockOf(id) {
  const head = new RegExp(`\\r?\\n  - id: ${id}\\r?\\n`).exec(text);
  if (head === null) return null;
  const start = head.index;
  const after = start + head[0].length;
  const next = /\r?\n  - id: /.exec(text.slice(after));
  const end = next === null ? text.length : after + next.index;
  return { start, end, body: text.slice(start, end) };
}

/** 把一条条目的 triggers 行换掉。 */
function setTriggers(id, triggers) {
  const found = blockOf(id);
  if (found === null) { report.push(`✗ ${id} 找不到`); return false; }
  const line = found.body.match(/^([ \t]+triggers: )\[.*\]\r?$/m);
  if (line === null) { report.push(`✗ ${id} 里没有单行 triggers`); return false; }
  const before = line[0].trim();
  const after = `${line[1]}[${triggers.join(', ')}]`;
  text = text.slice(0, found.start) + found.body.replace(line[0], after) + text.slice(found.end);
  report.push(`✓ ${id}\n      ${before}\n   →  ${after}`);
  return true;
}

// ── 一、view-* 那一族：把光名字展开 ──
// 边找边改会打乱位置，所以先扫出来。
const views = [];
for (const match of text.matchAll(/\n  - id: (view-[a-z]+)\n/g)) {
  const id = match[1];
  const found = blockOf(id);
  const line = found?.body.match(/^[ \t]+triggers: \[(.+)\]\r?$/m);
  if (line === null || line === undefined) continue;
  const triggers = line[1].split(',').map((s) => s.trim()).filter(Boolean);
  // 只动「光名字」那种。已经有提问形状的说明改过了。
  if (triggers.length === 1 && !/[怎么样如何觉得]/.test(triggers[0])) {
    views.push([id, triggers[0]]);
  }
}
for (const [id, name] of views) setTriggers(id, shapeOf(name));

// ── 二、手工那一条 ──
for (const [id, triggers] of MANUAL) setTriggers(id, triggers);

writeFileSync(FILE, text);
process.stdout.write(`\n  改了 ${views.length + MANUAL.length} 条\n\n`);
process.stdout.write(report.join('\n') + '\n\n');
