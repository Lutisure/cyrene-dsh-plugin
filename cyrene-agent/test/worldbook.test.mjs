/**
 * Worldbook matching tests.
 *
 * These exercise the pure layer only — no DSH, no session, no model. That is the
 * point of splitting it out: the rules that decide *what gets injected* are
 * where the bugs are, and they can be pinned down exhaustively here.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assembleBlock,
  buildWorldbook,
  createInjectionLog,
  explainEntries,
  firstHit,
  normalise,
  normaliseEntry,
  selectEntries
} from '../worldbook-logic.mjs';

/** Build a book from raw entries. */
function bookOf(entries, always) {
  return buildWorldbook({ always, entries });
}

test('normalise folds case, full-width forms and ideographic spaces', () => {
  assert.equal(normalise('CYRENE'), 'cyrene');
  assert.equal(normalise('星穹铁道！'), '星穹铁道!');
  assert.equal(normalise('ＡＢＣ'), 'abc');
  assert.equal(normalise('a\u3000b'), 'a b');
  assert.equal(normalise(null), '');
});

test('an entry missing id, text or triggers is skipped with a reason', () => {
  const { entry: noId } = normaliseEntry({ text: 'x', triggers: ['a'] }, 0);
  assert.equal(noId, null);
  const { entry: noText } = normaliseEntry({ id: 'a', triggers: ['a'] }, 0);
  assert.equal(noText, null);
  const { entry: noTriggers } = normaliseEntry({ id: 'a', text: 'x', triggers: [] }, 0);
  assert.equal(noTriggers, null);
  // A usable entry keeps its priority, and defaults it to 0 when absent.
  const { entry } = normaliseEntry({ id: 'a', text: 'x', triggers: [' t '] }, 0);
  assert.equal(entry.priority, 0);
  assert.deepEqual(entry.triggers, ['t']);
});

test('a malformed entry is skipped, never fatal', () => {
  // A worldbook is data. One bad row must not take down every session that
  // touches the preset, so problems are collected rather than thrown.
  const book = bookOf([null, { id: 'ok', text: 'fine', triggers: ['ok'] }, 42]);
  assert.equal(book.entries.length, 1);
  assert.equal(book.problems.length, 2);
  assert.ok(book.problems[0].includes('entries:'));
});

test('the earliest trigger wins, which is what ranks a mention', () => {
  const entry = normaliseEntry({ id: 'a', text: 'x', triggers: ['后', '前'] }, 0).entry;
  assert.equal(firstHit(entry, normalise('前……后')), 0);
  assert.equal(firstHit(entry, normalise('没有命中')), -1);
});

/* ── 通配符 `*`：名字和「方面」之间能插进去的东西太多 ──────────────────────── */

test('通配符：`名字*方面` 吃掉中间的语气词', () => {
  // 这三个是同一件事的三种说法，而它们的串**互不包含** ——
  // 这就是当初「只写 `白厄孤独`」修不好的原因。
  const entry = normaliseEntry({ id: 'a', text: 'x', triggers: ['白厄*孤独'] }, 0).entry;
  for (const ask of ['白厄是不是很孤独', '白厄真的很孤独吗', '白厄为什么这么孤独', '白厄孤独']) {
    assert.ok(firstHit(entry, normalise(ask)) !== -1, ask);
  }
});

test('通配符：不跨句读，也不跨到别的角色身上', () => {
  const entry = normaliseEntry({ id: 'a', text: 'x', triggers: ['白厄*孤独'] }, 0).entry;
  // 逗号里的插语还算同一句
  assert.ok(firstHit(entry, normalise('白厄，好像一直很孤独')) !== -1);
  // 句号之后就不算了 —— 否则这个触发词会变成很弱的条件
  assert.equal(firstHit(entry, normalise('白厄说完了。孤独是自己选的')), -1);
  // 别人孤独的时候不许响
  assert.equal(firstHit(entry, normalise('万敌是不是很孤独')), -1);
});

test('通配符：吃得下的字符数是有限的（12 个）', () => {
  const entry = normaliseEntry({ id: 'a', text: 'x', triggers: ['甲*乙'] }, 0).entry;
  assert.ok(firstHit(entry, normalise(`甲${'丙'.repeat(12)}乙`)) !== -1, '12 个以内要命中');
  assert.equal(firstHit(entry, normalise(`甲${'丙'.repeat(13)}乙`)), -1, '超过就当作没命中');
});

test('通配符：写成 `*` 或 `甲**乙` 的触发词直接作废', () => {
  // 这两种写法等于「匹配任何东西」—— 进了选择器就是每一轮都命中。
  // 一开始的做法是「退化成普通串」，而那条路更糟：`*` 去掉星号之后变成**空串**，
  // 空串配 `indexOf` 恒等于 0，还是每一句都命中。
  //
  // 现在的选择是**整条条目作废并报出来**，而不是「丢掉坏的那条、留着好的」。
  // 理由：那两类行为在报告里长得一样（都是「这条没生效」），而严重程度差一个量级 ——
  // 一个是「作者写错了」，另一个是「这条设定静默地不见了」。宁可吵。
  assert.equal(normaliseEntry({ id: 'b', text: 'x', triggers: ['*'] }, 0).entry, null);
  assert.match(normaliseEntry({ id: 'b', text: 'x', triggers: ['*'] }, 0).problem, /wildcard-only/u);
  assert.equal(normaliseEntry({ id: 'b', text: 'x', triggers: ['甲**乙'] }, 0).entry, null);
  assert.match(normaliseEntry({ id: 'b', text: 'x', triggers: ['甲**乙'] }, 0).problem, /wildcard-only/u);
  // 一条坏触发词会把**整条条目**带走，哪怕旁边还有好的 —— 这是刻意的
  assert.equal(normaliseEntry({ id: 'c', text: 'x', triggers: ['*', '甲'] }, 0).entry, null);
});

test('通配符：触发词里的正则元字符要当字面量', () => {
  // 不带 `*` 的走 indexOf，带 `*` 的走正则 —— 后者如果忘了转义，
  // `.` 会变成「任意一个字符」，静默地放宽触发条件。
  const entry = normaliseEntry({ id: 'a', text: 'x', triggers: ['甲*乙(丙)'] }, 0).entry;
  assert.ok(firstHit(entry, normalise('甲和乙(丙)')) !== -1);
  assert.equal(firstHit(entry, normalise('甲和乙X丙Y')), -1, '括号不该被当成分组');
});

test('higher priority wins even when it is mentioned later', () => {
  const book = bookOf([
    { id: 'low', text: 'L', triggers: ['话题'], priority: 10 },
    { id: 'high', text: 'H', triggers: ['话题'], priority: 90 }
  ]);
  const chosen = selectEntries(book.entries, '聊聊话题');
  assert.deepEqual(chosen.map((entry) => entry.id), ['high', 'low']);
});

test('equal priority falls back to the earlier mention, then to id', () => {
  const book = bookOf([
    { id: 'b', text: 'B', triggers: ['晚'], priority: 5 },
    { id: 'a', text: 'A', triggers: ['早'], priority: 5 },
    { id: 'c', text: 'C', triggers: ['早'], priority: 5 }
  ]);
  // 早 is mentioned before 晚, so both 早 entries outrank it; between them the
  // tie breaks on id so the order does not depend on document order.
  assert.deepEqual(
    selectEntries(book.entries, '早 晚').map((entry) => entry.id),
    ['a', 'c', 'b']
  );
});

test('both caps apply: entry count and character budget', () => {
  const book = bookOf([
    { id: 'a', text: 'x'.repeat(100), triggers: ['t'], priority: 3 },
    { id: 'b', text: 'x'.repeat(100), triggers: ['t'], priority: 2 },
    { id: 'c', text: 'x'.repeat(100), triggers: ['t'], priority: 1 }
  ]);
  assert.equal(selectEntries(book.entries, 't', { limit: 2 }).length, 2);
  // A budget too small for two entries admits only one, rather than blowing it.
  assert.equal(selectEntries(book.entries, 't', { budget: 150 }).length, 1);
  // An entry that cannot fit is skipped, not used to stop the scan: a shorter
  // lower-priority entry behind it should still get its turn.
  const mixed = bookOf([
    { id: 'big', text: 'x'.repeat(400), triggers: ['t'], priority: 9 },
    { id: 'small', text: 'y'.repeat(20), triggers: ['t'], priority: 1 }
  ]);
  assert.deepEqual(selectEntries(mixed.entries, 't', { budget: 60 }).map((e) => e.id), ['small']);
});

test('nothing is injected for an empty or unmatched message', () => {
  const book = bookOf([{ id: 'a', text: 'x', triggers: ['星'] }]);
  assert.deepEqual(selectEntries(book.entries, ''), []);
  assert.deepEqual(selectEntries(book.entries, '   '), []);
  assert.deepEqual(selectEntries(book.entries, '完全无关'), []);
});

test('the skip set suppresses entries already sent in this session', () => {
  const book = bookOf([
    { id: 'a', text: 'x', triggers: ['t'], priority: 2 },
    { id: 'b', text: 'y', triggers: ['t'], priority: 1 }
  ]);
  const chosen = selectEntries(book.entries, 't', { skip: new Set(['a']) });
  assert.deepEqual(chosen.map((entry) => entry.id), ['b']);
});

test('assembleBlock renders nothing for nothing, and includes the heading otherwise', () => {
  assert.equal(assembleBlock([], '【x】'), '');
  assert.equal(assembleBlock(null), '');
  const text = assembleBlock([{ id: 'a', text: '条目正文' }], '【设定】');
  assert.ok(text.startsWith('【设定】'));
  assert.ok(text.includes('条目正文'));
});

test('the injection log remembers per session and can forget', () => {
  const log = createInjectionLog();
  assert.equal(log.seen('s1', 'a'), false);
  log.record('s1', ['a']);
  assert.equal(log.seen('s1', 'a'), true);
  // Recording is per session: another conversation is unaffected.
  assert.equal(log.seen('s2', 'a'), false);
  log.forget('s1');
  assert.equal(log.seen('s1', 'a'), false);
});

test('窗口按**墙上时间**走，而且是「十分钟内说过就不再重复」', () => {
  // ⚠️ 这里原来测的是「差几轮」。改成时间之后，这个用例守的东西变清楚了：
  // 时间没过窗口 → 跳过；过了 → 放行。而**轮号完全不参与判断** ——
  // 那正是第二个 bug 的来源（重启后轮号从 1 重来，旧编号一减成负数，
  // 那几条就被无限期当成「刚说过」）。
  let clock = 1_000_000;
  const log = createInjectionLog({ windowMs: 10 * 60 * 1000, now: () => clock });

  log.nextTurn('s1');
  log.record('s1', ['a']);
  assert.equal(log.seen('s1', 'a'), true, '同一轮内当然算说过');

  clock += 9 * 60 * 1000;
  assert.equal(log.seen('s1', 'a'), true, '九分钟后：还在窗口里');

  clock += 2 * 60 * 1000;
  assert.equal(log.seen('s1', 'a'), false, '十一分钟后：过了窗口就该能再触发');
});

test('⚠️ 轮号被推乱之后，判断仍然只看时间（这是这次修的 bug）', () => {
  // 现场：同一个会话在重启/重载之后 `state.turn` 从 1 重新开始，而 `sent` 里
  // 还记着旧编号（实测：新留痕 turn=1，而挡下的那几条是上一轮发的，编号 8）。
  // 老实现用 `turn - at <= recent` 判断，一减是负数、永远成立 ——
  // 于是那些条目在重启后的每一轮都被当成「刚说过」，**而它们根本没被重新发过**。
  //
  // 现在锚点是时间、不是轮号。这条用例守的就是这件事：先把轮号推到跟 sent
  // 记录完全无关的位置，再看判断是否照旧只认时间。
  let clock = 1_000_000;
  const log = createInjectionLog({ windowMs: 10 * 60 * 1000, now: () => clock });
  log.nextTurn('s1');
  log.record('s1', ['a']);

  for (let i = 0; i < 3; i += 1) log.nextTurn('s1'); // 轮号推到 4，sent 里仍是第 1 轮的时间戳
  clock += 20 * 1000;

  assert.equal(log.turn('s1'), 4, '轮号确实被推高了 —— 老实现会在这里判成 recent');
  assert.equal(log.seen('s1', 'a'), true, '半分钟前才说过，该跳过（这是时间说了算）');

  clock += 11 * 60 * 1000;
  assert.equal(log.seen('s1', 'a'), false, '过了窗口就放行，不会因为轮号错乱而卡住');
});

test('⚠️ 窗口不靠「有东西被选中的轮」前进（第一条死锁的回归线）', () => {
  // 老版本按「最近 N 条记录」滑窗，而 record() 只在有东西被选中时才被调用 ——
  // 于是同一批 id 永远留在窗口里，同一个人连问两次之后**永远返回空**。
  // 现在窗口是时间，跟「有没有东西被选中」彻底解耦：什么都不注入的轮，
  // 时间照样在走。
  let clock = 1_000_000;
  const log = createInjectionLog({ windowMs: 60 * 1000, now: () => clock });
  log.nextTurn('s1');
  log.record('s1', ['a']);

  for (let turn = 2; turn <= 5; turn += 1) {
    clock += 10 * 1000;
    log.nextTurn('s1'); // 什么都没注入
    assert.equal(log.seen('s1', 'a'), turn <= 6 ? true : false, `第 ${turn} 轮`);
  }
  clock += 30 * 1000; // 累计 70 秒 > 60 秒窗口
  assert.equal(log.seen('s1', 'a'), false, '窗口必须已经走完，老版本在这里会永远停在「说过」');
});

test('窗口耗尽时有兜底：一条新的都没进来，就从窗口里升两条上来', () => {
  // 为什么要这个：窗口从「几轮」改成「几分钟」之后，多出一个失效方式 ——
  // 窗口里全被挡住，这一轮什么都不给。而「一个人拆 6 条、分两轮给完」
  // 这个设计本意就是让人连问同一话题时**总有东西可给**。
  //
  // 兜底有上限（ESCALATE_LIMIT = 2 < limit = 3），留一个位置给真正新的条目。
  const book = bookOf([
    { id: 'a', text: 'A', triggers: ['话题'], priority: 90 },
    { id: 'b', text: 'B', triggers: ['话题'], priority: 80 },
    { id: 'c', text: 'C', triggers: ['话题'], priority: 70 },
    { id: 'd', text: 'D', triggers: ['话题'], priority: 60 }
  ]);
  const decision = explainEntries(book.entries, '话题', { skip: new Set(['a', 'b', 'c', 'd']) });

  assert.deepEqual(decision.chosen.map((e) => e.id), ['a', 'b'], '升上来的是排名最高的两条');
  assert.deepEqual(decision.escalated.map((e) => e.id), ['a', 'b'], '而且要单独标出来');
  // 留痕要能分辨「因为刚说过而没给」和「因为刚说过、但只好再说一次」
  const reasons = new Map(decision.dropped.map((item) => [item.entry.id, item.reason]));
  assert.equal(reasons.get('a'), 'window-exhausted');
  assert.equal(reasons.get('b'), 'window-exhausted');
  assert.equal(reasons.get('c'), 'recent', '没升上来的仍然是「刚说过」');
  assert.equal(reasons.get('d'), 'recent');
});

test('窗口耗尽**不是**「只要有东西被挡住就兜底」', () => {
  // 这条守的是兜底的触发条件：只有「一条新的都没进来」才兜底。
  // 有新的可给时，被挡住的那些必须老老实实待着 —— 否则窗口就白设了。
  const book = bookOf([
    { id: 'a', text: 'A', triggers: ['话题'], priority: 90 },
    { id: 'b', text: 'B', triggers: ['话题'], priority: 80 }
  ]);
  const decision = explainEntries(book.entries, '话题', { skip: new Set(['a']) });
  assert.deepEqual(decision.chosen.map((e) => e.id), ['b'], '有新的就给新的');
  assert.deepEqual(decision.escalated, [], '没有兜底发生');
  assert.equal(decision.dropped.find((item) => item.entry.id === 'a').reason, 'recent');
});

test('the injection log does not grow without bound', () => {
  let clock = 1_000_000;
  const log = createInjectionLog({ windowMs: 60 * 1000, now: () => clock });
  for (let index = 0; index < 50; index += 1) {
    clock += 5 * 1000; // 每轮 5 秒，全部落在同一个窗口里
    log.nextTurn('s1');
    log.record('s1', [`entry-${index}`]);
  }
  // 窗口一过，早先那些都该被清掉
  clock += 10 * 60 * 1000;
  assert.equal(log.seen('s1', 'entry-0'), false);
  assert.equal(log.seen('s1', 'entry-49'), false, '过期就地清掉，不是留着不管');
});

test('the shipped worldbook compiles and holds no duplicate ids', () => {
  // Read the real build output, so a typo in entries.yaml fails here rather than
  // silently dropping lore at runtime. `node build.mjs` must have run.
  const root = dirname(fileURLToPath(import.meta.url));
  const file = join(root, '..', 'dist', 'worldbook.json');
  const compiled = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(compiled.always));
  assert.ok(Array.isArray(compiled.entries));
  assert.ok(compiled.entries.length >= 10, `expected a useful book, got ${compiled.entries.length}`);

  const ids = [...compiled.always, ...compiled.entries].map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate ids would make the de-duplication lie');

  // And every entry must still be usable by the matcher after the round trip.
  const book = buildWorldbook(compiled);
  assert.deepEqual(book.problems, []);
  assert.equal(book.entries.length, compiled.entries.length);
});

test('the shipped worldbook actually fires on a real line of hers', () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const compiled = JSON.parse(readFileSync(join(root, '..', 'dist', 'worldbook.json'), 'utf8'));
  const book = buildWorldbook(compiled);
  const chosen = selectEntries(book.entries, '伙伴，你还记得哀丽秘榭吗？');
  const ids = chosen.map((entry) => entry.id);
  assert.ok(ids.includes('partner'), `expected the address entry, got ${ids.join(', ')}`);
  assert.ok(ids.includes('amphoreus'), `expected the Amphoreus entry, got ${ids.join(', ')}`);
});


test('explainEntries says what was hit, what was sent, and why the rest was not', () => {
  const book = buildWorldbook({
    entries: [
      { id: 'a', triggers: ['主题'], priority: 60, text: '甲'.repeat(100) },
      { id: 'b', triggers: ['主题'], priority: 50, text: '乙'.repeat(100) },
      { id: 'c', triggers: ['主题'], priority: 40, text: '丙'.repeat(100) },
      { id: 'd', triggers: ['主题'], priority: 30, text: '丁'.repeat(100) },
      { id: 'e', triggers: ['主题'], priority: 20, text: '戊'.repeat(100) },
      { id: 'quiet', triggers: ['别的'], priority: 90, text: '不命中' }
    ]
  });
  const decision = explainEntries(book.entries, '主题是什么', { limit: 3, budget: 1000 });

  assert.deepEqual(decision.chosen.map((entry) => entry.id), ['a', 'b', 'c']);
  assert.deepEqual(decision.hits.map((entry) => entry.id), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(
    decision.dropped.map((item) => [item.entry.id, item.reason]),
    [['d', 'over-limit'], ['e', 'over-limit']]
  );
});

test('explainEntries records the two ways an entry can be held back', () => {
  const book = buildWorldbook({
    entries: [
      { id: 'big', triggers: ['主题'], priority: 80, text: '大'.repeat(900) },
      { id: 'small', triggers: ['主题'], priority: 70, text: '小'.repeat(100) },
      { id: 'old', triggers: ['主题'], priority: 90, text: '旧'.repeat(50) }
    ]
  });
  // 'old' 在去重窗口里；'big' 装不进 500 字预算，但**后面小的还能进** ——
  // 这正是「超预算用 continue 而不是 break」那条规则，写死成测试免得以后被改掉。
  const decision = explainEntries(book.entries, '主题是什么', { limit: 3, budget: 500, skip: new Set(['old']) });

  assert.deepEqual(decision.chosen.map((entry) => entry.id), ['small']);
  const why = Object.fromEntries(decision.dropped.map((item) => [item.entry.id, item.reason]));
  assert.equal(why.old, 'recent');
  assert.equal(why.big, 'over-budget');
});

test('selectEntries is the same decision as explainEntries', () => {
  // 两个实现会在第一次单独改其中一个的时候漂移开。留痕必须和选择器说同一件事。
  const book = buildWorldbook({
    entries: [
      { id: 'a', triggers: ['主题'], priority: 60, text: '甲'.repeat(100) },
      { id: 'b', triggers: ['主题'], priority: 50, text: '乙'.repeat(100) }
    ]
  });
  const options = { limit: 1 };
  assert.deepEqual(
    selectEntries(book.entries, '主题', options).map((entry) => entry.id),
    explainEntries(book.entries, '主题', options).chosen.map((entry) => entry.id)
  );
});