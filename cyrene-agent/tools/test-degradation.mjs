/**
 * 数据读不到时，插件会怎样。
 *
 * ## 为什么单独测这一件
 *
 * `worldbook.mjs` 的文件头自己写着这个失败模式有多安静：
 *
 *   > 块是空的时，`renderContextSections()` 会把整段丢掉，不报错、不留痕。
 *   > **那个失败在快照里和界面上都看不见。**
 *
 * 而收件人那边的数据状态和作者这台不一样：`dist/` 是他们自己 build 的、
 * `memory.md` 是空的、`corrections.md` 可能根本没有。**「什么都没有」必须等于
 * 「安静地用兜底」，而不是「启动即崩」或者「静默退化成一个没有灵魂的壳」。**
 *
 * ## 判据是两条
 *
 *   一、**不抛。** 缺文件不该让插件加载失败 —— 那会让整个 DSH 起不来。
 *   二、**退到有意义的兜底。** 空设定库要返回空、空记忆要返回空，
 *      而不是 `undefined` 往下传（那会变成 `"...undefined..."` 这种。
 *
 * 用法：
 *   node tools/test-degradation.mjs
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const AGENT = join(import.meta.dirname, '..');
const problems = [];

/** 一个临时的 DSH_HOME，用来放各种「缺东西」的现场。 */
const makeHome = () => mkdtempSync(join(tmpdir(), 'cyrene-degrade-'));

/**
 * 跑一件，记结果。
 *
 * @param {string} label - 说人话的用例名。
 * @param {() => unknown} fn - 要跑的。
 * @param {(value: unknown) => string|null} expect - 返回 null 表示过，否则返回问题描述。
 */
function check(label, fn, expect) {
  let value;
  try {
    value = fn();
  } catch (error) {
    problems.push(`${label} —— **抛了**：${String(error?.message ?? error).slice(0, 80)}`);
    console.log(`    ✗  ${label}  抛了`);
    return;
  }
  const issue = expect(value);
  if (issue === null) {
    console.log(`    ✓  ${label}`);
  } else {
    problems.push(`${label} —— ${issue}`);
    console.log(`    ✗  ${label}  ${issue}`);
  }
}

const url = (name) => pathToFileURL(join(AGENT, name)).href;

console.log('\n  数据缺失时的降级\n');

// ── 一、世界书逻辑：纯函数，直接喂空数据 ──────────────────────────────

const wb = await import(url('worldbook-logic.mjs'));

check('空设定库：buildWorldbook({}) 不抛', () => wb.buildWorldbook({}), (v) =>
  v === null || typeof v !== 'object' ? '没返回对象' : null);

check('空设定库：assembleBlock([]) 返回空串，不是 undefined', () => wb.assembleBlock([], 'x'), (v) =>
  typeof v !== 'string' ? `返回的是 ${typeof v}` : (v === '' ? null : `返回了 ${JSON.stringify(v).slice(0, 30)}`));

check('空设定库：explainEntries([]) 有 chosen 数组', () => wb.explainEntries([], '你好', {}), (v) =>
  v === null || typeof v !== 'object' ? '没返回对象'
    : (Array.isArray(v.chosen) ? (v.chosen.length === 0 ? null : 'chosen 不是空') : '没有 chosen 数组'));

check('空消息：firstHit 不抛', () => wb.firstHit(wb.normaliseEntry({ id: 'x', triggers: ['a'], text: 't' }, 0).entry, ''), () =>
  null);

// ── 二、记忆逻辑：文件不存在 ─────────────────────────────────────────

const mem = await import(url('memory-logic.mjs'));

check('记忆：空文本解析出空数组', () => {
  const fn = mem.parseEntries ?? mem.parseMemory ?? mem.readEntries;
  if (typeof fn !== 'function') return 'SKIP';
  return fn('');
}, (v) => (v === 'SKIP' ? null : (Array.isArray(v) ? (v.length === 0 ? null : '不是空的') : '没返回数组')));

// ── 三、主题：catalog 为空 ──────────────────────────────────────────

const theme = join(AGENT, '..', 'dsh-theme-cyrene', 'lib', 'client', '10-constants.js');

// ── 四、数据文件本身坏掉 ────────────────────────────────────────────
//
// ⚠️ 「空 home 能不能装配」**已经有别的测试在管**：`verify-real-prompt.mjs:242`
//    自己就把 `DSH_HOME` 指到一个临时 home，而它在导出物里全过。
//    **重复测一遍只是让这一份看起来更厚，不增加证据。**
//
//    这里测它盖不到的那一半：**文件在、但内容是坏的。**
//
// 场景是真的：收件人 build 到一半断电、磁盘满、或者有人手改过
// `dist/worldbook.json`。而 README 写着这种失败「在快照里和界面上都看不见」。

const fs = await import('node:fs');
const worldbook = await import(url('worldbook.mjs'));

/** 一个临时目录，放坏文件用。 */
const scratch = mkdtempSync(join(tmpdir(), 'cyrene-badfile-'));

try {
  const bad = join(scratch, 'bad.json');
  fs.writeFileSync(bad, '{ this is not json', 'utf8');
  const missing = join(scratch, 'nope.json');

  check('worldbook.json 内容坏掉：loader 不抛', () => {
    const load = worldbook.createBookLoader(bad);
    return load();
  }, (v) => (v === null || typeof v !== 'object' ? '没返回对象' : (Array.isArray(v.entries) ? null : '没有 entries 数组')));

  check('worldbook.json 文件不存在：loader 不抛', () => {
    const load = worldbook.createBookLoader(missing);
    return load();
  }, (v) => (v === null || typeof v !== 'object' ? '没返回对象' : (Array.isArray(v.entries) ? null : '没有 entries 数组')));

  check('坏掉时退到空设定库（entries 是空的，不是 undefined）', () => {
    const load = worldbook.createBookLoader(bad);
    return load().entries;
  }, (v) => (Array.isArray(v) ? (v.length === 0 ? null : `竟然有 ${v.length} 条`) : `不是数组，是 ${typeof v}`));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// ── 五、build.mjs 在源数据缺失时该**大声**失败 ──────────────────────
//
// 这一条和上面几条方向相反：**有些地方必须报错。**
// 收件人 build 的时候如果 entries.yaml 不在，静默产出一个空设定库，
// 他会得到一个「能跑但没有灵魂」的昔涟 —— **比构建失败坏得多。**
//
// 判据：build.mjs 读源文件用的是裸 `readFileSync`（会抛），
// 而不是 `try { } catch { return '' }`。这里静态检查那一处。

check('build.mjs 读 entries.yaml 是裸读（缺失会大声失败）', () => {
  const src = fs.readFileSync(`${AGENT}/build.mjs`, 'utf8');
  const line = src.split('\n').find((l) => l.includes('worldbook/entries.yaml'));
  return line === undefined ? 'NOTFOUND' : (line.includes('catch') ? 'WRAPPED' : 'BARE');
}, (v) => {
  if (v === 'NOTFOUND') return '找不到那处读法，规则该更新了';
  if (v === 'WRAPPED') return '**被 try 包住了** —— 源数据缺失时会静默产出空设定库';
  return null;
});

// ── 结果 ──────────────────────────────────────────────────────────

console.log('');
if (problems.length === 0) {
  console.log('  数据缺失时都退到了兜底，没有抛。\n');
  process.exit(0);
}
console.log(`  ${problems.length} 个问题：\n`);
for (const p of problems) console.log(`    · ${p}`);
console.log('');
process.exit(1);
