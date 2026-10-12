/**
 * 把拆分后的世界书条目合并进 entries.yaml。
 *
 * ⚠️ **只做文本级块替换，绝不「解析成对象再 dump 回去」。**
 *
 * entries.yaml 里的注释是这份数据的一部分 —— 表头写着两种注入方式的区别、
 * 写一个人为什么要拆条、priority 为什么要拉阶梯；条目之间也有分组小标题。
 * 走 js-yaml 的 load/dump 会把这些全部丢掉，而且丢掉之后没有任何提示：
 * 文件看起来还是好的，只是那些话没了。所以这里按行切块、按块删除、按文本追加。
 *
 * 用法：
 *   node tools/merge-worldbook-split.mjs --remove heir-hysilens,heir-cerydra \
 *        --append <工作目录>/split-hysilens-cerydra-huangdi.yaml [--dry]
 *
 * 校验（任何一项不过就整个中止，不写文件）：
 *   · 要删的 id 确实存在
 *   · 追加的文件能被 YAML 解析，且是顶层数组或 {entries: [...]}
 *   · 新 id 与文件中现有的 id 不重复
 *   · 每个新条目都有 id / triggers / priority / text
 *   · 同一个角色前缀下的 priority 不重复（阶梯要求）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// ---- 仓库根，从本文件的位置推（由 tools/derive-roots.mjs 加的头）----
//
// 以前这里写的是作者机器上的绝对路径。那只在那台机器上成立，
// 而且清洗脚本会把绝对路径换成占位符，于是代码里出现 <本仓库> 这种目录名，直接崩。
import { fileURLToPath as __f } from 'node:url';
import { dirname as __d, join as __j } from 'node:path';
const REPO_ROOT = __j(__d(__f(import.meta.url)), '../..');

import { detectEol } from '../eol.mjs';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const FILE = `${REPO_ROOT}/cyrene-agent/worldbook/entries.yaml`;

const argv = process.argv.slice(2);
const argOf = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? null : (argv[at + 1] ?? null);
};
const DRY = argv.includes('--dry');
const removeIds = (argOf('--remove') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const appendFiles = [];
for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--append') appendFiles.push(argv[i + 1]);

if (removeIds.length === 0 && appendFiles.length === 0) {
  console.error('用法：--remove a,b --append file.yaml [--append file2.yaml] [--dry]');
  process.exit(2);
}

const text = readFileSync(FILE, 'utf8');
// ⚠️ 这个工具曾经**把 45 行 CRLF 写成了 LF**。
//
// 原因是 `text.split('\n')` 会让每行留着结尾的 `\r`，`join('\n')` 又把它还原 ——
// 所以**老内容保住了** CRLF，而下面新渲染的条目全是 `\n`。混在一起，
// 而且没有任何东西发现，直到第 5 轮去数行尾才看出来（CRLF 少了 45 个）。
//
// 现在：split 用 `\r?\n`（把行尾丢掉），拼的时候统一用这个文件本来的 EOL。
// 工具没有立场去改一个文件的整体风格，它只该**不要在编辑的时候顺手改掉**。
const EOL = detectEol(text);
const lines = text.split(/\r?\n/);

// ── 按 `  - id: xxx` 切块。块从 id 行开始，到下一个 id 行（或文件末尾）为止。 ──
// id 在这里就抓出来存好。不要在后面用另一个正则重新匹配同一行 ——
// 上一个版本那么做，两个正则的容忍度不同（一个只要求有前缀，一个要求前缀后有内容），
// 遇到边界行就有一边返回 null，报的是「Cannot read properties of null」，
// 看不出是哪一行出的问题。
const starts = [];
for (let i = 0; i < lines.length; i += 1) {
  const match = /^ {2}- id: (.+?)\s*$/.exec(lines[i].replace(/\r$/, ''));
  if (match !== null) starts.push({ at: i, id: match[1] });
}
if (starts.length === 0) {
  console.error('✗ 一个条目都没找到，文件结构可能变了');
  process.exit(1);
}
const blocks = starts.map((start, i) => ({
  from: start.at,
  to: i + 1 < starts.length ? starts[i + 1].at : lines.length,
  id: start.id,
}));

const existing = new Set(blocks.map((b) => b.id));
for (const id of removeIds) {
  if (!existing.has(id)) {
    console.error(`✗ 要删的 ${id} 不在文件里`);
    process.exit(1);
  }
}

// ── 读追加的文件，逐个校验 ──
const parsedNew = [];
for (const file of appendFiles) {
  let doc;
  try {
    doc = yaml.load(readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`✗ ${file} 不是合法 YAML：${error.message}`);
    process.exit(1);
  }
  const list = Array.isArray(doc) ? doc : (Array.isArray(doc?.entries) ? doc.entries : null);
  if (list === null) {
    console.error(`✗ ${file} 既不是数组，也没有 entries 数组`);
    process.exit(1);
  }
  for (const [i, entry] of list.entries()) {
    const where = `${file} 第 ${i + 1} 条`;
    if (typeof entry?.id !== 'string' || entry.id.trim() === '') { console.error(`✗ ${where} 没有 id`); process.exit(1); }
    if (!Array.isArray(entry.triggers) || entry.triggers.length === 0) { console.error(`✗ ${entry.id} 没有 triggers`); process.exit(1); }
    if (!Number.isFinite(entry.priority)) { console.error(`✗ ${entry.id} 没有 priority`); process.exit(1); }
    if (typeof entry.text !== 'string' || entry.text.trim() === '') { console.error(`✗ ${entry.id} 没有 text`); process.exit(1); }
    // 正在被删掉的 id 可以重新用 —— 「替换」就是删了再加回来。
    if (existing.has(entry.id) && !removeIds.includes(entry.id)) { console.error(`✗ ${entry.id} 和现有条目重名`); process.exit(1); }
    parsedNew.push(entry);
  }
}
const newIds = parsedNew.map((e) => e.id);
if (new Set(newIds).size !== newIds.length) {
  console.error('✗ 追加的条目里有重复 id');
  process.exit(1);
}

// ── 同一个角色前缀下的 priority 必须是阶梯 ──
const byPrefix = new Map();
for (const entry of parsedNew) {
  const prefix = entry.id.replace(/-[^-]+$/, '');
  byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), entry]);
}
const ladderProblems = [];
for (const [prefix, list] of byPrefix) {
  if (list.length < 2) continue;
  const seen = new Map();
  for (const entry of list) {
    if (seen.has(entry.priority)) ladderProblems.push(`${prefix}：${entry.id} 和 ${seen.get(entry.priority)} 的 priority 都是 ${entry.priority}`);
    seen.set(entry.priority, entry.id);
  }
}
if (ladderProblems.length) {
  console.error('✗ priority 不是阶梯，同 priority 会让「分两轮给」退化成按 id 排序：');
  for (const p of ladderProblems) console.error('   ' + p);
  process.exit(1);
}

// ── 拼回文本：删掉指定块，其余原样保留 ──
const drop = new Set(removeIds);
const kept = [];
let cursor = 0;
for (const block of blocks) {
  if (!drop.has(block.id)) continue;
  // 连同块前的空行一起删，避免留下连续空行
  let from = block.from;
  while (from > cursor && lines[from - 1].trim() === '') from -= 1;
  kept.push(lines.slice(cursor, from).join(EOL));
  cursor = block.to;
}
kept.push(lines.slice(cursor).join(EOL));
let merged = kept.filter((s) => s !== '').join(EOL).replace(new RegExp('(?:\\r?\\n){3,}', 'g'), EOL + EOL).trimEnd();

// ── 追加新条目（自己序列化，保持 2 空格缩进和 >- 折叠块） ──
const rendered = parsedNew.map((entry) => {
  const triggers = entry.triggers.map((t) => String(t)).join(', ');
  const body = String(entry.text).trim().split(/\r?\n/).map((l) => '      ' + l.trim()).join(EOL);
  return `  - id: ${entry.id}${EOL}    triggers: [${triggers}]${EOL}    priority: ${entry.priority}${EOL}    text: >-${EOL}${body}`;
}).join(EOL + EOL);

const next = `${merged}${EOL}${EOL}  # ── 黄金裔拆分条目（一人多条，priority 阶梯，见文件头说明） ──${EOL}${EOL}${rendered}${EOL}`;
writeFileSync(DRY ? FILE + '.dry' : FILE, next);

// ── 复验：重新解析整个文件 ──
const check = yaml.load(readFileSync(DRY ? FILE + '.dry' : FILE, 'utf8'));
const finalIds = check.entries.map((e) => e.id);
console.log(`  删除 ${removeIds.length} 条，追加 ${parsedNew.length} 条`);
console.log(`  条目总数 ${blocks.length} → ${check.entries.length}`);
console.log(`  id 唯一：${new Set(finalIds).size === finalIds.length ? '是' : '否 ✗'}`);
const lengths = parsedNew.map((e) => e.text.length).sort((a, b) => a - b);
console.log(`  新条目长度 ${lengths[0]} ~ ${lengths[lengths.length - 1]} 字，中位 ${lengths[Math.floor(lengths.length / 2)]}`);
for (const [prefix, list] of [...byPrefix].sort()) {
  console.log(`    ${prefix.padEnd(12)} ${list.sort((a, b) => b.priority - a.priority).map((e) => e.priority).join(' / ')}`);
}
console.log(DRY ? '  （--dry：写到了 .dry，没动原文件）' : '  已写入 ' + FILE);
