/**
 * 报账 —— 把「世界书给了什么」和「她说了什么」对上，出一份报告。
 *
 * 用法：
 *   node tools/receipts.mjs                      # 用线上留痕 + 线上会话
 *   node tools/receipts.mjs --audit <file>       # 换一份留痕
 *   node tools/receipts.mjs --no-replies         # 只跑前两层（确定的那部分）
 *   node tools/receipts.mjs --issues             # 只印「该处理的」
 *   node tools/receipts.mjs --live               # 只看有对话内容的会话
 *   node tools/receipts.mjs --debug-join         # 排查：哪个会话找到了日志、接出几段回复
 *
 * ## 三层，可信度不一样，报告里分开写
 *
 * ① **命中**（`hits`）—— 确定。选择器自己的记录。
 * ② **送出**（`sent`）—— 确定。
 * ③ **用上**（引用痕迹）—— **估计**。判据是「条目正文和她回复的最长连续重合」，
 *    8 字以上算 quoted，6 字算 echoed。没检测到**不等于**没用上：
 *    一条讲关系基调的条目本来就不含会出现在回复里的词。
 *
 * 所以报告里第三层的小标题是「引用痕迹（估计）」，不是「使用率」。
 * 拿它淘汰条目之前，先看一眼那一条的正文长什么样。
 *
 * ## 怎么把「第几轮」和「她说了什么」对上
 *
 * 靠**第几个真实用户轮**，不靠时间戳（会漂），也不靠会话里的 `turn` 字段
 * （那是 DSH 自己的计数，和审计日志里的不是一回事）。
 *
 * 还有一点要记住：**日志里大部分是测试造的**（`session-a`…`session-f` 那批）。
 * 报告会把「有对话内容的会话」和「只有留痕的会话」分开报 —— 否则
 * 「121 条里只有 5 条用上了」这种结论会被测试数据污染成另一种意思。
 * `--live` 直接只看有对话内容的那几个会话。
 *
 * ⚠️ **对齐靠内容指纹（`fp`），不靠「第几轮」。** 留痕记的是当时那条用户消息的
 * 指纹，这里从会话日志重算同一份 —— 因为会话日志里的「用户消息」其实有三种来源
 * （`source.kind` 是 `user` / `time-context` / `plugin:…`），而两边数轮次的口径
 * 曾经不一致，错开一格就会让**所有条目都显示没被引用**。
 * 旧留痕没有 `fp`，只能退回序号对齐，`--debug-join` 会把这件事印出来。
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { aggregate, joinReplies, scoreUsage } from '../receipts-logic.mjs';
import { findSessionLogs } from '../session-index.mjs';
import { fingerprint } from '../worldbook.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');

function flag(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const next = process.argv[at + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

const AUDIT = String(flag('audit', join(HERE, '..', 'data', 'logs', 'worldbook.jsonl')));
const BOOK = String(flag('book', join(HERE, '..', 'dist', 'worldbook.json')));
const NO_REPLIES = flag('no-replies', false) === true;
const ONLY_ISSUES = flag('issues', false) === true;
/** 只看有对话内容的会话 —— 把历次测试跑出来的那批假会话挡在外面。 */
const ONLY_LIVE = flag('live', false) === true;
/** 排查对齐：哪个留痕会话找到了日志、接出几段回复。 */
const DEBUG_JOIN = flag('debug-join', false) === true;

/** 会话日志的读取底座在仓库根的 tools/ 里（三件套共用那一份）。 */
async function sessionReader() {
  const candidates = [
    join(HERE, '..', '..', 'tools', 'session-log.mjs'),
    join(HERE, '..', 'tools', 'session-log.mjs')
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return import(new URL(`file://${resolve(candidate)}`));
  }
  return null;
}

/**
 * 一份会话日志里，每个「有文本的用户轮」：指纹 + 她最后说了什么。
 *
 * ⚠️ **指纹的取数口径必须和 `worldbook.mjs` 里 `hitText` 完全一致** ——
 * 它取的是「最后一条 role=user、非插件注入、且有文本」的消息的原文，
 * 然后 `fingerprint()` 它。这里重算一遍，是因为留痕里只存了指纹。
 * 两边口径一旦分叉，症状是「所有条目都显示没被引用」。
 *
 * @param {string} file - 会话日志路径。
 * @param {object} reader - `tools/session-log.mjs`。
 * @param {(text: string) => string} fp - 指纹函数（和 worldbook.mjs 同一份）。
 * @returns {Promise<{turns: string[], replies: Map<string, string>}>} 对齐用的两份表。
 */
async function turnsOf(file, reader, fp) {
  const turns = [];
  const replies = new Map();
  let pendingText = '';
  let currentFp = null;
  await reader.forEachLine(file, (o) => {
    const d = o.data ?? {};
    if (o.type === 'user/message') {
      // 收尾上一轮
      if (currentFp !== null) {
        if (pendingText !== '') replies.set(currentFp, pendingText);
        pendingText = '';
      }
      const content = d.content ?? [];
      const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('');
      const kind = String(d.source?.kind ?? '');
      // 插件注入的设定块不是用户说的话。现场是 `plugin:<包 id>`，
      // 早期写法是 `plugin` —— 两种都挡掉，口径要和 worldbook.mjs 一致。
      const injected = kind === 'plugin' || kind.startsWith('plugin:');
      // 工具结果也是 role=user，但它没有文本内容
      if (text.trim() === '' || injected) { currentFp = null; return; }
      currentFp = fp(text);
      turns.push(currentFp);
    } else if (o.type === 'assistant/message') {
      const content = d.message?.content ?? [];
      const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
      if (text !== '') pendingText = text;
    }
  });
  if (currentFp !== null && pendingText !== '') replies.set(currentFp, pendingText);
  return { turns, replies };
}

if (!existsSync(AUDIT)) {
  console.error(`找不到留痕：${AUDIT}`);
  process.exit(2);
}
const book = existsSync(BOOK) ? JSON.parse(readFileSync(BOOK, 'utf8')) : { entries: [] };
const records = readFileSync(AUDIT, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter(Boolean);

// ── 会话分组 ──
const bySession = new Map();
for (const record of records) {
  const id = String(record.session ?? '(无)');
  if (!bySession.has(id)) bySession.set(id, []);
  bySession.get(id).push(record);
}

// ── 把会话日志里的回复接上（可选）──
const reader = NO_REPLIES ? null : await sessionReader();
const sessionDirs = reader === null ? [] : findSessionLogs(HOME);

const repliesBySession = new Map();
let joinedAny = 0;
if (reader !== null) {
  for (const [id] of bySession) {
    const found = sessionDirs.find((entry) => entry.id === id);
    if (found === undefined) continue;
    const table = await turnsOf(found.file, reader, fingerprint);
    repliesBySession.set(id, table);
    joinedAny += 1;
  }
}

const withReplies = [];
const withoutReplySession = [];
const joinStats = { total: 0, byFingerprint: 0, positional: 0, unmatched: 0, fpMissing: 0 };
for (const [id, list] of bySession) {
  const table = repliesBySession.get(id);
  if (table === undefined) { withoutReplySession.push({ id, turns: list.length }); continue; }
  const { rows, stats } = joinReplies(list, table);
  withReplies.push(...rows);
  for (const key of Object.keys(joinStats)) joinStats[key] += stats[key] ?? 0;
}

if (DEBUG_JOIN) {
  console.log('# 对齐排查（--debug-join）');
  console.log('');
  console.log(`扫到的会话日志 ${sessionDirs.length} 份；留痕里的会话 ${bySession.size} 个`);
  console.log('');
  console.log('  | 留痕里的会话 | 轮次 | 找到日志 | 有文本的用户轮 | 对上的轮 |');
  console.log('  |---|---:|---|---:|---:|');
  for (const [id, list] of bySession) {
    const found = sessionDirs.find((entry) => entry.id === id);
    const table = repliesBySession.get(id);
    const where = found === undefined ? '没有' : found.workspace;
    const { stats } = table === undefined ? { stats: null } : joinReplies(list, table);
    console.log(`  | \`${id.slice(0, 28)}\` | ${list.length} | ${where} | ${table === undefined ? '—' : table.turns.length} | ${stats === null ? '—' : stats.byFingerprint} |`);
  }
  const unmatched = sessionDirs.filter((entry) => !bySession.has(entry.id));
  if (unmatched.length > 0) {
    console.log('');
    console.log(`另外还有 ${unmatched.length} 份日志在留痕里没有对应记录（多半是别的档的会话，她没参与）：`);
    for (const entry of unmatched.slice(0, 10)) console.log(`- \`${entry.id.slice(0, 28)}\`（${entry.workspace}）`);
  }
  console.log('');
  console.log('对齐方式统计（决定第三层能不能信）：');
  console.log(`  按内容指纹对上   ${joinStats.byFingerprint}`);
  console.log(`  退回序号对齐     ${joinStats.positional}   ← 留痕里没有 fp，位置未必对`);
  console.log(`  没对上           ${joinStats.unmatched}`);
  console.log(`  留痕缺 fp        ${joinStats.fpMissing}   ← 2026-10-10 之前的记录都没有`);
  console.log('');
  if (joinStats.fpMissing > 0 && joinStats.byFingerprint === 0) {
    console.log('⚠️ 全部靠序号对齐 —— 这时第三层只能当参考，不能拿来淘汰条目。');
    console.log('   新留痕会带 fp，跑几轮真对话之后再看这份报告。');
    console.log('');
  }
}

// `--live`：只统计能接上对话内容的会话。测试造的那些假会话没有对应日志，
// 于是被自然挡在外面 —— 这比按 id 打头过滤结实（测试换个 id 也不会漏进来）。
const counted = ONLY_LIVE && withReplies.length > 0 ? withReplies : records;
const all = aggregate(counted, book);
const live = aggregate(withReplies.length > 0 ? withReplies : records, book);
const usage = withReplies.length > 0 ? scoreUsage(withReplies, book) : [];
const usageById = new Map(usage.map((row) => [row.id, row]));

// ── 打印 ──
const n = (value) => String(value);
console.log('# 报账 · 世界书');
console.log('');
console.log(`留痕：${AUDIT}`);
console.log(`世界书：${book.entries?.length ?? 0} 条受触发 + ${book.always?.length ?? 0} 条常驻`);
console.log('');
console.log('## 总账（全部会话）');
console.log('');
console.log(`  有留痕的轮次      ${n(all.totals.turns)}`);
console.log(`  其中命中了设定    ${n(all.totals.turnsWithHit)}`);
console.log(`  其中真的注入了    ${n(all.totals.turnsWithSend)}`);
console.log(`  因窗口挡下的次数  ${n(all.totals.droppedRecent)}`);
console.log(`  因条数/预算挡下   ${n(all.totals.droppedOver)}`);
if (all.totals.escalatedTurns.length > 0) {
  // 兜底的那几轮是「没有新东西可给，把刚说过的又给了一次」，和正常注入不是一回事 ——
  // 单独报，否则它会混在「真的注入了 N 轮」里，看的人以为都是新东西。
  console.log(`  窗口耗尽而兜底    ${n(all.totals.escalatedTurns.length)} 轮  ← 没有新东西可给，把刚说过的再给了一次`);
}
console.log(`  出过场的条目      ${n(all.totals.entriesSeen)} / ${n(all.totals.entriesInBook)}`);
if (all.totals.unknownIds.length > 0) {
  console.log(`  ⚠️ 留痕里有库里没有的 id：${all.totals.unknownIds.join(', ')}`);
}
console.log('');
console.log(`  会话数            ${n(bySession.size)}`);
console.log(`  能接上对话内容的  ${n(joinedAny)} 个（接了 ${n(withReplies.length)} 轮）`);
if (withoutReplySession.length > 0) {
  const sample = withoutReplySession.slice(0, 6).map((row) => `${row.id}(${row.turns}轮)`).join('、');
  console.log(`  只有留痕的        ${n(withoutReplySession.length)} 个 ← 多半是测试造的：${sample}${withoutReplySession.length > 6 ? ' …' : ''}`);
}
console.log('');

if (!ONLY_ISSUES) {
  const top = all.sent.filter((row) => row.sent >= 2).slice(0, 15);
  if (top.length > 0) {
    console.log('## 出过场最多的条目');
    console.log('');
    console.log('  | 条目 | 命中 | 送出 | 被挡下 |');
    console.log('  |---|---:|---:|---|');
    for (const row of top) {
      const drops = Object.entries(row.drops).map(([why, count]) => `${why}×${count}`).join(' ') || '—';
      console.log(`  | \`${row.id}\` | ${row.hits} | ${row.sent} | ${drops} |`);
    }
    console.log('');
  }
}

if (all.firedNeverSent.length > 0) {
  console.log('## ⚠️ 命中过、但从没送出去过');
  console.log('');
  console.log('触发了却永远进不去。看「被挡下的原因」：`recent` 居多 = 去重窗口太宽；');
  console.log('`over-limit` / `over-budget` 居多 = priority 阶梯没拉开（同优先级会退化成按 id 排）。');
  console.log('');
  console.log('⚠️ **这张表是历史，不会因为你改了数据而更新。** 命中和送出是当时写进留痕的，');
  console.log('   而 priority / 触发词是从**现在的**世界书里读的 —— 所以「改了却没消失」是正常的，');
  console.log('   要改了之后真的聊一轮，那条才会从这张表里出去。');
  console.log('');
  console.log('  | 条目 | 命中 | 被挡下的原因 | priority | 触发词 |');
  console.log('  |---|---:|---|---:|---|');
  for (const row of all.firedNeverSent.slice(0, 30)) {
    const drops = Object.entries(row.drops).map(([why, count]) => `${why}×${count}`).join(' ');
    console.log(`  | \`${row.id}\` | ${row.hits} | ${drops} | ${row.priority ?? '—'} | ${(row.triggers ?? []).slice(0, 3).join('、')} |`);
  }
  console.log('');
}

if (all.neverFired.length > 0) {
  console.log('## 一次都没响过的条目');
  console.log('');
  console.log('不是「条目死了」——只说明到这份留痕为止还没人问到。');
  console.log('但如果连测试用例都没扫到它，就该怀疑触发词覆盖不够。');
  console.log('');
  console.log('  | 条目 | priority | 触发词 |');
  console.log('  |---|---:|---|');
  for (const row of all.neverFired.slice(0, 40)) {
    console.log(`  | \`${row.id}\` | ${row.priority ?? '—'} | ${(row.triggers ?? []).slice(0, 4).join('、') || '（无）'} |`);
  }
  if (all.neverFired.length > 40) console.log(`  …还有 ${all.neverFired.length - 40} 条`);
  console.log('');
}

if (usage.length > 0) {
  console.log('## 引用痕迹（估计，不是事实）');
  console.log('');
  console.log('判据：条目正文与她那轮回复的最长**连续**重合。8 字以上 = quoted，6 字 = echoed，');
  console.log('4 字 = topical（只算同话题，不算证据）。**「没检测到」不等于「没用上」** ——');
  console.log('讲关系基调的条目不含有会出现在回复里的词，这是这条判据的已知盲区。');
  console.log('');
  console.log(`能接上回复的轮次：${live.totals.turns}（其余会话没有对应的会话日志）`);
  console.log('');
  console.log('  | 条目 | 送出（有回复的轮） | quoted | echoed | 证据示例 |');
  console.log('  |---|---:|---:|---:|---|');
  for (const row of usage.slice(0, 25)) {
    const sample = row.samples[0] ?? '';
    console.log(`  | \`${row.id}\` | ${row.sentWithReply} | ${row.quoted} | ${row.echoed} | ${sample} |`);
  }
  console.log('');
  const missed = usage.filter((row) => row.sentWithReply > 0 && row.quoted === 0 && row.echoed === 0);
  if (missed.length > 0) {
    console.log(`### 送出去了、但一点引用痕迹都没有（${missed.length} 条）`);
    console.log('');
    for (const row of missed) {
      const entry = (book.entries ?? []).find((item) => item.id === row.id);
      console.log(`- \`${row.id}\` — 送 ${row.sentWithReply} 轮，最长重合都不到 6 字`);
      if (entry !== undefined) console.log(`  ${String(entry.text ?? '').slice(0, 70)}…`);
    }
    console.log('');
  }
}

void usageById;
