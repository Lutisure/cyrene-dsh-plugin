/** Frames for the user to look at: context, plus three phases of the crest. */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---- 仓库根，从本文件的位置推（由 tools/derive-roots.mjs 加的头）----
//
// 以前这里写的是作者机器上的绝对路径。那只在那台机器上成立，
// 而且清洗脚本会把绝对路径换成占位符，于是代码里出现 <本仓库> 这种目录名，直接崩。
import { fileURLToPath as __f } from 'node:url';
import { dirname as __d } from 'node:path';
const REPO_ROOT = __d(__d(__d(__f(import.meta.url))));

// ⚠️ 静态 import 的说明符必须是**字符串字面量**，不能用模板字符串 ——
//    `from \`file://${REPO_ROOT}/...\`` 是语法错误。
//    而 `cdp.mjs` 就在同一个目录里，写相对路径最直接，也不需要 REPO_ROOT。
//    （`tools/derive-roots.mjs` 第一版把这条也改了，这个文件当场起不来；
//      脚本里那条规则已经删掉。）
import { startBrowser } from './cdp.mjs';

const OUT = join(process.env.TEMP ?? '/tmp', 'cyrene-look-edge');
mkdirSync(OUT, { recursive: true });

const browser = await startBrowser({ width: 1440, height: 900 });
try {
  await browser.gotoAuthenticated('http://127.0.0.1:19387');
  await new Promise((r) => setTimeout(r, 1600));
  await browser.callWith([
    'function () {',
    '  const row = Array.from(document.querySelectorAll(\'[role="treeitem"]\'))',
    '    .find(function (n) { return /进行中|研发模式/.test(n.textContent || ""); });',
    '  if (row) row.click();',
    '}'
  ].join('\n'), []);
  await new Promise((r) => setTimeout(r, 4200));

  const box = JSON.parse(await browser.evaluate([
    '(function () {',
    '  const e = document.querySelector(".cy-work-edge");',
    '  if (!e) return JSON.stringify({ missing: true });',
    '  const r = e.getBoundingClientRect();',
    '  return JSON.stringify({ left: Math.round(r.left), on: getComputedStyle(e).opacity });',
    '})()'
  ].join('\n')));
  if (box.missing) throw new Error('the edge element is not on the page');
  console.log('edge at x=' + box.left + '  opacity=' + box.on);

  // The whole window, so the effect is seen where it actually lives.
  const full = await browser.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, 'context.png'), Buffer.from(full.data, 'base64'));

  // Three phases of one traversal. The crest runs the full viewport height in
  // 2.6s, so waiting a third of that between frames spreads it over the screen.
  const clip = { x: Math.max(0, box.left - 14), y: 0, width: 120, height: 900, scale: 1 };
  const wait = 860;
  for (let index = 1; index <= 3; index += 1) {
    if (index > 1) await new Promise((r) => setTimeout(r, wait));
    const at = await browser.evaluate([
      '(function () {',
      '  const c = document.querySelector(".cy-work-edge-crest");',
      '  const r = c.getBoundingClientRect();',
      '  return JSON.stringify({ y: Math.round(r.top), o: Number(getComputedStyle(c).opacity).toFixed(2) });',
      '})()'
    ].join('\n'));
    console.log('phase ' + index + '  crest at ' + at);
    const shot = await browser.send('Page.captureScreenshot', { format: 'png', clip });
    writeFileSync(join(OUT, 'phase' + index + '.png'), Buffer.from(shot.data, 'base64'));
  }
  console.log('frames -> ' + OUT);
} catch (error) {
  console.log('FAILED: ' + String((error && error.message) || error).slice(0, 300));
} finally {
  await browser.stop();
}
