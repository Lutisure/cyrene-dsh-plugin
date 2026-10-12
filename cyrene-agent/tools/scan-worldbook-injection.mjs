/**
 * 命令行入口：扫一遍世界书，看有没有不该出现的东西。
 *
 * 判定逻辑在 ../worldbook-injection.mjs —— 抽出去是为了让评测台也能跑它。
 * 这个脚本现在只是打印那一份结果。
 *
 * 用法：node tools/scan-worldbook-injection.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

// ---- 仓库根，从本文件的位置推（由 tools/derive-roots.mjs 加的头）----
//
// 以前这里写的是作者机器上的绝对路径。那只在那台机器上成立，
// 而且清洗脚本会把绝对路径换成占位符，于是代码里出现 <本仓库> 这种目录名，直接崩。
import { fileURLToPath as __f } from 'node:url';
import { dirname as __d, join as __j } from 'node:path';
const REPO_ROOT = __j(__d(__f(import.meta.url)), '../..');

import { scanEntries, describeFindings } from '../worldbook-injection.mjs';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const ROOT = `${REPO_ROOT}/cyrene-agent`;
const book = yaml.load(readFileSync(`${ROOT}/worldbook/entries.yaml`, 'utf8'));
const entries = [...(book.always ?? []), ...(book.entries ?? [])];

const { findings, checked } = scanEntries(entries);
process.stdout.write(`\n  扫了 ${checked} 条\n`);
if (findings.length === 0) {
  process.stdout.write('  没有发现可疑的。\n\n');
} else {
  process.stdout.write('\n' + describeFindings(findings) + '\n\n');
  for (const f of findings) process.stdout.write(`    ${f.kind.padEnd(20)} ${f.id.padEnd(24)} ${f.detail}\n`);
  process.stdout.write('\n');
}

// 附：验证「用户输入不参与渲染」这个假设 —— 它是假设，不是显然的事。
const worldbook = readFileSync(`${ROOT}/worldbook.mjs`, 'utf8');
const logic = readFileSync(`${ROOT}/worldbook-logic.mjs`, 'utf8');
const renderUsesText = /renderBlock\([^)]*message/.test(worldbook + logic);
process.stdout.write(`  用户问句参与渲染吗：${renderUsesText ? '参与了 —— 要人工看' : '没有（渲染只吃条目列表）'}\n`);

// 附：审计日志里有没有用户文本。设计上不该有，但设计不等于事实。
const logPath = `${ROOT}/data/logs/worldbook.jsonl`;
if (existsSync(logPath)) {
  const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  const keys = new Set();
  for (const line of lines.slice(-200)) {
    try { for (const k of Object.keys(JSON.parse(line))) keys.add(k); } catch {}
  }
  const leaky = [...keys].filter((k) => /text|message|ask|query|input|prompt/i.test(k));
  process.stdout.write(`  审计日志 ${lines.length} 行，字段：${[...keys].join(', ')}\n`);
  process.stdout.write(`  疑似含原文的字段：${leaky.length ? leaky.join(', ') : '无'}\n\n`);
} else {
  process.stdout.write('  审计日志还没有\n\n');
}
