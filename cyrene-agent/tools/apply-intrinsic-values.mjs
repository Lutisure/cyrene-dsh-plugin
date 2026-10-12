/**
 * 把 `intrinsic-values.mjs` 定的值填进 `worldbook/entries.yaml`。
 *
 * ## 默认只干跑
 *
 * 不带 `--apply` 时**一个字都不写** —— 只打出来「会改哪几条、改成什么」。
 * 132 处插入是机械活，而机械活出错的方式是**安静地错**：
 * 缩进差一格、把 `priority` 认成别的键、行尾变 CRLF。
 * 所以**先看，再写。**
 *
 * ## 它只做一件事
 *
 * 在每条条目的 `priority:` 行**下面**插一行 `intrinsicValue: X`。
 * 别的什么都不碰 —— 不重排、不格式化、不加引号。
 *
 * ## 值从哪来
 *
 * **`tools/intrinsic-values.mjs` 那张表。** 那里每个数旁边标着来源
 * （`upstream` 搬的 / `ours` 定的），而这张脚本**不做判断** ——
 * 它只是个抄写员。**要改值就改那张表，别改这里。**
 *
 * @module apply-intrinsic-values
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { valueFor } from './intrinsic-values.mjs';

const YAML = new URL('../worldbook/entries.yaml', import.meta.url);
const APPLY = process.argv.includes('--apply');

const source = readFileSync(YAML, 'utf8');
// ⚠️ 行尾先归一化再处理，最后**按原来的写回去** ——
//    仓库里 `check-eol.mjs` 管着这件事，别把它弄坏。
const CRLF = source.includes('\r\n');
const lines = source.replace(/\r\n/g, '\n').split('\n');

const out = [];
let currentId = null;
let added = 0;
let skipped = 0;
const report = [];

for (const line of lines) {
  // ⚠️ **`- ` 前面有缩进** —— 这个文件是 `  - id: xxx` / `    priority: 60`，
  //    而第一版我按 `^- id:` 写（`-` 在第 0 列），于是**一条都没匹配上**，
  //    脚本安安静静地报「要插 0 条」。
  //
  //    这是这一趟第三次栽在同一件事上：**对空白做了没验证的假设。**
  //    （前两次：`dmae-floor-cost` 的正则漏缩进→「抓到 0 条」；
  //      `reachability` 那类「量出来是 0」和「没量到」长得一样。）
  //
  //    **「0」这个输出永远要先问一句：是真没有，还是我没看见。**
  const idMatch = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line);
  if (idMatch !== null) {
    currentId = idMatch[1];
    out.push(line);
    continue;
  }

  const priMatch = /^(\s+)priority:\s*(\d+)\s*$/.exec(line);
  if (priMatch !== null && currentId !== null) {
    out.push(line);
    const value = valueFor(currentId, Number(priMatch[2]));
    out.push(`${priMatch[1]}intrinsicValue: ${value}`);
    report.push(`    ${currentId.padEnd(24)} priority ${priMatch[2].padStart(3)} → intrinsicValue ${value}`);
    added += 1;
    currentId = null; // 一条只插一次
    continue;
  }

  // 已经有这个字段的，跳过 —— 这个脚本不是用来覆盖手填的值的
  if (/^\s+intrinsicValue:/.test(line)) {
    skipped += 1;
    out.push(line);
    continue;
  }

  out.push(line);
}

const next = out.join('\n');
const text = CRLF ? next.replace(/\n/g, '\r\n') : next;

console.log('');
console.log(`  ${APPLY ? '写入' : '干跑（加 --apply 才写）'}`);
console.log(`    要插 ${added} 条，已有 intrinsicValue 的跳过 ${skipped} 条`);
console.log(`    行尾 ${CRLF ? 'CRLF' : 'LF'}，原样写回`);
console.log('');
for (const row of report) console.log(row);
console.log('');

if (!APPLY) {
  console.log('  没写任何东西。');
  console.log('');
  process.exit(0);
}

writeFileSync(YAML, text, 'utf8');
console.log(`  写好了：${YAML.pathname}`);
console.log('');
