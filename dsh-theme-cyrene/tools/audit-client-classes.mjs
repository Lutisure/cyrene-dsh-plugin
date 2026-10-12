/**
 * 找出「用了但没定义样式」的 `cy-*` 类名。
 *
 * ## 为什么写这个
 *
 * 2026-10-11：那个 live region 用了 `class: "cy-sr"`，**而 CSS 里根本没有 `.cy-sr`** ——
 * 于是它本该视觉隐藏，实际却是个普通 div，reorder 的提示语写进去就**一直挂在屏幕上**。
 *
 * 这类错的特征是：**代码读起来完全正确**（类名取得好、语义也对），
 * 只有把它和 CSS 对一遍才看得出来。所以值得一次扫全部，而不是只修看见的那一个。
 *
 * 用法：node tools/audit-client-classes.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';

const DIR = 'lib/client';

const files = readdirSync(DIR).filter((f) => f.endsWith('.js'));
let js = '';
/** CSS 选择器一般写在字符串里，形如 ".cy-xxx" 或 ".cy-xxx," */
const styled = new Set();

for (const f of files) {
  const text = readFileSync(`${DIR}/${f}`, 'utf8');
  js += text;
  for (const m of text.matchAll(/\.(cy-[a-z0-9-]+)(?=[\s,{:.[]|$)/gm)) styled.add(m[1]);
}

/** 类名出现在字符串或 class 属性里。 */
const used = new Set();
for (const m of js.matchAll(/["'`](cy-[a-z0-9-]+)/g)) used.add(m[1]);
for (const m of js.matchAll(/class:\s*"([^"]+)"/g)) {
  for (const cls of m[1].split(/\s+/)) if (cls.startsWith('cy-')) used.add(cls);
}

const missing = [...used].filter((c) => !styled.has(c)).sort();

console.log(`\n  cy-* 类名：用了 ${used.size} 个，样式里定义过 ${styled.size} 个\n`);
if (missing.length === 0) {
  console.log('  没有「用了但没定义」的 —— 全都有样式。\n');
} else {
  console.log(`  ⚠️ 用了但样式里搜不到的 ${missing.length} 个：\n`);
  for (const m of missing) console.log(`    ${m}`);
  console.log('\n  逐个确认：真的缺样式，还是它在别处（比如 CSS 变量名、注释里）。\n');
}
