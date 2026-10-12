// 记忆状态的落盘。测的是**四条规矩**，每一条都是「不做的话会怎样」很具体的：
//
//   一、只存动过的       不做 → 文件里 132 条全是 0，没法读
//   二、消失的条目不删   不做 → 世界书一改，那条的记忆就没了
//   三、坏文件退兜底     不做 → 半个 JSON 让昔涟起不来
//   四、没状态的从底座进 不做 → 一条 priority 90 的设定头一次被问到排最后
//
// 前三条的失败都不会报错 —— 只会安静地做错事。所以要钉住。

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DEFAULT_PARAMS as P, baseFromPriority, emptyState } from '../dmae.mjs';
import { STATE_FILE, activationsFor, activationsOf, loadStates, nextTurnFrom, turnFrom, saveStates, stateOf, stepAll } from '../worldbook-activation.mjs';

/** 每个用例一个独立目录，免得互相看见对方的状态。 */
const scratch = () => mkdtempSync(join(tmpdir(), 'cyrene-act-'));

test('文件不存在 → 空 Map，不抛', () => {
  const dir = scratch();
  try {
    const { states, problems } = loadStates(join(dir, 'nope.json'));
    assert.equal(states.size, 0);
    assert.deepEqual(problems, [], '「文件还没有」是正常状态，不是问题');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('规矩一：只存动过的条目，静止的不占地方', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'state.json');
    const states = new Map([
      ['untouched', emptyState()],
      ['touched', { activation: 42.5, userSilence: 0, modelSilence: 1, recentUserHits: [7] }]
    ]);
    const { saved } = saveStates(file, states);
    assert.equal(saved, 1, '只该存动过的那一条');

    const back = loadStates(file).states;
    assert.equal(back.has('untouched'), false);
    assert.equal(back.get('touched').activation, 42.5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('规矩二：这次没出现的条目，文件里那条**还在**（默认合并）', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'state.json');
    // 第一次：两条
    saveStates(file, new Map([
      ['kept', { activation: 30, userSilence: 0, modelSilence: 0, recentUserHits: [] }],
      ['other', { activation: 50, userSilence: 0, modelSilence: 0, recentUserHits: [] }]
    ]));
    // 第二次：只写其中一条
    saveStates(file, new Map([
      ['kept', { activation: 35, userSilence: 0, modelSilence: 0, recentUserHits: [] }]
    ]));

    const back = loadStates(file).states;
    assert.equal(back.get('kept').activation, 35, '参与的那条更新了');
    // ⚠️ 第一版是整份覆盖，而我在测试里写「消失的由调用方负责」——**那是把责任推出去。**
    //    调用方只要有一次只传了「这一轮参与的」，其余条目的记忆就全没了，**而且不报错。**
    assert.equal(back.has('other'), true, '没参与的那条该保留 —— 默认是合并');
    assert.equal(back.get('other').activation, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('要删就用 forget 显式说，不是靠某次调用忘了带上', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'state.json');
    saveStates(file, new Map([
      ['a', { activation: 30, userSilence: 0, modelSilence: 0, recentUserHits: [] }],
      ['b', { activation: 40, userSilence: 0, modelSilence: 0, recentUserHits: [] }]
    ]));
    saveStates(file, new Map(), { forget: ['b'] });
    const back = loadStates(file).states;
    assert.equal(back.has('a'), true, '没点名的留着');
    assert.equal(back.has('b'), false, '点了名的才删');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('合并不会把已有条目又滤掉一遍', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'state.json');
    saveStates(file, new Map([['x', { activation: 25, userSilence: 0, modelSilence: 0, recentUserHits: [] }]]));
    // 再存一次，这次没带 x —— 它该原样留着，不是被 `WORTH_SAVING` 滤掉
    saveStates(file, new Map());
    assert.equal(loadStates(file).states.get('x').activation, 25);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('规矩三之一：坏 JSON → 空 Map，且**不删原文件**', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'state.json');
    writeFileSync(file, '{ 这不是 JSON', 'utf8');
    const { states, problems } = loadStates(file);
    assert.equal(states.size, 0);
    assert.equal(problems.length, 1, '该报出来');
    assert.ok(existsSync(file), '**不该删** —— 它是唯一能查当时发生了什么的东西');
    assert.equal(readFileSync(file, 'utf8'), '{ 这不是 JSON', '内容也不该动');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('规矩三之二：版本不认识 → 空 Map，不猜', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'state.json');
    writeFileSync(file, JSON.stringify({ schema: 999, states: { a: { activation: 50 } } }), 'utf8');
    const { states, problems } = loadStates(file);
    assert.equal(states.size, 0, '不认识的版本不许硬读');
    assert.match(problems[0], /版本/, '而且要说清是版本问题');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('规矩三之三：形状对了但字段坏了 → 跳过那一条，别整份丢掉', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'state.json');
    writeFileSync(file, JSON.stringify({
      schema: 1,
      states: {
        good: { activation: 40, userSilence: 1, modelSilence: 0, recentUserHits: [3] },
        bad: { activation: 'not a number' },
        nullish: null,
        partial: { activation: 12 }
      }
    }), 'utf8');
    const { states } = loadStates(file);
    assert.equal(states.get('good').activation, 40);
    assert.equal(states.has('bad'), false, '坏的那条跳过');
    assert.equal(states.has('nullish'), false);
    // 缺字段的补默认值，而不是整条丢掉
    assert.equal(states.get('partial').activation, 12);
    assert.deepEqual(states.get('partial').recentUserHits, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('写盘是原子的 —— 先写 .tmp 再改名，不留半个 JSON', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'state.json');
    saveStates(file, new Map([['a', { activation: 20, userSilence: 0, modelSilence: 0, recentUserHits: [] }]]));
    assert.equal(existsSync(`${file}.tmp`), false, '临时文件该已经改名了');
    assert.doesNotThrow(() => JSON.parse(readFileSync(file, 'utf8')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('目录不存在会自己建', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'deep', 'nested', 'state.json');
    const { problems } = saveStates(file, new Map([['a', { activation: 20, userSilence: 0, modelSilence: 0, recentUserHits: [] }]]));
    assert.deepEqual(problems, []);
    assert.ok(existsSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 规矩四：没状态的从底座进场
 * ------------------------------------------------------------------ */

test('规矩四：没存过的条目从 A_base 进场，**不是 0**', () => {
  const entries = [
    { id: 'high', priority: 90 },
    { id: 'low', priority: 30 }
  ];
  const got = activationsFor(entries, new Map());
  assert.equal(got.get('high'), baseFromPriority(90, P), '90 的该从它自己的底座进');
  assert.equal(got.get('low'), baseFromPriority(30, P));
  assert.ok(got.get('high') > got.get('low'), '高的进场就比低的靠前');
  assert.notEqual(got.get('low'), 0, '**从 0 进的话，一条 priority 90 的头次被问到会排最后**');
});

test('存过的条目用存下来的值，不用底座', () => {
  const entries = [{ id: 'x', priority: 90 }];
  const states = new Map([['x', { ...emptyState(), activation: 5 }]]);
  assert.equal(activationsFor(entries, states).get('x'), 5, '聊过之后的实际值该盖过底座');
});

test('stateOf：没存过给空状态，不返回 undefined', () => {
  const s = stateOf(new Map(), 'nope');
  assert.deepEqual(s, emptyState());
  assert.equal(typeof s.activation, 'number', '下游会直接加它，不能是 undefined');
});

/* ------------------------------------------------------------------ *
 * stepAll：一轮推进所有条目
 * ------------------------------------------------------------------ */

/** 三条假条目。 */
const book = () => [
  { id: 'a', priority: 90, keywords: ['甲'], enabled: true },
  { id: 'b', priority: 60, keywords: ['乙'], enabled: true },
  { id: 'c', priority: 30, keywords: ['丙'], enabled: true }
];

test('stepAll：命中的涨，没命中的落 —— 两边都要动', () => {
  let states = new Map();
  // 第 1 轮：只有 a 命中
  states = stepAll(book(), states, new Set(['a']), 1);
  const after1 = { a: states.get('a').activation, b: states.get('b').activation, c: states.get('c').activation };
  assert.ok(after1.a > 0, 'a 涨了');

  // 第 2 轮：还是只有 a
  states = stepAll(book(), states, new Set(['a']), 2);
  assert.ok(states.get('b').activation < after1.b, '没命中的 b 该在落');
  assert.ok(states.get('c').activation < after1.c, '没命中的 c 也该在落');
});

test('stepAll：只推命中的那些是错的 —— 没命中的也必须走一遍', () => {
  // 这一条钉的是「涨和落是一件事的两面」。只推命中的话，
  // 没命中的永远停在原地，**那就没有「淡出」了，整套东西也就没意义了。**
  let states = stepAll(book(), new Map(), new Set(['a']), 1);
  const b1 = states.get('b').activation;
  states = stepAll(book(), states, new Set(['a']), 2);
  assert.notEqual(states.get('b').activation, b1, 'b 必须动');
});

test('stepAll：没存过的从底座进场，然后**当轮就落一次**', () => {
  // ⚠️ 第一版我期望它返回**正好** `A_base`（42），而实际是 40.2 —— **测试错了，代码对。**
  //
  //    因为 `stepAll` 先把新条目放在底座，然后走一遍 `step`；
  //    而它这一轮没被提到，所以 `userSilence` 从 0 变 1，**就该落一次**。
  //
  //    这件事顺带说清了两个函数的分工：
  //
  //        activationsFor    **排序用** —— 给没见过的条目**正好** `A_base`
  //                          （它只回答「这条现在该按什么排」，不推进时间）
  //        stepAll           **推进用** —— 推进一轮，含那一轮的涨落
  //
  //    一轮的次序是：**先 `activationsFor` 排序 → 挑完 → 再 `stepAll` 推进。**
  //    用错顺序的话，新条目在它露面那一轮就已经被算作「沉默了一轮」。
  const states = stepAll(book(), new Map(), new Set(), 1);
  const base90 = baseFromPriority(90, P);
  const got = states.get('a').activation;

  assert.ok(got < base90, '落过一次，所以比底座低');
  assert.ok(got > base90 * 0.9, `但只落一点点（实际 ${got.toFixed(2)}，底座 ${base90}）`);
  assert.ok(got > states.get('c').activation, '高 priority 的进场就比低的靠前');
  assert.ok(states.get('c').activation > 0, '**进场不是 0** —— 从 0 进的话 priority 90 的头次被问到会排最后');
});

test('stepAll：已经不在世界书里的条目原样带过去，不删', () => {
  const before = new Map([['gone', { activation: 55, userSilence: 2, modelSilence: 0, recentUserHits: [1] }]]);
  const after = stepAll(book(), before, new Set(), 5);
  assert.equal(after.get('gone').activation, 55, '它还在 —— 世界书会改，那条记忆不该跟着消失');
  assert.equal(after.get('gone').userSilence, 2, '而且不是空状态，是原样');
});

test('stepAll：坏条目（没有 id）跳过，不炸', () => {
  const entries = [...book(), null, { priority: 60 }, { id: 'ok', priority: 60, keywords: [] }];
  const states = stepAll(entries, new Map(), new Set(), 1);
  assert.equal(states.has('ok'), true);
  assert.equal(states.has(undefined), false);
});

test('stepAll：连跑若干轮，常提起的和久没提起的真的分开了', () => {
  let states = new Map();
  for (let turn = 1; turn <= 8; turn += 1) {
    states = stepAll(book(), states, new Set(['a']), turn);
  }
  const hot = states.get('a').activation;
  const cold = states.get('c').activation;
  assert.ok(hot > cold, `八轮之后 a(${hot.toFixed(1)}) 该远高于 c(${cold.toFixed(1)})`);
});

test('activationsOf：只取激活度，坏值跳过', () => {
  const got = activationsOf(new Map([
    ['a', { activation: 40 }],
    ['b', { activation: Number.NaN }],
    ['c', { activation: 0 }]
  ]));
  assert.equal(got.get('a'), 40);
  assert.equal(got.has('b'), false, '坏值不进表');
  assert.equal(got.get('c'), 0, '**0 是合法值**，不该被当成坏的');
});

/* ------------------------------------------------------------------ *
 * ⚠️ 会话交错：为什么 `turn` 的来源是个要定的问题（设计文档第八节）
 * ------------------------------------------------------------------ *
 *
 * 这一组**不是在测现在的行为对不对**，是在把一个会安静失灵的场景钉下来。
 *
 * 生产里 `turn` 来自 `log.nextTurn(sessionId)` —— **按会话**。
 * 而激活状态是一份全局文件。两者交错时，那个「最近提过几次」的窗口会失效，
 * **而且不报错。**
 */

test('交错两个会话 → 用按会话的轮号会让窗口失效（这就是要定的那件事）', () => {
  const entries = book();
  let states = new Map();

  // 会话 A 先走 20 轮，每轮都提 a
  for (let turn = 1; turn <= 20; turn += 1) {
    states = stepAll(entries, states, new Set(['a']), turn);
  }
  const aBefore = states.get('a').recentUserHits.length;
  assert.ok(aBefore > 0, 'A 的窗口里该有东西');

  // 现在换到会话 B —— 它的轮号从 1 开始。
  // ⚠️ 这就是生产里会发生的事：同一份状态，另一套轮号。
  states = stepAll(entries, states, new Set(['a']), 1);

  // 断言：`userSilence` 被重置了（这是对的），但**窗口是错的** ——
  // 第 21 轮（A 的编号）留下的痕迹，在 B 的 `turn = 1` 看来是「未来」。
  const kept = states.get('a').recentUserHits;
  assert.ok(
    kept.some((t) => t > 1),
    `窗口里留着比当前轮号还大的值：${JSON.stringify(kept)} —— ` +
      '这正是「两套轮号塞进一份状态」的样子'
  );
});

test('同一个轮号下连提两次 → 窗口按 repeatWindow 过滤，行为是对的', () => {
  // 对照组：**轮号单调时**窗口该正常工作。
  // 有这一条才说明上面那个失败不是「窗口实现坏了」，而是「轮号来源不对」。
  const entries = book();
  let states = new Map();
  states = stepAll(entries, states, new Set(['a']), 1);
  assert.equal(states.get('a').recentUserHits.length, 1);

  // 提第二次（第 2 轮）
  states = stepAll(entries, states, new Set(['a']), 2);
  assert.equal(states.get('a').recentUserHits.length, 2, '窗口里该有两次');

  // 跳过一个完整的窗口再提
  const far = 2 + P.repeatWindow + 1;
  states = stepAll(entries, states, new Set(['a']), far);
  assert.equal(states.get('a').recentUserHits.length, 1, '老的该被挤出去，只剩这一次');
});

/* ------------------------------------------------------------------ *
 * 轮号：必须跨重启单调
 * ------------------------------------------------------------------ *
 *
 * ⚠️ 这是设计文档第八节那个问题的另一半 —— 我当时只说了「会话交错」，
 * **漏了「进程重启」**。而它们是同一个病：
 *
 *     轮号从 0 重来 → 窗口里那些旧值（比如 200）变成了「未来」→ 永久失效
 *
 * 而 `DEFAULT_WINDOW_MS` 的注释里记着，**这个项目上一版就栽在这上面**
 * （「轮号做锚点会在重启/热重载后错乱」）。所以这次一开始就把轮号存下来。
 */

test('nextTurnFrom：从存的轮号往下数', () => {
  assert.equal(nextTurnFrom(0), 1, '第一次');
  assert.equal(nextTurnFrom(7), 8);
  assert.equal(nextTurnFrom(200), 201);
});

test('nextTurnFrom：坏值和缺失都给 1，**不给猜的值**', () => {
  for (const bad of [undefined, null, Number.NaN, -5, 'x', {}]) {
    assert.equal(nextTurnFrom(bad), 1, `${String(bad)} 该退到 1`);
  }
});

test('轮号存得下来、读得回来', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'state.json');
    const s = new Map([['a', { activation: 30, userSilence: 0, modelSilence: 0, recentUserHits: [5] }]]);
    saveStates(file, s, { turn: 5 });
    const back = loadStates(file);
    assert.equal(back.turn, 5);
    assert.equal(nextTurnFrom(back.turn), 6, '下一轮接着数');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⚠️ 跨「重启」单调：重开一次进程，轮号不归零', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'state.json');
    // 第一次「运行」：走 30 轮
    let s = new Map();
    for (let turn = 1; turn <= 30; turn += 1) s = stepAll(book(), s, new Set(['a']), turn);
    saveStates(file, s, { turn: 30 });

    // 「重启」：重新读一遍（内存里的东西全没了）
    const after = loadStates(file);
    assert.equal(after.turn, 30, '轮号活着');

    const next = nextTurnFrom(after.turn);
    assert.equal(next, 31, '**不是从 1 重来**');

    // 而窗口里的旧值不会变成「未来」
    const kept = after.states.get('a').recentUserHits;
    assert.ok(
      kept.every((t) => t <= 30),
      `窗口里的值不该超过已记的轮号：${JSON.stringify(kept)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('轮号只增不减 —— 传一个更小的进去不会倒退', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'state.json');
    saveStates(file, new Map(), { turn: 50 });
    const out = saveStates(file, new Map(), { turn: 3 });
    assert.equal(out.turn, 50, '倒退的轮号会让窗口错乱，而那是这套东西最难查的坏法');
    assert.equal(loadStates(file).turn, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('不传 turn 时沿用文件里那个，不会把轮号抹掉', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'state.json');
    saveStates(file, new Map(), { turn: 42 });
    saveStates(file, new Map([['x', { activation: 10, userSilence: 0, modelSilence: 0, recentUserHits: [] }]]));
    assert.equal(loadStates(file).turn, 42, '省了 turn 就该沿用，不是归零');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('老文件没有 turn 字段 → 当 0，下一轮从 1 开始', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'state.json');
    writeFileSync(file, JSON.stringify({
      schema: 1,
      states: { a: { activation: 30, userSilence: 0, modelSilence: 0, recentUserHits: [] } }
    }), 'utf8');
    const back = loadStates(file);
    assert.equal(back.turn, 0, '没有就是 0');
    assert.equal(nextTurnFrom(back.turn), 1, '安全的下界');
    assert.equal(back.states.get('a').activation, 30, '而状态照常读得出来');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

test('状态文件在 data/ 下 —— 那是每台机器自己的目录', () => {
  assert.match(STATE_FILE, /^data[/\\]/);
  // `make-share.mjs` 的排除表里有 `data`，所以这个目录不会随包走。
  // 这里只断言路径形状 —— 真的去读那份排除表会让这个测试依赖另一个文件。
  assert.doesNotMatch(STATE_FILE, /^\.\./);
});
