/**
 * The talking-style correction channel.
 *
 * The problem it solves: a correction given mid-conversation used to last exactly
 * as long as the conversation. Putting it in memory was wrong too — memory holds
 * facts about the user, and style rules crowd those out.
 *
 * So corrections get their own file, their own tools, and their own place in the
 * prompt. What makes it work across sessions is that `persona.mjs` reads the file
 * **on every assembly** (see `file-cache.mjs`), so a rule written on one turn is
 * in force on the next one — and every one after that, in any session.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

/** A stand-in for the preset-scope context. */
function fakeContext() {
  const contexts = [];
  const tools = new Map();
  return {
    contexts,
    tools,
    ctx: {
      systemPrompt: { context: (spec) => contexts.push(spec), variable() {} },
      inject(names, scope) {
        if (names.includes('tools')) scope({ tools: { register: (tool) => tools.set(tool.name, tool) } });
      }
    }
  };
}

/**
 * Run `body` with a throwaway DSH_HOME.
 *
 * ⚠️ **它先写一个空的 `corrections.md`。** 那是必要的：
 *
 * 2026-10-11 起，文件**不存在**时会从随包的 `corrections.default.md` 种一份
 * （九条默认规则）—— 所以「全新的 DSH_HOME」不再等于「空的 store」。
 *
 * 而下面那些用例测的是**这个 store 本身**（写一条、拒重复、按关键词删），
 * 它们需要一个空起点。「文件存在但是空的」正是那个起点，
 * **而且它还是真实的用户状态**：人家把那九条逐条删光之后就是这样。
 *
 * 种子的行为另有专门一条用例，见文件末尾。
 */
async function withHome(body) {
  const previous = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'cyrene-corr-'));
  process.env.DSH_HOME = home;
  try {
    const file = join(home, 'cyrene-agent', 'corrections.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '');
    return await body(home);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

test('it registers the two tools and no prompt input of its own', async () => {
  await withHome(async () => {
    const { apply } = await import('../corrections.mjs');
    const { ctx, contexts, tools } = fakeContext();
    apply(ctx);
    // Like memory: registering a context() would be discarded, because the preset
    // sets complete:true and includeRuntimeContext:false. persona.mjs splices the
    // block into the body instead.
    assert.equal(contexts.length, 0);
    assert.deepEqual([...tools.keys()].sort(), ['correct', 'uncorrect']);
  });
});

test('the tool schemas are what the model will be given', async () => {
  await withHome(async () => {
    const { apply } = await import('../corrections.mjs');
    const { ctx, tools } = fakeContext();
    apply(ctx);
    // `register` stores `parameters` verbatim — see memory.mjs on why the shape
    // must already be JSON Schema rather than a defineTool spec.
    for (const [name, parameter] of Object.entries({ correct: 'rule', uncorrect: 'keyword' })) {
      const schema = tools.get(name).parameters;
      assert.equal(schema.type, 'object', `${name}.parameters must be an object schema`);
      assert.deepEqual(Object.keys(schema.properties), [parameter]);
      assert.deepEqual(schema.required, [parameter]);
      assert.equal(typeof tools.get(name).description, 'string');
      assert.equal(typeof tools.get(name).output.render, 'function');
    }
  });
});

test('a rule is written, and the block carries it on the next read', async () => {
  await withHome(async () => {
    const { apply, readCorrectionsBlock } = await import('../corrections.mjs');
    const { ctx, tools } = fakeContext();
    apply(ctx);

    assert.equal(readCorrectionsBlock(), '', 'nothing corrected yet means no block at all');

    const written = await tools.get('correct').execute({ rule: '不要说「闲得慌」这类话' });
    assert.ok(String(written).includes('闲得慌'));

    const block = readCorrectionsBlock();
    assert.ok(block.includes('闲得慌'), 'the block must carry the rule');
    // The heading is load-bearing: a bare list reads as background, and the model
    // needs to read this as an override of the style described above it.
    assert.ok(block.includes('修正'), 'the block must be labelled as a correction');
    assert.ok(block.includes('优先级高于'), 'and say it outranks the style guidance');
  });
});

test('a repeat is refused, and a different one is added', async () => {
  await withHome(async () => {
    const { apply, readCorrectionsBlock, countCorrections } = await import('../corrections.mjs');
    const { ctx, tools } = fakeContext();
    apply(ctx);
    const correct = tools.get('correct');

    await correct.execute({ rule: '不要在每条回复末尾都抛问题' });
    const again = await correct.execute({ rule: '不要在每条回复末尾都抛问题。' });
    assert.ok(String(again).includes('已经记过'), 'punctuation alone must not create a second entry');
    assert.equal(countCorrections(), 1);

    await correct.execute({ rule: '不要用「不是……而是……」这个结构' });
    assert.equal(countCorrections(), 2);
    assert.ok(readCorrectionsBlock().includes('不是……而是'));
  });
});

test('an empty rule is refused rather than stored', async () => {
  await withHome(async () => {
    const { apply, countCorrections } = await import('../corrections.mjs');
    const { ctx, tools } = fakeContext();
    apply(ctx);
    const result = await tools.get('correct').execute({ rule: '   ' });
    assert.ok(String(result).includes('没有记下'));
    assert.equal(countCorrections(), 0);
  });
});

test('uncorrect removes by keyword, and reports zero honestly', async () => {
  await withHome(async () => {
    const { apply, readCorrectionsBlock, countCorrections } = await import('../corrections.mjs');
    const { ctx, tools } = fakeContext();
    apply(ctx);
    await tools.get('correct').execute({ rule: '不要说「闲得慌」' });
    await tools.get('correct').execute({ rule: '不要堆砌意象' });

    const removed = await tools.get('uncorrect').execute({ keyword: '闲得慌' });
    assert.ok(String(removed).includes('1 条'));
    assert.equal(countCorrections(), 1);
    assert.ok(!readCorrectionsBlock().includes('闲得慌'));
    assert.ok(readCorrectionsBlock().includes('堆砌意象'), 'the other rule must survive');

    const none = await tools.get('uncorrect').execute({ keyword: '不存在的东西' });
    assert.ok(String(none).includes('没有找到'));
  });
});

test('the file is plain text under DSH_HOME, so it can be edited by hand', async () => {
  await withHome(async (home) => {
    const { apply, readCorrectionsBlock } = await import('../corrections.mjs');
    const { ctx, tools } = fakeContext();
    apply(ctx);
    await tools.get('correct').execute({ rule: '手写也要能加' });

    const file = join(home, 'cyrene-agent', 'corrections.md');
    assert.ok(existsSync(file), `expected ${file}`);
    assert.ok(readFileSync(file, 'utf8').includes('- 手写也要能加'), 'one rule per "- " line');

    // And editing it by hand is picked up on the next read, with no process involved.
    writeFileSync(file, '- 直接写进去的一条\n');
    assert.ok(readCorrectionsBlock().includes('直接写进去的一条'));
    assert.ok(!readCorrectionsBlock().includes('手写也要能加'));
  });
});

test('the composed prompt carries the block in the right place', async () => {
  await withHome(async () => {
    const { apply, readCorrectionsBlock } = await import('../corrections.mjs');
    const { ctx, tools } = fakeContext();
    apply(ctx);
    await tools.get('correct').execute({ rule: '不要说「闲得慌」' });

    const { createPersonaReader } = await import('../persona.mjs');
    const { readAlwaysBlock } = await import('../worldbook.mjs');
    const prompt = createPersonaReader(null, () => {})();

    const corrections = readCorrectionsBlock();
    assert.ok(prompt.includes(corrections), 'the block must reach the composed prompt');
    assert.ok(prompt.includes('不要说「闲得慌」'));

    // Ordered by the plugin's own text rather than by prose: 翁法罗斯, for one,
    // appears inside the soul's canon quotes too, so a word search would place the
    // block in the wrong spot.
    const soulAt = prompt.indexOf('# 昔涟 · Soul');
    const correctionsAt = prompt.indexOf(corrections);
    const loreAt = prompt.indexOf(readAlwaysBlock().trim());
    assert.ok(soulAt >= 0 && loreAt > 0, 'soul and lore must both be present');
    assert.ok(correctionsAt > soulAt, 'corrections come after the body they amend');
    assert.ok(correctionsAt < loreAt, 'and before the lore, which is content rather than rules');
  });
});

/**
 * ⚠️ 种子：`corrections.md` 不存在时，从随包的 `corrections.default.md` 种一份。
 *
 * 理由在 `readStore()` 的注释里 —— 新装的人面对的**不该**是「一条修正都没有」的她。
 * 而那份默认的九条，正是「她说话像不像她」里落差最大的那部分。
 *
 * 这里刻意**不用** `withHome` —— 那个 helper 会先写一个空的 `corrections.md`
 * （好让上面那些「空起点」的用例成立），而这条要的恰恰是「文件不存在」。
 */
test('⚠️ 文件不存在时，种一份随包的默认修正（而只种一次）', async () => {
  const { readCorrectionsBlock } = await import('../corrections.mjs');
  const previous = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'cyrene-seed-'));
  process.env.DSH_HOME = home;
  try {
    const file = join(home, 'cyrene-agent', 'corrections.md');
    assert.equal(existsSync(file), false, '起点必须是「文件不存在」');

    const block = readCorrectionsBlock();
    assert.ok(block.includes('【你对说话方式的修正'), '种下去之后那一块就该有内容');
    assert.ok(existsSync(file), '文件被种出来了');

    const count = () => readFileSync(file, 'utf8').split('\n').filter((line) => line.startsWith('- ')).length;
    const n = count();
    assert.ok(n >= 5, `默认那份至少该有五条，实际 ${n}`);

    const after = readFileSync(file, 'utf8');
    readCorrectionsBlock();
    assert.equal(readFileSync(file, 'utf8'), after, '第二次读不该再种一遍');
    assert.equal(count(), n, '条数也不该变');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

