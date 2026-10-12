/**
 * 剧情检索与注入。
 *
 * 这些测的是**规则**，不是注入本身 —— 注入那一层要 DSH 在场，
 * 由 `tools/verify-real-prompt.mjs` 管。这里管的是纯函数：
 * 二元组怎么切、索引怎么排、闸门什么时候放行。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildIndex, cleanName, grams } from '../retrieval.mjs';
import { pick, render, STORY_SCORE_FLOOR, storyWindowMs } from '../story.mjs';

// ── 二元组 ────────────────────────────────────────────────────────────

test('二元组剥掉标点，只留字', () => {
  assert.deepEqual(grams('遐蝶，你好。'), ['遐蝶', '蝶你', '你好']);
});

test('两个字的问句剩一条二元组 —— 不能空手而归', () => {
  assert.deepEqual(grams('在吗'), ['在吗']);
});

test('一个字也要留 —— 纯二元组下它会消失', () => {
  assert.deepEqual(grams('花'), ['花']);
});

test('空输入不炸', () => {
  assert.deepEqual(grams(''), []);
  assert.deepEqual(grams(undefined), []);
});

test('标点本身不产出二元组', () => {
  // 「，。」剥完是空的 —— 不能因为剥出了空串就返回 ['，']。
  assert.deepEqual(grams('，。！'), []);
});

// ── 索引 ──────────────────────────────────────────────────────────────

const DOCS = [
  { id: 'a', chapter: '第一章', node: '死亡之触', text: '她轻轻触碰了死囚的额头。' },
  { id: 'b', chapter: '第二章', node: '彩虹桥', text: '她想以彩虹桥连接人们的心灵。' },
  { id: 'c', chapter: '第三章', node: '轮回', text: '泰坦是过去的黄金裔，黄金裔是未来的泰坦。' }
];

test('检索把对的那一块排在前面', () => {
  const index = buildIndex(DOCS);
  assert.equal(index.search('彩虹桥在哪', 1)[0].doc.id, 'b');
  assert.equal(index.search('黄金裔和泰坦什么关系', 1)[0].doc.id, 'c');
});

test('中间隔字也找得到 —— 这是不用整串子串匹配的理由', () => {
  const index = buildIndex(DOCS);
  // 「死亡之触」和「死亡之触是怎么回事」共享二元组；整串匹配会断在「怎么回事」上。
  assert.equal(index.search('那个死亡之触是怎么回事', 1)[0].doc.id, 'a');
});

test('标题里的词也算数', () => {
  const index = buildIndex(DOCS);
  assert.equal(index.search('轮回', 1)[0].doc.id, 'c');
});

test('分数降序，且给够就回够', () => {
  const index = buildIndex(DOCS);
  const got = index.search('彩虹桥', 3);
  assert.equal(got.length, 3);
  assert.ok(got[0].score >= got[1].score);
  assert.ok(got[1].score >= got[2].score);
});

test('空库不炸', () => {
  const index = buildIndex([]);
  assert.deepEqual(index.search('随便什么', 3), []);
});

// ── 闸门 ──────────────────────────────────────────────────────────────

/** 一份最小的假索引状态 —— 形状要和 story.mjs 里 load() 给的一致。 */
const STATE = {
  index: buildIndex(DOCS),
  names: new Set(['遐蝶', '白厄'])
};

test('没提专名、分数又低 → 不注入', () => {
  // 「今天天气不错」和那三块都不沾边，分数接近 0。
  assert.equal(pick(STATE, '今天天气不错'), null);
});

test('提了专名 → 注入，哪怕分数低', () => {
  // 「遐蝶」在 names 里。这一条测的是名字闸单独就能放行。
  const hit = pick(STATE, '遐蝶后来怎么样了');
  assert.notEqual(hit, null);
});

test('没提专名但分数够高 → 也注入（分数闸兜底）', () => {
  // 「彩虹桥在哪」不含任何专名，但和 b 那块高度重合。
  const hit = pick(STATE, '彩虹桥在哪');
  assert.notEqual(hit, null);
  assert.equal(hit.doc.id, 'b');
});

test('空问句不注入', () => {
  assert.equal(pick(STATE, ''), null);
  assert.equal(pick(STATE, '   '), null);
});

test('状态为 null（索引读不到）不炸', () => {
  assert.equal(pick(null, '遐蝶呢'), null);
});

test('分数下限是个正数 —— 0 会让所有东西都过', () => {
  assert.ok(STORY_SCORE_FLOOR > 0);
  assert.ok(STORY_SCORE_FLOOR < 1);
});

// ── 专名清洗 ──────────────────────────────────────────────────────────
//
// 剧情原文的 `**【X】**` 有 717 个，绝大多数**真有用** ——
// 「尼卡多利的士兵」「愤慨的悬锋族人」问起来都是剧情问题。
// 所以这些测试守的是「**只剔三类，别把有用的清掉**」。

test('纯标点不算专名 —— 打一串问号是困惑，不是剧情问题', () => {
  // 这是这套规则里最要紧的一条。
  assert.deepEqual(cleanName('？？？'), []);
  assert.deepEqual(cleanName('？？'), []);
  assert.deepEqual(cleanName('…'), []);
});

test('花括号里的模板占位符不算专名', () => {
  assert.deepEqual(cleanName('{NICKNAME}'), []);
});

test('单字不算专名 —— 「刃」会让「刀刃」也命中', () => {
  assert.deepEqual(cleanName('刃'), []);
});

test('描述性的名字要留着 —— 它们问起来就是剧情问题', () => {
  assert.deepEqual(cleanName('尼卡多利的士兵'), ['尼卡多利的士兵']);
  assert.deepEqual(cleanName('愤慨的悬锋族人'), ['愤慨的悬锋族人']);
});

test('整段被引号包住的剥完还是它自己', () => {
  assert.deepEqual(cleanName('「三月七」'), ['三月七']);
  assert.deepEqual(cleanName('「盗火行者」'), ['盗火行者']);
});

test('夹着引号的名字要拆段 —— 不拆的话里头那个「」会让整串匹配不上', () => {
  // 第一版就是这么错的：剥外层引号留下 `长老」阿蒙内特`，谁也匹配不上。
  assert.deepEqual(cleanName('「长老」阿蒙内特'), ['长老', '阿蒙内特']);
});

test('空输入不炸', () => {
  assert.deepEqual(cleanName(''), []);
  assert.deepEqual(cleanName(undefined), []);
});

// ── 重复窗口 ──────────────────────────────────────────────────────────
//
// 世界书早就有这个（`DEFAULT_WINDOW_MS = 2 分钟`），它的测试里有一条正是
// `the same lore is not re-injected on the next turn of the same session`。
// **剧情这条原来没有。** 没有的后果很具体：连问两遍同一句，同一段 900 字给两遍。
//
// ⚠️ 窗口的行为是「**换一块**」，不是「不给了」—— 跳过一个还有下一个。
// 所以这几条断的是「拿到的不是同一块」，不是「没注入」。

test('连着问同一句，第二遍不再给同一块', () => {
  const seen = new Map();
  const first = pick(STATE, '遐蝶后来怎么样了', seen, 1000);
  const second = pick(STATE, '遐蝶后来怎么样了', seen, 2000);
  assert.notEqual(first, null);
  assert.notEqual(second, null, '不是不给，是换一块');
  assert.notEqual(first.doc.id, second.doc.id);
});

test('窗口过期之后，那一块可以再回来', () => {
  const seen = new Map();
  const first = pick(STATE, '遐蝶后来怎么样了', seen, 1000);
  // 窗口是 2 分钟；跳到窗口外再问，第一块应当重新够格。
  const later = pick(STATE, '遐蝶后来怎么样了', seen, 1000 + storyWindowMs() + 1);
  assert.equal(later.doc.id, first.doc.id);
});

test('窗口只挡给过的那几块 —— 别的块不受影响', () => {
  const seen = new Map();
  pick(STATE, '遐蝶后来怎么样了', seen, 1000);
  // 换一个完全不同的话题，不该因为窗口而拿不到东西。
  assert.notEqual(pick(STATE, '彩虹桥在哪', seen, 2000), null);
});

test('候选全在窗口里时重发一次，而不是空手 —— 世界书的 escalated', () => {
  const seen = new Map();
  // 连问四遍同一句。前三遍各拿一块（窗口挡掉前一块给下一块），第四遍候选全用过。
  const got = [0, 1, 2, 3].map((i) => pick(STATE, '遐蝶后来怎么样了', seen, 1000 + i));
  assert.ok(got.every((h) => h !== null), '任何一遍都不该空手');
  assert.equal(got[3].escalated, true, '第四遍应当是重发');
  assert.equal(got[0].escalated, false, '第一遍不是重发');
});

test('窗口长度可被环境变量覆盖 —— 和世界书那条同一个约定', () => {
  const previous = process.env.DSH_STORY_WINDOW_MS;
  try {
    delete process.env.DSH_STORY_WINDOW_MS;
    assert.ok(storyWindowMs() > 0);
    process.env.DSH_STORY_WINDOW_MS = '1';
    assert.equal(storyWindowMs(), 1);
  } finally {
    if (previous === undefined) delete process.env.DSH_STORY_WINDOW_MS;
    else process.env.DSH_STORY_WINDOW_MS = previous;
  }
});

test('seen 不传也不会炸 —— 每次调用各自一份，不跨调用泄漏', () => {
  const a = pick(STATE, '遐蝶后来怎么样了', undefined, 1000);
  const b = pick(STATE, '遐蝶后来怎么样了', undefined, 1001);
  assert.equal(a.doc.id, b.doc.id, '不传 seen 就不该有记忆');
});

// ── 渲染 ──────────────────────────────────────────────────────────────

test('注入正文带出处：章节 · 节点（任务 ID）', () => {
  const text = render({ doc: { chapter: '走过安眠地的花丛', node: '行者啊，向冥河解缆起航', nodeId: '1040306', text: '正文' } });
  assert.ok(text.includes('走过安眠地的花丛'));
  assert.ok(text.includes('行者啊，向冥河解缆起航'));
  assert.ok(text.includes('1040306'), '任务 ID 要带上 —— 引用时能落到具体那一幕');
  assert.ok(text.includes('正文'));
});

test('框分三句 —— 「你」是谁不预设、用自己的话、不必提起', () => {
  // 光给一段剧本文本，模型最可能是放着不用，更坏是照着念。
  // **这一层框就是「多给几段背景」和「真的改变输出」之间的那道缝。**
  const text = render({ doc: { chapter: '第一章', node: '开端', nodeId: '1', text: '正文' } });
  assert.ok(text.includes('翁法罗斯原文'), '标题写客观的「原文」');
  assert.ok(text.includes('不一定是你'), '一：不把别人的经历塞给她');
  assert.ok(text.includes('别照着念'), '二：堵掉照念台词');
  assert.ok(text.includes('不必特意提起它'), '三：不必每轮声明「原文里写过」');
  // 三句是**指令**，不是她的台词 —— 不该被引号包起来装成她在说话。
  assert.ok(!/「[^」]*别照着念[^」]*」/.test(text));
});

test('框不能说成她亲历的 —— 第一版就错在这里', () => {
  // 原文里的「你」是当时被操控的那个人，随场景变：
  // 哀地里亚那一幕的「你」是遐蝶，不是昔涟。
  //
  // 第一版写的是「【你亲历的那一幕】」+「这是你自己走过的一段」，
  // 于是她要把「你亲手触碰了死囚」当成自己的记忆。
  // **对方先发现的：他说问这一句时思考时间明显变长。**
  const text = render({ doc: { chapter: '第一章', node: '开端', nodeId: '1', text: '正文' } });
  assert.ok(!text.includes('你亲历的'), '不能写「你亲历的」');
  assert.ok(!text.includes('你自己走过的'), '不能说成她走过的');
  assert.ok(!text.includes('你本来就在那里'), '不能假设她在场');
});

test('缺章节或节点也要能渲染', () => {
  const text = render({ doc: { chapter: '', node: '', nodeId: '', text: '只有正文' } });
  assert.ok(text.includes('只有正文'));
  assert.ok(!text.includes('undefined'));
});
