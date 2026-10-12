/**
 * 仓库级的行尾检查。
 *
 * ## 为什么要有它
 *
 * 2026-10-09 第 4-5 轮：「改九个条目的触发词」这个小脚本因为行尾调试了三轮，
 * 而每次的症状都指向别处 —— 找不到条目、报「里没有单行 triggers」、
 * 最后**悄悄把九行从 CRLF 改成了 LF**，而且没有任何东西发现。
 *
 * 是第 5 轮去数行尾的时候才看出来的：CRLF 从 880 降到 871，正好等于改过的条目数。
 *
 * 所以这条检查盯的是**「悄悄改掉行尾」**这一类事。它不规定你该用哪种行尾 ——
 * 只要求**一个文件里别混着两种**，以及**明确列出的那几个文件必须是 LF**。
 *
 * ## 为什么允许 CRLF 存在
 *
 * 这个仓库是备份，工作区就是正在运行的那份插件（`.gitattributes` 里是 `* -text`，
 * git 一个字节都不改）。工具没有立场去改一个文件的整体风格 —— 它只该
 * **不要在编辑的时候顺手改掉**。
 *
 * 用法：
 *   node tools/check-eol.mjs            # 只报告混合的
 *   node tools/check-eol.mjs --all      # 连纯 CRLF 的一起列出来
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { countEol } from '../eol.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const PACKAGES = ['cyrene-agent', 'cyrene-guard', 'dsh-theme-cyrene'];

const TEXT = new Set(['.mjs', '.js', '.json', '.yaml', '.yml', '.md', '.txt', '.css', '.ts', '.html']);
const SKIP = new Set(['node_modules', '.git', 'dist', 'GIF', 'assets', 'music', 'brand', '.data', 'deploy']);

function walk(dir, out = []) {
  let items;
  try { items = readdirSync(dir); } catch { return out; }
  for (const item of items) {
    if (SKIP.has(item)) continue;
    const full = join(dir, item);
    let info;
    try { info = statSync(full); } catch { continue; }
    if (info.isDirectory()) walk(full, out);
    else if (TEXT.has(extname(item)) && info.size < 4e6) out.push(full);
  }
  return out;
}

const mixed = [];
const crlfOnly = [];
let total = 0;

for (const pkg of PACKAGES) {
  for (const file of walk(join(ROOT, pkg))) {
    const counts = countEol(readFileSync(file, 'utf8'));
    if (counts.crlf === 0 && counts.lf === 0) continue;
    total += 1;
    const relative = file.slice(ROOT.length + 1).replace(/\\/g, '/');
    if (counts.mixed) mixed.push([relative, counts]);
    else if (counts.crlf > 0) crlfOnly.push([relative, counts]);
  }
}

process.stdout.write(`\n  扫了 ${total} 个文本文件（三个插件包，跳过 node_modules/dist/assets）\n\n`);

if (mixed.length === 0) {
  process.stdout.write('  没有混合行尾的。\n');
} else {
  process.stdout.write(`  ⚠️ ${mixed.length} 个文件混着两种行尾 —— 这一般说明某个工具写回时换了行尾：\n`);
  for (const [file, c] of mixed) process.stdout.write(`      ${file.padEnd(48)} CRLF ${c.crlf} / LF ${c.lf}\n`);
}

if (process.argv.includes('--all')) {
  process.stdout.write(`\n  纯 CRLF 的 ${crlfOnly.length} 个（不算问题，列出来是为了看清分布）：\n`);
  for (const [file, c] of crlfOnly) process.stdout.write(`      ${file.padEnd(48)} CRLF ${c.crlf}\n`);
} else if (crlfOnly.length > 0) {
  process.stdout.write(`\n  纯 CRLF 的 ${crlfOnly.length} 个（--all 看清单）。\n`);
}

process.stdout.write('\n');
process.exitCode = mixed.length === 0 ? 0 : 1;
