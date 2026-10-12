/**
 * 报账：世界书给了什么，她有没有用上。
 *
 * 这一层最难的不是聚合，是**别把估计当事实报**。所以测试分成三组：
 *
 * 1. 最长公共子串本身要对（它是整个第三层的量尺）
 * 2. 分档要落在该落的地方，尤其是「不该报成引用」的那些
 * 3. 聚合只做字面的事 —— 命中、送出、丢弃原因，一个字都不许猜
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CITATION,
  aggregate,
  citationOf,
  joinReplies,
  longestCommonRun,
  longestCommonSubstring,
  scoreUsage,
  skeleton
} from '../receipts-logic.mjs';

test('skeleton 把标点和空白去掉，汉字与数字留下', () => {
  assert.equal(skeleton('「白厄」是我\n认识的人。'), '白厄是我认识的人');
  assert.equal(skeleton(''), '');
  assert.equal(skeleton(null), '');
  assert.equal(skeleton('1、2、3'), '123');
});

test('LCS：空串、无重合、完全包含', () => {
  assert.deepEqual(longestCommonSubstring('', 'abc'), { length: 0, text: '' });
  assert.deepEqual(longestCommonSubstring('abc', ''), { length: 0, text: '' });
  assert.deepEqual(longestCommonSubstring('abcde', 'xyz'), { length: 0, text: '' });
  const contained = longestCommonSubstring('她在那片田野上奔跑', '田野');
  assert.equal(contained.length, 2);
  assert.equal(contained.text, '田野');
});

test('LCS：取的是**连续**的那一段，不是子序列', () => {
  // 'ABCDEF' 与 'ACEDF'：最长公共**子序列**是 4（ACDF），连续重合只有 1。
  // 这条钉的就是「别退化成子序列匹配」—— 退了，任何两段中文都能撞出高分。
  assert.equal(longestCommonRun('ABCDEF', 'ACEDF'), 1);
  assert.deepEqual(longestCommonSubstring('白厄是英雄', '英雄是白厄'), { length: 2, text: '英雄' });
});

test('LCS：长度只由字符决定，不受长短顺序影响', () => {
  const long = '那在哀丽秘榭的田野中奔跑的向着太阳欢笑的孩子';
  const short = '向着太阳欢笑的孩子';
  assert.equal(longestCommonRun(long, short), short.length);
  assert.equal(longestCommonRun(short, long), short.length);
});

test('判据：8 字以上算 quoted，6 字算 echoed，4 字只算 topical', () => {
  assert.equal(CITATION.quoted, 8);
  assert.equal(CITATION.echoed, 6);
  assert.equal(CITATION.topical, 4);

  // 这段手法值得说一句：**垫子用不相交的字符集**，被测的那段是唯一定长的一段。
  // 前面几版随手挑的两句中文总在别处又撞上几个字，测出来的长度比设计的长，
  // 于是断言的是一条根本没在设计里的线。用 a..j / k..t 两块垫子之后，
  // 「最长连续重合」只能来自被切开的那一段。
  const padA = 'abcdefgh';
  const padB = 'klmnopqr';
  const sample = (n) => {
    const shared = padA.slice(0, n);
    return citationOf(padA + shared, padB + shared);
  };

  assert.equal(sample(8).run, 8);
  assert.equal(sample(8).level, 'quoted');
  assert.equal(sample(7).level, 'echoed');
  assert.equal(sample(6).level, 'echoed');
  assert.equal(sample(5).level, 'topical');
  assert.equal(sample(4).level, 'topical');
  assert.equal(sample(3).level, 'none');
  assert.equal(sample(3).run, 3);

  // sample 要是**那一段本身**，不是随便一个同长度的串
  const quoted = citationOf('那在哀丽秘榭的田野中奔跑的向着太阳欢笑的孩子', '你说过的——「那在哀丽秘榭的田野中奔跑的」，我一直记得。');
  assert.equal(quoted.level, 'quoted');
  assert.equal(quoted.run, quoted.sample.length, 'sample 要和 run 一样长');
  assert.ok(
    '那在哀丽秘榭的田野中奔跑的向着太阳欢笑的孩子'.includes(quoted.sample),
    `sample 应当是条目里真实存在的一段：${quoted.sample}`
  );

  const none = citationOf('那在哀丽秘榭的田野中奔跑的向着太阳欢笑的孩子', '今天天气不错，要不要出去走走？');
  assert.equal(none.level, 'none');
  assert.equal(none.sample, '');
});

test('判据不会把「泛泛的中文」报成引用', () => {
  // 两段毫无关系的话，靠短 n-gram 会撞出一堆；LCS 应当很短
  const a = '他不信苦难能让人变好，将大家从苦难中解放出来正是黄金裔的职责。';
  const b = '今天聊点什么好呢？人家最近在读一本讲花的书，里面讲到种子怎么过冬。';
  assert.ok(longestCommonRun(skeleton(a), skeleton(b)) < CITATION.topical, '不该有 4 字以上的连续重合');
  assert.equal(citationOf(a, b).level, 'none');
});

test('聚合：只做字面的事 —— 命中、送出、丢弃原因', () => {
  const book = {
    entries: [
      { id: 'a', triggers: ['甲'], priority: 70, text: '甲的正文' },
      { id: 'b', triggers: ['乙'], priority: 60, text: '乙的正文' },
      { id: 'c', triggers: ['丙'], priority: 50, text: '丙的正文' },
      { id: 'd', triggers: ['丁'], priority: 40, text: '丁的正文' }
    ]
  };
  const records = [
    { session: 's', turn: 1, hits: ['a', 'b', 'c'], sent: ['a'], dropped: [{ id: 'b', why: 'over-limit' }, { id: 'c', why: 'over-limit' }], chars: 4 },
    { session: 's', turn: 2, hits: ['a'], sent: [], dropped: [{ id: 'a', why: 'recent' }], chars: 0 },
    { session: 's', turn: 3, hits: ['a'], sent: ['a'], dropped: [], chars: 4 }
  ];
  const result = aggregate(records, book);

  assert.equal(result.totals.turns, 3);
  assert.equal(result.totals.turnsWithHit, 3);
  assert.equal(result.totals.turnsWithSend, 2);
  assert.equal(result.totals.entriesInBook, 4);

  const byId = new Map(result.perEntry.map((row) => [row.id, row]));
  assert.equal(byId.get('a').hits, 3);
  assert.equal(byId.get('a').sent, 2);
  assert.equal(byId.get('a').drops.recent, 1);
  assert.equal(byId.get('b').hits, 1);
  assert.equal(byId.get('b').sent, 0);

  // b 命中过但从没送出去 —— 这一类要单独列出来
  assert.deepEqual(result.firedNeverSent.map((row) => row.id), ['b', 'c']);
  // c 也是；d 连命中都没有，而且它在库里 —— 要出现在「一次都没响过」里
  assert.ok(result.neverFired.some((row) => row.id === 'd'), '库里有但没响过的条目要列出来');
  assert.deepEqual(result.totals.unknownIds, []);
});

test('聚合：丢掉的条目在日志里是对象形状，也要认得', () => {
  // 早期的记录 `dropped` 里放的是 `{entry, at, reason}`（explainEntries 的原样输出）。
  // 两种形状都要吃，否则报账会在某一段历史上悄悄少数。
  const records = [
    {
      turn: 1,
      hits: ['x'],
      sent: [],
      dropped: [{ entry: { id: 'x' }, at: 3, reason: 'over-budget' }]
    }
  ];
  const result = aggregate(records, { entries: [{ id: 'x', triggers: [], text: 'x' }] });
  assert.equal(result.perEntry.find((row) => row.id === 'x').drops['over-budget'], 1);
});

test('聚合：命中了一个不在库里的 id，要报出来而不是吞掉', () => {
  const result = aggregate(
    [{ turn: 1, hits: ['ghost'], sent: ['ghost'], dropped: [] }],
    { entries: [] }
  );
  assert.deepEqual(result.totals.unknownIds, ['ghost']);
  assert.equal(result.perEntry[0].known, false);
});

test('聚合：兜底那几轮要单独报，不能混进「真的注入了」', () => {
  // 兜底的注入是「没有新东西可给，把刚说过的再给了一次」，和正常注入不是一回事。
  // 混在一起报的话，看的人会以为每一轮都在给新东西。
  const records = [
    { turn: 1, hits: ['a'], sent: ['a'], escalated: [], dropped: [] },
    { turn: 2, hits: ['a'], sent: ['a'], escalated: ['a'], dropped: [{ id: 'a', why: 'window-exhausted' }] },
    { turn: 3, hits: ['a'], sent: ['a'], escalated: ['a'], dropped: [{ id: 'a', why: 'window-exhausted' }] }
  ];
  const result = aggregate(records, { entries: [{ id: 'a', text: 'x', triggers: [], priority: 1 }] });
  assert.equal(result.totals.turnsWithSend, 3, '三轮都注入了东西');
  assert.equal(result.totals.escalatedTurns.length, 2, '其中两轮是兜底');
  assert.deepEqual(result.totals.escalatedTurns.map((row) => row.turn), [2, 3]);
  assert.equal(result.perEntry[0].drops['window-exhausted'], 2, '理由要能认出来');
});

test('对齐：按**内容指纹**配对，一轮错开不会波及后面', () => {
  // 会话里有 4 条用户文本，留痕只有 2 条 —— 而且第 2 条对应的是第 4 条文本。
  // 序号对齐会把「第 4 轮的回复」配给「第 2 条留痕」，然后全部错位。
  const table = {
    turns: ['aaaa', 'bbbb', 'cccc', 'dddd'],
    replies: new Map([['aaaa', '回给甲'], ['bbbb', '回给乙'], ['cccc', '回给丙'], ['dddd', '回给丁']])
  };
  const records = [
    { turn: 1, fp: 'aaaa', sent: ['x'] },
    { turn: 2, fp: 'dddd', sent: ['x'] }
  ];
  const { rows, stats } = joinReplies(records, table);
  assert.equal(rows[0].reply, '回给甲');
  assert.equal(rows[1].reply, '回给丁', '指纹对上了，就不该按序号拿「回给乙」');
  assert.equal(stats.byFingerprint, 2);
  assert.equal(stats.positional, 0);
  assert.equal(rows[0].turn, 1, '原字段不许被改掉');
});

test('对齐：旧留痕没有 fp 时退回序号，并把这件事记在 stats 里', () => {
  const records = [{ turn: 1, sent: ['a'] }, { turn: 2, sent: ['a'] }, { turn: 3, sent: ['a'] }];
  const { rows, stats } = joinReplies(records, ['说了第一轮', '说了第二轮']);
  assert.equal(rows[0].reply, '说了第一轮');
  assert.equal(rows[1].reply, '说了第二轮');
  assert.equal(rows[2].reply, null);
  assert.equal(stats.fpMissing, 3, '缺 fp 的条数要报出来 —— 否则「看起来在工作」和「对错位了」长得一样');
  assert.equal(stats.positional, 2);
  assert.equal(stats.unmatched, 1);
});

test('对齐：fp 存在但对不上时，不许拿序号去凑一个错的回复', () => {
  // 这是最危险的一种：留痕有 fp、会话也有文本，但那个指纹不在表里
  // （比如两边取数口径分叉了）。凑一个回复会比 null 更糟 —— 它看起来是证据。
  const table = { turns: ['aaaa'], replies: new Map([['aaaa', '回给甲']]) };
  const { rows } = joinReplies([{ turn: 1, fp: 'zzzz', sent: ['x'] }], table);
  assert.equal(rows[0].reply, null, '对不上就是对不上，宁可空着');
});

test('打分：只有真的送出去、又真有回复的那些轮才计数', () => {
  const book = { entries: [{ id: 'p', text: '那在哀丽秘榭的田野中奔跑的' }] };
  const records = [
    { turn: 1, sent: ['p'], reply: '我记得——那在哀丽秘榭的田野中奔跑的孩子。' }, // 长串重合
    { turn: 2, sent: ['p'], reply: '嗯，你说吧。' }, // 送出去了，但没痕迹
    { turn: 3, sent: [], reply: '' }, // 没送，不计
    { turn: 4, sent: ['p'], reply: null } // 没有回复文本，不计入分母
  ];
  const [row] = scoreUsage(records, book);
  assert.equal(row.id, 'p');
  assert.equal(row.sentWithReply, 2, '只有第 1、2 轮既有发送又有回复');
  assert.equal(row.quoted, 1);
  assert.equal(row.none, 1);
  assert.equal(row.samples.length, 1);
  assert.ok(row.samples[0].includes('哀丽秘榭'), row.samples[0]);
});

test('打分：回复是空串时不算分母，否则会把「没测到」算成「没用上」', () => {
  const book = { entries: [{ id: 'p', text: '一段设定' }] };
  const [row] = scoreUsage([{ turn: 1, sent: ['p'], reply: '   ' }], book);
  assert.equal(row.sentWithReply, 0);
  assert.equal(row.quoted + row.echoed + row.topical + row.none, 0);
});
