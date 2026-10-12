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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply, storyLogFile, STORY_SCORE_FLOOR } from '../story.mjs';

function fakeContext() {
  const registrations = { hooks: [] };
  const ctx = {
    on(name, handler, options) {
      registrations.hooks.push({ name, handler, options });
    }
  };
  return { ctx, registrations };
}

/**
 * 按真实调用方式把钩子取出来。
 *
 * `payload.messages` 是这一轮的输入，缺省续接解析成 `{ kind: 'enter', messages: claimed }`。
 * 钩子读的是 payload，所以把用户消息放到别处等于什么都没测。
 */
function hookOf(registrations, claimed) {
  const hook = registrations.hooks.find((candidate) => candidate.name === 'agent/pre-step');
  assert.notEqual(hook, undefined, 'story.mjs 必须挂 agent/pre-step');
  const next = async () => ({ kind: 'enter', messages: claimed });
  return { hook, next };
}

/** 一个普通用户消息，按 loop 给出的形状。 */
function userMessage(text) {
  return { id: 'user-1', role: 'user', content: [{ type: 'text', text }] };
}

/** 让这个用例的留痕写到临时文件里，别写进生产那份。 */
const withAudit = (body) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'story-audit-'));
  const previous = process.env.DSH_STORY_AUDIT;
  process.env.DSH_STORY_AUDIT = join(dir, 'story.jsonl');
  try {
    await body(t, dir);
  } finally {
    if (previous === undefined) delete process.env.DSH_STORY_AUDIT;
    else process.env.DSH_STORY_AUDIT = previous;
    rmSync(dir, { recursive: true, force: true });
  }
};

/** 跑一轮，拿到决定。 */
async function run(claimed, text) {
  const { ctx, registrations } = fakeContext();
  apply(ctx);
  // ⚠️ `hookOf` 返回的是**注册对象** `{ name, handler, options }`，不是 handler 本身。
  // 第一版写成 `hook(...)`，五个用例全报 `hook is not a function`。
  const { hook, next } = hookOf(registrations, claimed);
  return hook.handler({ messages: claimed }, next);
}

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
