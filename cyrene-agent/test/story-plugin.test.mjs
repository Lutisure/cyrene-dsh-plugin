/**
 * 剧情注入插件 —— `agent/pre-step` 那一层。
 *
 * `story.test.mjs` 测的是**规则**（二元组、索引、闸门、渲染）。这里测的是
 * **插件那一层**：钩子挂上没有、注进去的东西长什么样、坏输入会不会炸。
 *
 * ⚠️ 这一层以前**完全没有测试** —— 只有一个我临时手搓的探针。
 * 而世界书的注释里写过这个失败模式有多安静：
 *
 *   > 块是空的时，`renderContextSections()` 会把整段丢掉，不报错、不留痕。
 *   > 那个失败在快照里和界面上都看不见。
 *
 * 剧情这条走同一条通道，所以同样看不见。**这一份就是让它看得见。**
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import yaml from 'js-yaml';

import { apply, storyLogFile, STORY_SCORE_FLOOR } from '../story.mjs';
import { ensureStoryIndex } from './ensure-dist.mjs';
import { fakeContext, run, userMessage, withAudit } from './story-harness.mjs';

/**
 * 这一份把向量检索**钉在关**。
 *
 * 2026-10-13 把 bge 模型放进 `<包>/cyrene_embedding/` 之后，默认的 `auto` 会真的走窗口召回，
 * 同一个查询落到另一块上 —— 而下面那些断言（哪一块、分数多少、第几道闸放行）是**词法那一套**
 * 排出来的。没装模型的机器上它们又回到词法。同一份代码两种结果，回归就没有意义了。
 *
 * 向量那条路单独测，见 `story-embedding.test.mjs` —— 它必须在**另一个进程**里跑，
 * 因为 `story.mjs` 的 `load()` 是记忆化的（夹具文件头写了这件事）。
 */
process.env.DSH_STORY_EMBED = 'off';

// 剧情索引是 `dist/` 里的构建产物，不进 git —— 干净克隆上没有它，
// 注入就无从谈起（读不到文件直接 ENOENT）。缺了现在建，一秒级，没有副作用。
ensureStoryIndex();

test('挂在 agent/pre-step 上', () => {
  const { ctx, registrations } = fakeContext();
  apply(ctx);
  assert.equal(registrations.hooks.length, 1);
  assert.equal(registrations.hooks[0].name, 'agent/pre-step');
});

test('剧情问题注进一段原文，带出处与来源标记', withAudit(async () => {
  const claimed = [userMessage('遐蝶的死亡之触是怎么回事')];
  const decision = await run(claimed, '遐蝶的死亡之触是怎么回事');
  assert.equal(decision.kind, 'enter');
  assert.equal(decision.messages.length, 2, '应当多出一条注入消息');

  const injected = decision.messages[1];
  assert.equal(injected.role, 'user', '走的是 user 那条通道');
  assert.match(String(injected.source?.kind), /^plugin/, '来源标记必须以 plugin 开头');
  const text = injected.content.map((p) => p.text).join('');
  assert.match(text, /翁法罗斯原文/, '标题写客观的「原文」，不写「你亲历的」');
  assert.match(text, /走过安眠地的花丛/, '出处要写全：章节');
  assert.match(text, /不一定是你/, '「你」是谁不预设 —— 这一段里的「你」是遐蝶');
  assert.match(text, /别照着念/, '要明确堵掉照念台词');
  assert.match(text, /不必特意提起它/, '免得每轮都来一句「我记得原文里写过」');
  // ⚠️ 这一条守的是第一版那个错：框不能说成她亲历的。
  assert.ok(!text.includes('你亲历的'), '**不能写「你亲历的」** —— 那会把别人的经历塞给她');
}));

test('闲聊什么都不注', withAudit(async () => {
  for (const q of ['在吗', '我今天有点累', '晚安']) {
    const claimed = [userMessage(q)];
    const decision = await run(claimed, q);
    assert.equal(decision.messages.length, 1, `「${q}」不该注入`);
  }
}));

test('被拒的 pre-step 原样传回去', withAudit(async () => {
  const { ctx, registrations } = fakeContext();
  apply(ctx);
  const hook = registrations.hooks[0].handler;
  const cancelled = { kind: 'cancel', reason: 'test' };
  const decision = await hook({ messages: [] }, async () => cancelled);
  assert.equal(decision, cancelled);
}));

test('畸形 payload 退让，不抛', withAudit(async () => {
  const { ctx, registrations } = fakeContext();
  apply(ctx);
  const hook = registrations.hooks[0].handler;
  const next = async () => ({ kind: 'enter', messages: [] });
  for (const payload of [undefined, {}, { messages: null }, { messages: [null, 42] }]) {
    const decision = await hook(payload, next);
    assert.equal(decision.kind, 'enter', '坏输入不该让这一轮失败');
  }
}));

test('不断言消息数组被就地改动', withAudit(async () => {
  const claimed = [userMessage('遐蝶的死亡之触是怎么回事')];
  const before = claimed.length;
  const decision = await run(claimed, claimed[0].content[0].text);
  assert.equal(claimed.length, before, 'claimed 数组不能被就地改长');
  assert.notEqual(decision.messages, claimed, '要返回新数组');
}));

test('留痕写到临时文件，生产那份一个字节都不动', withAudit(async (t, dir) => {
  const file = storyLogFile();
  assert.ok(file.startsWith(dir), 'DSH_STORY_AUDIT 要生效');

  const q = '遐蝶的死亡之触是怎么回事';
  const claimed = [userMessage(q)];
  await run(claimed, q);

  assert.ok(existsSync(file), '应当写出日志');
  const record = JSON.parse(readFileSync(file, 'utf8').trim());
  assert.equal(record.chapter, '走过安眠地的花丛');
  assert.ok(record.score > 0);
  // session 要记 —— 没有它，日志分不清「刚才聊的那轮」和「昨天测试留下的那轮」，
  // 而验收正是要对着某一轮看。
  assert.equal(typeof record.session, 'string', 'session 字段要在');
  assert.equal(record.escalated, false, '第一遍不是重发');
  assert.match(record.fp, /^[0-9a-f]{12}$/, 'fp 是 query 的指纹，不是原文');
  assert.ok(!JSON.stringify(record).includes(q), '日志里不能出现对方说了什么');
}));

test('闲聊不写日志', withAudit(async (t, dir) => {
  const claimed = [userMessage('在吗')];
  await run(claimed, '在吗');
  assert.ok(!existsSync(join(dir, 'story.jsonl')), '没注入就不该留痕');
}));

test('闸门常量是正数 —— 0 会让所有东西都过', () => {
  assert.ok(STORY_SCORE_FLOOR > 0);
  assert.ok(STORY_SCORE_FLOOR < 1);
});

// ── 建议 ① 的回归：名字闸两档分开判 ───────────────────────────────────
//
// 起因：40 句日常话里有 4 句被放过去，全是「触发词型 2 字词」干的
// （明天见 → 明天 / 记得多穿点 → 记得 / 有点想你 → 想你 / 明天要早起 → 明天）。
// 这些词来自世界书触发词，**不是专名**。

test('2 字的触发词型专名，单独一个不放行（建议 ①）', withAudit(async () => {
  for (const q of ['明天见', '有点想你', '记得多穿点', '明天要早起']) {
    const claimed = [userMessage(q)];
    const decision = await run(claimed, q);
    assert.equal(decision.messages.length, 1, `「${q}」不该注入`);
  }
}));

test('真专名仍然单独放行 —— 收严不能把该给的也挡住（建议 ①）', withAudit(async () => {
  const q = '遐蝶的死亡之触是怎么回事';
  const claimed = [userMessage(q)];
  const decision = await run(claimed, q);
  assert.equal(decision.messages.length, 2, '说话人型专名命中一个就该放行');
}));

// ── 建议 ④：注入消息的 id ────────────────────────────────────────────
//
// 世界书那边的教训：**缺 id 会让那个会话永久打不开**，而错误里只有一个 seq 号。
// 这一层以前完全没有断言 —— 只有 story.test.mjs 管到 render/pick，管不到钩子造出来的消息。

test('注入消息的 id 非空，且两次注入不撞车（建议 ④）', withAudit(async () => {
  const ids = [];
  for (const q of ['遐蝶的死亡之触是怎么回事', '海瑟音的歌声']) {
    const claimed = [userMessage(q)];
    const decision = await run(claimed, q);
    assert.equal(decision.messages.length, 2, `「${q}」应当注入`);
    const id = decision.messages[1].id;
    assert.equal(typeof id, 'string', 'id 必须是字符串');
    assert.ok(id.length > 0, 'id 不能是空串');
    assert.match(String(decision.messages[1].source?.kind), /^plugin/, '来源标记仍要以 plugin 开头');
    ids.push(id);
  }
  assert.notEqual(ids[0], ids[1], '两次注入的 id 不能相同');
}));

// ── 别名表 ────────────────────────────────────────────────────────────
//
// 起因：「缇宝的墓碑上写了什么」含答案的那一块写的是「缇里西庇俄丝」，两边没有共同专名。
// 别名表**不进检索打分**（实测查询扩展会把排序弄差），只做两件事：
//   一、让核实过的人名叫法按**强专名**放行（救了 2 字的「凯撒」「金织」）
//   二、作为数据留给未来的向量检索

test('别名问法按强专名放行（凯撒是 2 字，按「要两个」会被挡）', withAudit(async () => {
  const q = '凯撒做过什么';
  const claimed = [userMessage(q)];
  const decision = await run(claimed, q);
  assert.equal(decision.messages.length, 2, `「${q}」应当注入 —— 别名表里的人名按强专名放行`);
}));

test('别名表每一条都指向语料里真实存在的叫法', () => {
  // ⚠️ 别名表写错的后果比不写更坏：检索会去找一个不存在的名字。
  // 这条把「核实」这一步钉在回归里 —— 加新别名时它必须能在 986 块里被找到。
  const groups = yaml.load(readFileSync(new URL('../worldbook/aliases.yaml', import.meta.url), 'utf8')).groups;
  assert.ok(Array.isArray(groups) && groups.length > 0, '别名表不能是空的');
  const chunks = readFileSync(new URL('../dist/story-chunks.jsonl', import.meta.url), 'utf8');
  for (const group of groups) {
    assert.ok(group.length >= 2, `${group.join('/')} 这一组少于两个叫法`);
    for (const name of group) {
      assert.ok(chunks.includes(name), `「${name}」在剧情语料里一次都没出现 —— 别名写错了`);
    }
  }
});

// 向量检索那一层在 `story-embedding.test.mjs` —— 它必须在另一个进程里跑，
// 因为这里已经把 `load()` 的结果在 `off` 下记忆化了。

