/**
 * The worldbook plugin, driven through a fake context.
 *
 * `worldbook-logic.mjs` is unit-tested to death, but the layer that actually
 * talks to DSH had never been executed. That matters more than it sounds,
 * because the loader **swallows its errors**: if `dist/worldbook.json` cannot be
 * found, the plugin still mounts, registers nothing, and the only trace is one
 * line on stderr that nobody reads. A worldbook that is silently absent looks
 * exactly like a worldbook that has nothing to say.
 *
 * So these tests run the real `apply()`, drive the real hook, and exercise the
 * loader's reload-on-change behaviour against temp files.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply, auditFile, createBookLoader, readAlwaysBlock } from '../worldbook.mjs';

/** A stand-in for the preset-scope context, recording what the plugin registers. */
function fakeContext() {
  const registrations = { context: [], hooks: [] };
  const ctx = {
    systemPrompt: {
      context(spec) {
        registrations.context.push(spec);
      }
    },
    on(name, handler, options) {
      registrations.hooks.push({ name, handler, options });
    }
  };
  return { ctx, registrations };
}

/**
 * The `agent/pre-step` handler, set up the way the loop actually calls it.
 *
 * `payload.messages` is the turn's claimed input — the loop passes
 * `{ messages: claimed, ... }` into the waterfall, and its default continuation
 * resolves to `{ kind: 'enter', messages: claimed }`. The triggered half reads
 * the payload, not the continuation's result, so a test that puts the user
 * message anywhere else exercises nothing.
 */
function hookOf(registrations, claimed) {
  const hook = registrations.hooks.find((candidate) => candidate.name === 'agent/pre-step');
  assert.notEqual(hook, undefined, 'the worldbook must hook agent/pre-step');
  const next = async () => ({ kind: 'enter', messages: claimed });
  return { hook, next };
}

/** A plain user message, shaped the way the loop claims them. */
function userMessage(text) {
  return { id: 'user-1', role: 'user', content: [{ type: 'text', text }] };
}

/**
 * 让这个用例的留痕写到临时文件里，别写进生产那份。
 *
 * `data/logs/worldbook.jsonl` 是**真·报账**的数据源（`tools/receipts.mjs` 读它）。
 * 而这个文件里的会话 id 全是 `session-a`…`session-f` 这种假的 —— 不管的话，
 * 每跑一次测试都往真账里掺一笔。实测：2026-10-10 那天 210 轮留痕里只有 6 轮
 * 来自真会话，剩下 204 轮全是历次测试跑出来的。
 *
 * 覆盖靠 `DSH_WORLDBOOK_AUDIT`，而 `auditFile()` **每次写入现读**它 ——
 * 缓存下来的话覆盖会失效，而失效的样子是「测试安静地写进了生产日志」。
 *
 * @param {(t: object) => Promise<void>} body - 用例正文。
 * @returns {(t: object) => Promise<void>} 包好的用例。
 */
const withAudit = (body) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cyrene-audit-'));
  const previous = process.env.DSH_WORLDBOOK_AUDIT;
  process.env.DSH_WORLDBOOK_AUDIT = join(dir, 'worldbook.jsonl');
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_WORLDBOOK_AUDIT;
    else process.env.DSH_WORLDBOOK_AUDIT = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  await body(t);
};

/** 生产那份留痕的绝对路径 —— 只在下面那条守卫用例里用。 */
const PRODUCTION_AUDIT = join(import.meta.dirname, '..', 'data', 'logs', 'worldbook.jsonl');

test('the plugin loads its data, and exposes the always-on half to the persona', () => {
  const { ctx, registrations } = fakeContext();
  apply(ctx);

  // ⚠️ The always-on half is NOT registered as a prompt input. It cannot be: the
  // preset sets complete:true (which replaces every other section) and
  // includeRuntimeContext:false (which empties the context channel), so anything
  // registered here would mount cleanly and reach nobody. It is composed into the
  // persona body instead, and exposed as readAlwaysBlock() for that purpose.
  assert.equal(registrations.context.length, 0, 'the worldbook must not register a prompt input');
  const always = readAlwaysBlock();
  assert.equal(typeof always, 'string');
  assert.ok(always.includes('昔涟'), 'the always-on half must carry her identity');
  assert.ok(always.includes('伙伴'), 'and the address rule, which is the point of it');

  // The triggered half goes through agent/pre-step, because assembly runs before
  // the user message lands and a keyword match there would see nothing.
  assert.equal(registrations.hooks.length, 1);
  const [registered] = registrations.hooks;
  assert.equal(registered.name, 'agent/pre-step');
  assert.deepEqual(registered.options, { prepend: true }, 'it must see messages before other rewrites');
});

test('a trigger word injects the matching lore, with an id', withAudit(async () => {
  const { ctx, registrations } = fakeContext();
  apply(ctx);
  const claimed = [userMessage('伙伴，你还记得哀丽秘榭吗？')];
  const { hook, next } = hookOf(registrations, claimed);

  const decision = await hook.handler({ agent: { session: { id: 'session-a' } }, messages: claimed }, next);
  assert.equal(decision.kind, 'enter');
  assert.equal(decision.messages.length, 2, 'the marker is appended to the claimed messages');

  const marker = decision.messages[1];
  // ⚠️ A hand-written descriptor without an id writes a user/message that fails
  // every later history load, permanently breaking the session. This is the one
  // field that must never be missing.
  assert.equal(typeof marker.id, 'string');
  assert.ok(marker.id.length >= 16, 'the id must be a real generated identifier, not a placeholder');
  assert.equal(marker.role, 'user');
  // ⚠️ Not the literal "plugin": that is the retired V3 wrapper, and V4 rejects it
  // with "format v4 message requires a producer-owned source kind" — which failed
  // an entire turn, and only on the turns where lore actually matched.
  assert.equal(marker.source.kind, 'plugin:dsh-cyrene-agent/worldbook');
  assert.notEqual(marker.source.kind, 'plugin', 'the bare V3 kind is refused by the session format');
  assert.ok(marker.content[0].text.includes('哀丽秘榭'), 'the Amphoreus entry should fire');
  assert.ok(marker.content[0].text.includes('伙伴'), 'and so should the address entry');
}));

test('the same lore is not re-injected on the next turn of the same session', withAudit(async () => {
  const { ctx, registrations } = fakeContext();
  apply(ctx);
  const claimed = [userMessage('再说说翁法罗斯吧')];
  const { hook, next } = hookOf(registrations, claimed);

  const first = await hook.handler({ agent: { session: { id: 'session-b' } }, messages: claimed }, next);
  assert.equal(first.messages.length, 2, 'the first mention injects');

  // ⚠️ 第 12 轮改过这条断言，理由要说清楚：原来要求第 2 轮**一条都不注入**。
  // 现在窗口内全被挡住时会有兜底（`ESCALATE_LIMIT`）—— 因为「一个人拆 6 条、
  // 分两轮给完」本来就是设计意图，而「十分钟/两分钟内问第二遍，一个字都不给」
  // 把它弄成了空话。所以这里改成：**第 2 轮仍然是注入过的内容，不是无限累积**，
  // 而且注入的确实是这一族的东西。
  const second = await hook.handler({ agent: { session: { id: 'session-b' } }, messages: claimed }, next);
  assert.equal(second.messages.length, 2, '窗口内的兜底：给的是刚说过的那批里排名靠前的');
  const text = second.messages[1].content[0].text;
  assert.ok(text.includes('哀丽秘榭'), '兜底给的仍然是这一族的内容，不是别的');

  // A different conversation is unaffected by that record.
  const other = await hook.handler({ agent: { session: { id: 'session-c' } }, messages: claimed }, next);
  assert.equal(other.messages.length, 2, 'de-duplication is per session');
}));

test('an unrelated message injects the anchor and no lore', withAudit(async () => {
  // 这条原来叫「an unrelated message injects nothing at all」，断言 messages.length === 1。
  //
  // 2026-10-10 加了锚点之后它不成立了，而且**是应该不成立** —— 锚点的全部意义就是
  // 每一轮都发，无关的消息正是最需要它的那些轮。改断言，不改行为。
  const { ctx, registrations } = fakeContext();
  apply(ctx);
  const claimed = [userMessage('帮我看看这段代码')];
  const { hook, next } = hookOf(registrations, claimed);
  const decision = await hook.handler({ agent: { session: { id: 'session-d' } }, messages: claimed }, next);
  assert.equal(decision.messages.length, 2, '锚点照发，设定条目不发');
  const injected = decision.messages[1];
  assert.equal(injected.role, 'user', '锚点走 user 通道，不走正文');
  assert.match(injected.content[0].text, /昔涟/, '发的是锚点，不是某条设定');
}));

test('a rejected pre-step is passed through untouched', withAudit(async () => {
  // The loop can decide to reject the turn. Injecting into a decision that is not
  // `enter` would either be ignored or, worse, resurrect a rejected turn.
  const { ctx, registrations } = fakeContext();
  apply(ctx);
  const hook = registrations.hooks[0];
  const rejection = { kind: 'reject', reason: 'stopped' };
  const decision = await hook.handler(
    { agent: { session: { id: 'session-e' } }, messages: [] },
    async () => rejection
  );
  assert.equal(decision, rejection, 'the rejection must be returned as-is');
}));

test('a malformed payload degrades instead of throwing', withAudit(async () => {
  // This runs inside the model loop: a throw here takes down the whole turn.
  const { ctx, registrations } = fakeContext();
  apply(ctx);
  const hook = registrations.hooks[0];
  const next = async () => ({ kind: 'enter', messages: [] });

  for (const payload of [undefined, {}, { messages: null }, { agent: null, messages: [] }]) {
    const decision = await hook.handler(payload, next);
    assert.equal(decision.kind, 'enter');
    // 1 而不是 0：锚点无条件发，畸形载荷也不例外。
    // **这条测的是「不抛异常」，不是「不注入」** —— 别把 0 写回去。
    assert.equal(decision.messages.length, 1, '锚点照发，而且没有抛异常');
  }
}));

test('the message array is never mutated in place', withAudit(async () => {
  // `llm/stream` hands out frozen message arrays; `agent/pre-step` does not, but
  // the habit is what keeps the other channel from throwing "object is not
  // extensible" later. The marker is appended by building a new array.
  const { ctx, registrations } = fakeContext();
  apply(ctx);
  const claimed = [userMessage('聊聊祝祭庭院吧')];
  const before = claimed.length;
  const { hook, next } = hookOf(registrations, claimed);
  await hook.handler({ agent: { session: { id: 'session-f' } }, messages: claimed }, next);
  assert.equal(claimed.length, before, 'the claimed array must be left alone');
}));

/* ------------------------------------------------------------------ *
 * 守卫：测试不许往生产留痕里写
 *
 * `data/logs/worldbook.jsonl` 是真账 —— `tools/receipts.mjs` 拿它算
 * 「给了什么、用没用上」。上面那几条用例往真账里写的是 `session-a`…`session-f`
 * 这种假会话，混进去之后人工看账就得靠猜。
 * ------------------------------------------------------------------ */

test('测试的留痕写到临时文件，生产那份一个字节都不动', withAudit(async () => {
  const { ctx, registrations } = fakeContext();
  apply(ctx);
  const claimed = [userMessage('你还记得哀丽秘榭吗？')];
  const { hook, next } = hookOf(registrations, claimed);
  await hook.handler({ agent: { session: { id: 'session-guard' } }, messages: claimed }, next);

  assert.notEqual(auditFile(), PRODUCTION_AUDIT, 'DSH_WORLDBOOK_AUDIT 生效时不该指向生产文件');
  const written = readFileSync(auditFile(), 'utf8').trim().split('\n');
  assert.equal(written.length, 1, '这一轮的留痕应当写在临时文件里');
  assert.equal(JSON.parse(written[0]).session, 'session-guard');
}));

test('没有覆盖时，auditFile() 指向仓库里那份', () => {
  // 覆盖只应当在测试进程里生效 —— 线上没有任何东西设这个变量。
  const saved = process.env.DSH_WORLDBOOK_AUDIT;
  delete process.env.DSH_WORLDBOOK_AUDIT;
  try {
    assert.equal(auditFile(), PRODUCTION_AUDIT);
  } finally {
    if (saved !== undefined) process.env.DSH_WORLDBOOK_AUDIT = saved;
  }
});


/* ------------------------------------------------------------------ *
 * The loader reloads when the file changes
 *
 * This is the whole reason the read is deferred out of apply(): apply() runs
 * when the preset mounts, which is at DSH boot, so a load-once design would make
 * every lore edit cost a full restart. The tests below point the loader at a
 * temp file so none of this touches dist/worldbook.json.
 * ------------------------------------------------------------------ */

/** Write a compiled worldbook to a temp path and return that path. */
function writeBook(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'cyrene-book-'));
  const file = join(dir, 'worldbook.json');
  writeFileSync(file, JSON.stringify({
    always: [{ id: 'core', text: '常驻内容' }],
    entries: [{ id: 'a', triggers: [...lines], priority: 1, text: `关于 ${lines[0]} 的设定` }]
  }));
  return file;
}

test('the loader picks up an edit without a restart', () => {
  const file = writeBook(['甲']);
  const load = createBookLoader(file);

  assert.deepEqual(load().entries.map((entry) => entry.id), ['a']);
  assert.ok(load().entries[0].triggers.includes('甲'));

  // A different-length payload, so the size half of the cache key moves even if
  // the write lands inside the same millisecond.
  writeFileSync(file, JSON.stringify({
    always: [{ id: 'core', text: '常驻内容' }],
    entries: [{ id: 'b', triggers: ['乙乙乙'], priority: 1, text: '新的设定' }]
  }));

  const after = load();
  assert.deepEqual(after.entries.map((entry) => entry.id), ['b'], 'the edit must be visible immediately');
  assert.equal(after.entries[0].triggers[0], '乙乙乙');
});

test('an unchanged file is parsed once, not once per turn', () => {
  // The hook runs every turn. Re-parsing there would be wasteful, and re-reading
  // the same bytes must not produce a different object: the persona lives in the
  // prompt prefix, so identical content has to stay identical.
  const load = createBookLoader(writeBook(['甲']));
  const first = load();
  assert.equal(load(), first, 'the same file must yield the very same object');
  assert.equal(load().always[0].text, '常驻内容');
});

test('a missing or malformed file degrades to an empty book', () => {
  // A broken worldbook must cost the lore, not the conversation.
  const missing = createBookLoader(join(tmpdir(), 'cyrene-definitely-not-here', 'worldbook.json'));
  assert.deepEqual(missing().entries, []);
  assert.deepEqual(missing().always, []);

  const dir = mkdtempSync(join(tmpdir(), 'cyrene-book-'));
  const broken = join(dir, 'worldbook.json');
  writeFileSync(broken, '{ this is not json');
  const load = createBookLoader(broken);
  assert.deepEqual(load().entries, [], 'malformed JSON must not throw into the model loop');
  assert.deepEqual(load().entries, [], 'and must keep degrading on later turns');

  // Recovering is allowed: fixing the file should bring the lore back.
  writeFileSync(broken, JSON.stringify({ always: [], entries: [{ id: 'a', triggers: ['甲'], text: 'x' }] }));
  assert.deepEqual(load().entries.map((entry) => entry.id), ['a'], 'a repaired file must come back');
});
