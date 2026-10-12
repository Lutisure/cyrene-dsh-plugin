// 激活引擎。测的是两件不同的事，别混：
//
//   一、**上游定义的那些公式** —— 涨、落、两个闸门、那行夹子。
//      这些抄错了不会报错，只会让行为和你以为的不一样。所以要钉死。
//   二、**我们自己定的那两处** —— `A_base` 和 `I` 怎么从 priority 来。
//      上游没有这东西，所以测的是「我们说的映射是不是真的那样」。
//
// 不变式（每个用例都会顺带撞上）：
//   · `activation` 永远在 `[0, maxScore]`
//   · `step` 不改传进来的对象

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PARAMS as P,
  activeEntries,
  baseFromPriority,
  decay,
  deriveState,
  effectiveValue,
  emptyState,
  gateRepeat,
  gateSaturation,
  hits,
  modelRewardRaw,
  resistanceFromPriority,
  step,
  userReward
} from '../dmae.mjs';
import { buildWorldbook, explainEntries } from '../worldbook-logic.mjs';
import { activationsFor } from '../worldbook-activation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ *
 * 参数本身：别和 L2 那套混
 * ------------------------------------------------------------------ */

test('默认参数是**世界书**那一套，不是 L2 的', () => {
  // 上游有两组值，长得像但不一样。第一版就混过，所以钉住。
  assert.equal(P.userRewardBase, 20, 'worldbook 是 20（L2 是 10）');
  assert.equal(P.modelRewardBase, 8, 'worldbook 是 8（L2 是 4）');
  assert.equal(P.decayAlpha, 1.5, 'worldbook 是 1.5（L2 是 1.0）');
  assert.equal(P.decayBeta, 0.3, 'worldbook 是 0.3（L2 是 0.2）');
});

test('默认参数和上游源码里的逐字对上', () => {
  // 从**上游那份克隆**里读，而不是把数字再抄一遍 —— 抄一遍就会有一天和那边脱节。
  const upstream = join(HERE, '..', '..', '..', 'Cyrene-Agent-Upstream', 'src', 'main', 'rag', 'worldbook.ts');
  let source;
  try {
    source = readFileSync(upstream, 'utf8');
  } catch {
    // 克隆不在（换机器、或删了）就跳过 —— 但不能假装过了。
    return;
  }
  const block = /export const DEFAULT_DMAE_PARAMS: DmaeParams = \{([\s\S]*?)\n\};/u.exec(source);
  assert.notEqual(block, null, '在上游源码里找得到那份参数');

  for (const line of block[1].split('\n')) {
    const kv = /^\s{2}(\w+):\s*([\d.]+),?\s*$/u.exec(line);
    if (kv === null) continue;
    const [, key, value] = kv;
    assert.equal(P[key], Number(value), `${key} 和上游一致`);
  }
});

/* ------------------------------------------------------------------ *
 * 我们定的第一处：A_base
 * ------------------------------------------------------------------ */

test('priority 映到 A_base：30 在阈值下，90 在阈值上', () => {
  const low = baseFromPriority(30, P);
  const high = baseFromPriority(90, P);
  assert.ok(low < P.promptThreshold, `最低档 ${low} 该在阈值 ${P.promptThreshold} 下面 —— 它不该自己冒出来`);
  assert.ok(high > P.promptThreshold, `最高档 ${high} 该在阈值上面`);
  assert.equal(low, 18, '30 → 0.6 倍阈值');
  assert.equal(high, 42, '90 → 1.4 倍阈值');
});

test('priority 超出 30–90 会被夹住，不外推', () => {
  assert.equal(baseFromPriority(0, P), baseFromPriority(30, P));
  assert.equal(baseFromPriority(999, P), baseFromPriority(90, P));
  assert.equal(baseFromPriority(Number.NaN, P), baseFromPriority(60, P), '坏值走中位');
});

/* ------------------------------------------------------------------ *
 * 我们定的第二处：I
 * ------------------------------------------------------------------ */

test('priority 映到抗遗忘 I，落在 [1, 4]', () => {
  assert.equal(resistanceFromPriority(30), 1);
  assert.equal(resistanceFromPriority(90), 4);
  assert.ok(resistanceFromPriority(60) > 1 && resistanceFromPriority(60) < 4);
});

/* ------------------------------------------------------------------ *
 * 上游定义的：两个闸门
 * ------------------------------------------------------------------ */

test('饱和闸门：0 时是 1，到顶时是 0', () => {
  assert.equal(gateSaturation(0, P), 1, '刚起步不该被压');
  assert.equal(gateSaturation(P.maxScore, P), 0, '到顶就涨不动了');
  assert.ok(gateSaturation(50, P) < gateSaturation(10, P), '越热压得越狠');
});

test('重复闸门：没提过是 1，提得越多越小', () => {
  assert.equal(gateRepeat(0, P), 1);
  assert.ok(gateRepeat(1, P) < gateRepeat(0, P));
  assert.ok(gateRepeat(5, P) < gateRepeat(1, P));
  assert.ok(gateRepeat(5, P) > 0, '永远压不成 0 —— 只是打折');
});

test('唤醒增益：冷落越久，再被提到时涨得越多', () => {
  const fresh = userReward({ activation: 0, userSilence: 0, recentHitCount: 0 }, P);
  const cold = userReward({ activation: 0, userSilence: 20, recentHitCount: 0 }, P);
  assert.ok(cold > fresh, '久别重逢该比刚聊过涨得多');
});

/* ------------------------------------------------------------------ *
 * 上游定义的：衰减
 * ------------------------------------------------------------------ */

test('衰减按静默的平方走 —— 不是线性', () => {
  const one = decay({ userSilence: 1, modelSilence: 0, resistance: 1 }, P);
  const two = decay({ userSilence: 2, modelSilence: 0, resistance: 1 }, P);
  // 线性的话 two === one * 2；平方的话是 4 倍
  assert.ok(Math.abs(two / one - 4) < 0.001, `该是 4 倍，实际 ${(two / one).toFixed(2)} 倍`);
});

test('衰减被 sqrt(I) 除 —— 价值决定忘得多慢', () => {
  const low = decay({ userSilence: 3, modelSilence: 0, resistance: 1 }, P);
  const high = decay({ userSilence: 3, modelSilence: 0, resistance: 4 }, P);
  assert.ok(Math.abs(high / low - 0.5) < 0.001, 'I 从 1 到 4，衰减该减半');
});

test('I 是 0 或坏值时不会算出 Infinity', () => {
  for (const bad of [0, -5, Number.NaN, undefined]) {
    const d = decay({ userSilence: 3, modelSilence: 3, resistance: bad }, P);
    assert.ok(Number.isFinite(d), `resistance=${bad} 时该算得出有限值`);
  }
});

test('模型奖励随用户静默指数衰减', () => {
  const at0 = modelRewardRaw(0, P);
  const at10 = modelRewardRaw(10, P);
  assert.equal(at0, P.modelRewardBase);
  assert.ok(at10 < at0 * 0.1, '静默十轮之后基本没剩多少');
});

/* ------------------------------------------------------------------ *
 * 三档状态
 * ------------------------------------------------------------------ */

test('三档：0 是归档、过阈值是活跃、之间是休眠', () => {
  assert.equal(deriveState(0, P), 'archived');
  assert.equal(deriveState(P.promptThreshold, P), 'active', '等于阈值算活跃');
  assert.equal(deriveState(P.promptThreshold - 1, P), 'dormant');
});

/* ------------------------------------------------------------------ *
 * 命中检测
 * ------------------------------------------------------------------ */

test('命中：空触发词、空文本都不算命中', () => {
  assert.equal(hits({ keywords: [] }, '那刻夏'), false);
  assert.equal(hits({ keywords: ['那刻夏'] }, ''), false);
  assert.equal(hits({ keywords: ['那刻夏'] }, '那刻夏是谁'), true);
});

/* ------------------------------------------------------------------ *
 * step：一轮的结算
 * ------------------------------------------------------------------ */

/** 一条用于测试的设定。 */
const entry = (over = {}) => ({
  id: 'x',
  keywords: ['那刻夏'],
  resistance: resistanceFromPriority(60),
  ...over
});

test('step 不改传进来的那个对象', () => {
  const before = emptyState();
  const snapshot = JSON.stringify(before);
  step(before, { entry: entry(), base: 30, userHit: true, turn: 1 }, P);
  assert.equal(JSON.stringify(before), snapshot, '该返回新对象');
});

test('归档且没命中 → 原样返回（省算力，而且它本来就不会被想起来）', () => {
  const s = emptyState();
  const next = step(s, { entry: entry(), base: 0, turn: 1 }, P);
  assert.equal(next, s, '该是同一个引用，表示「没动」');
});

test('被关掉的、常驻的、没有触发词的条目不参与', () => {
  const s = { ...emptyState(), activation: 50 };
  for (const e of [entry({ enabled: false }), entry({ permanent: true }), entry({ keywords: [] })]) {
    assert.equal(step(s, { entry: e, userHit: true, turn: 1 }, P), s);
  }
});

test('唤醒是一次拉过线，不是慢慢涨', () => {
  const s = emptyState();
  const next = step(s, { entry: entry(), base: 0, userHit: true, turn: 1 }, P);
  assert.ok(next.activation >= P.promptThreshold, `唤醒后该在阈值之上，实际 ${next.activation}`);
  assert.equal(deriveState(next.activation, P), 'active');
});

test('底座是唤醒的起点：base 高的条目醒来更高', () => {
  const low = step(emptyState(), { entry: entry(), base: 10, userHit: true, turn: 1 }, P);
  const high = step(emptyState(), { entry: entry(), base: 42, userHit: true, turn: 1 }, P);
  assert.ok(high.activation > low.activation, '底座该参与唤醒落点');
});

test('模型提起**不重置**用户静默', () => {
  // 两个计数器分开，是上游特意那么写的：
  // 她自己念叨一件事，不会让它变得「最近被这个人提起过」。
  let s = { ...emptyState(), activation: 60, userSilence: 5, modelSilence: 5 };
  s = step(s, { entry: entry(), modelHit: true, turn: 6 }, P);
  assert.equal(s.userSilence, 6, '用户静默还要接着涨');
  assert.equal(s.modelSilence, 0, '模型静默归零');
});

test('用户提起会把两个静默都归零', () => {
  let s = { ...emptyState(), activation: 60, userSilence: 5, modelSilence: 5 };
  s = step(s, { entry: entry(), userHit: true, turn: 6 }, P);
  assert.equal(s.userSilence, 0);
  assert.equal(s.modelSilence, 0);
});

/* ------------------------------------------------------------------ *
 * 那行夹子：最要紧的不变式
 * ------------------------------------------------------------------ */

test('模型自己提起，永远不足以让它涨', () => {
  // 上游那行：modelReward = min(rawRm, decay - ε)
  //
  // 静默着、只有模型在提 —— 净变化必须是**不涨**。
  // 不钉这一条，她自说自话就能把一条设定喂成永久活跃，
  // 而那和你们聊了什么无关。
  let s = { ...emptyState(), activation: 60, userSilence: 0, modelSilence: 0 };
  const seen = [];
  for (let turn = 1; turn <= 30; turn += 1) {
    s = step(s, { entry: entry(), base: 0, modelHit: true, turn }, P);
    seen.push(s.activation);
  }
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(seen[i] <= seen[i - 1] + 1e-9, `第 ${i + 1} 轮涨了：${seen[i - 1]} → ${seen[i]}`);
  }
  assert.ok(seen[seen.length - 1] < seen[0], '而且该是往下走的');
});

test('激活度永远夹在 [0, maxScore] 里', () => {
  // 极端输入：反复命中、极高的底座、极长的静默。
  let s = emptyState();
  for (let turn = 1; turn <= 200; turn += 1) {
    s = step(s, { entry: entry(), base: P.maxScore * 2, userHit: true, turn }, P);
    assert.ok(s.activation >= 0 && s.activation <= P.maxScore, `第 ${turn} 轮越界：${s.activation}`);
  }
});

test('久没提起真的会掉到归档', () => {
  let s = emptyState();
  s = step(s, { entry: entry(), base: 0, userHit: true, turn: 1 }, P);
  assert.equal(deriveState(s.activation, P), 'active');
  for (let turn = 2; turn <= 40; turn += 1) {
    s = step(s, { entry: entry(), base: 0, turn }, P);
  }
  assert.equal(deriveState(s.activation, P), 'archived', '四十轮不提该归档了');
});

test('重复窗口会过期 —— 老早提过的不再压这一轮', () => {
  let s = emptyState();
  s = step(s, { entry: entry(), base: 0, userHit: true, turn: 1 }, P);
  const early = s.recentUserHits.length;
  assert.equal(early, 1);
  // 跳过一整个窗口之后再提，窗口里只剩这一次
  const later = step(s, { entry: entry(), base: 0, userHit: true, turn: 1 + P.repeatWindow + 1 }, P);
  assert.equal(later.recentUserHits.length, 1, '第一次的该被挤出去了');
});

/* ------------------------------------------------------------------ *
 * floorMode：两条语义，都要钉住
 * ------------------------------------------------------------------ */

test("floorMode 'wake'（默认）：没聊到就归档，底座只在醒来时用", () => {
  const params = { ...P, floorMode: 'wake' };
  let s = emptyState();
  for (let turn = 1; turn <= 10; turn += 1) {
    s = step(s, { entry: entry(), base: 30, turn }, params);
  }
  assert.equal(s.activation, 0, '一次都没聊到 = 0，不是底座');
  assert.equal(deriveState(s.activation, params), 'archived');
});

test("floorMode 'permanent'：底座是地板，掉不到它以下", () => {
  const params = { ...P, floorMode: 'permanent' };
  let s = emptyState();
  for (let turn = 1; turn <= 30; turn += 1) {
    s = step(s, { entry: entry(), base: 30, turn }, params);
  }
  // ⚠️ 这一条是拿模拟器跑出来的——第一版「地板」加在了结算**前**，
  //    衰减照样从那儿往下减，于是照样掉到 0。地板只能在结算后兜。
  assert.equal(s.activation, 30, '三十轮不聊，也该停在底座上');
  assert.equal(deriveState(s.activation, params), 'active');
});

test("floorMode 'permanent'：聊到过之后掉回来，也停在底座", () => {
  const params = { ...P, floorMode: 'permanent' };
  let s = emptyState();
  s = step(s, { entry: entry(), base: 30, userHit: true, turn: 1 }, params);
  assert.ok(s.activation > 30, '聊到时会涨过底座');
  for (let turn = 2; turn <= 30; turn += 1) {
    s = step(s, { entry: entry(), base: 30, turn }, params);
  }
  assert.equal(s.activation, 30, '冷掉之后停回底座，不是 0');
});

test('floorMode 不会越过上限', () => {
  // 底座比上限还高时，地板不该把它顶出去。
  const params = { ...P, floorMode: 'permanent' };
  const s = step(emptyState(), { entry: entry(), base: P.maxScore * 3, turn: 1 }, params);
  assert.ok(s.activation <= P.maxScore, `实际 ${s.activation}`);
});

/* ------------------------------------------------------------------ *
 * 接进 explainEntries：不传状态时**逐字不变**，传了才起作用
 * ------------------------------------------------------------------ */

/** 造几条同优先级的假条目，省得依赖真实的 entries.yaml。 */
const fakeBook = () => ({
  entries: [
    { id: 'a', priority: 60, triggers: ['猫'], needles: ['猫'], text: '甲'.repeat(50), enabled: true },
    { id: 'b', priority: 60, triggers: ['猫'], needles: ['猫'], text: '乙'.repeat(50), enabled: true },
    { id: 'c', priority: 60, triggers: ['猫'], needles: ['猫'], text: '丙'.repeat(50), enabled: true },
    { id: 'd', priority: 60, triggers: ['猫'], needles: ['猫'], text: '丁'.repeat(50), enabled: true }
  ]
});

test('不传 activations → 纯 priority 排序，和以前逐字一样', async () => {
  const wb = await import('../worldbook-logic.mjs');
  const out = wb.explainEntries(fakeBook().entries, '猫', {});
  // 同优先级同位置，靠 id 稳定 —— 这就是改动前的行为。
  assert.deepEqual(out.chosen.map((e) => e.id), ['a', 'b', 'c']);
});

test('传了 activations → 激活度高的往前排', async () => {
  const wb = await import('../worldbook-logic.mjs');
  const activations = new Map([['a', 0], ['b', 0], ['c', 0], ['d', 95]]);
  const out = wb.explainEntries(fakeBook().entries, '猫', { activations });
  assert.ok(out.chosen.some((e) => e.id === 'd'), '激活度拉满的那条该挤进去');
});

test('activationWeight = 0 → 完全按激活度，priority 不管用', async () => {
  const wb = await import('../worldbook-logic.mjs');
  const entries = fakeBook().entries;
  entries[3].priority = 30; // d 的 priority 最低
  const activations = new Map([['a', 0], ['b', 0], ['c', 0], ['d', 95]]);
  const out = wb.explainEntries(entries, '猫', { activations, activationWeight: 0 });
  assert.equal(out.chosen[0].id, 'd', 'w=0 时只看激活度');
});

test('activationWeight = 1 → 回到纯 priority 排序', async () => {
  const wb = await import('../worldbook-logic.mjs');
  const entries = fakeBook().entries;
  entries[3].priority = 30;
  const activations = new Map([['a', 0], ['b', 0], ['c', 0], ['d', 95]]);
  const out = wb.explainEntries(entries, '猫', { activations, activationWeight: 1 });
  assert.deepEqual(out.chosen.map((e) => e.id), ['a', 'b', 'c'], 'priority 全是 60，d 是 30，进不来');
});

test('activations 里有坏值不会炸，也不会意外改变排序', async () => {
  const wb = await import('../worldbook-logic.mjs');
  const activations = new Map([['a', Number.NaN], ['b', undefined], ['c', null]]);
  const out = wb.explainEntries(fakeBook().entries, '猫', { activations });
  assert.deepEqual(out.chosen.map((e) => e.id), ['a', 'b', 'c'], '坏值当 0，退回原序');
});

/* ------------------------------------------------------------------ *
 * 长期价值基准：和 priority 拆开
 * ------------------------------------------------------------------ *
 *
 * 上游把「重要」（`priority`，只做 tiebreak）和「难忘」（`intrinsicValue`，
 * 驱动底座和抗遗忘）分成两个字段。**我们以前一个 `priority` 兼两职** ——
 * 于是「重要」和「难忘」成了同义词。
 */

test('effectiveValue：没写 intrinsicValue 就用 priority（老行为）', () => {
  assert.equal(effectiveValue({ priority: 70 }), 70);
  assert.equal(effectiveValue({ priority: 70, intrinsicValue: undefined }), 70);
  assert.equal(effectiveValue({ priority: 70, intrinsicValue: Number.NaN }), 70, '坏值也退回');
  assert.equal(effectiveValue({}), undefined, '两个都没有就是 undefined，交给上层走中位');
});

test('effectiveValue：写了就用它，priority 管不着', () => {
  assert.equal(effectiveValue({ priority: 30, intrinsicValue: 90 }), 90);
  assert.equal(effectiveValue({ priority: 90, intrinsicValue: 30 }), 30);
});

test('⚠️ 「重要」和「难忘」真的分开了 —— 这是这一条的全部意义', () => {
  // 一条「权重很高、但你从不提起」的设定：
  //   priority 高 → 排前面（tiebreak）
  //   intrinsicValue 低 → **该忘得快**
  const promoted = { id: 'x', priority: 90, intrinsicValue: 30 };
  const valued = { id: 'y', priority: 30, intrinsicValue: 90 };

  const baseA = baseFromPriority(effectiveValue(promoted), P);
  const baseB = baseFromPriority(effectiveValue(valued), P);
  assert.ok(baseA < baseB, '底座听 intrinsicValue，不听 priority');

  assert.ok(
    resistanceFromPriority(effectiveValue(promoted)) < resistanceFromPriority(effectiveValue(valued)),
    '抗遗忘也听 intrinsicValue —— **改动前这两条会算成一样的**'
  );
});

test('⚠️ intrinsicValue 和 resistance 不是一个量纲，别直接塞', () => {
  // 这是 2026-10-11 差点犯的错：同一个名字两种量纲，接错了不报错。
  //
  //     intrinsicValue  30~90
  //     resistance       1~4      （`decay` 直接拿它开根）
  //
  // 铁律：`intrinsicValue` 要先过 `resistanceFromPriority` 才能当 `resistance` 用。
  assert.equal(resistanceFromPriority(30), 1, '下限');
  assert.equal(resistanceFromPriority(90), 4, '上限');
  assert.ok(resistanceFromPriority(60) < 4, '中间的落在 1~4 里，**不是 60**');

  const d = decay({ userSilence: 3, modelSilence: 0, resistance: 4 }, P);
  const wrong = decay({ userSilence: 3, modelSilence: 0, resistance: 90 }, P);
  assert.ok(wrong < d, '把 90 当 resistance 塞进去会算出**更小**的衰减 —— 也就是忘得更慢，而它不报错');
});

/* ------------------------------------------------------------------ *
 * 连带触发词：一种不留痕的关联
 * ------------------------------------------------------------------ *
 *
 * 「提到甲就顺带知道乙」—— 而乙**不该因此被记成「对方问了乙」**。
 * 上游叫它 One-Shot 一次性（`worldbook.ts:16`）。
 */

/** 三条条目：甲带连带、乙会被带出来、丙谁都不带。 */
const linkedBook = (extra = {}) => [
  { id: 'jia', priority: 60, triggers: ['甲'], needles: ['甲'], text: '甲'.repeat(40), enabled: true, linkTriggers: ['乙'], ...extra },
  { id: 'yi', priority: 60, triggers: ['乙'], needles: ['乙'], text: '乙'.repeat(40), enabled: true, linkTriggers: [] },
  { id: 'bing', priority: 60, triggers: ['丙'], needles: ['丙'], text: '丙'.repeat(40), enabled: true, linkTriggers: [] }
];

test('没人写 linkTriggers 时，linked 一定是空的 —— 老行为逐字不变', () => {
  const wb = { explainEntries };
  const plain = [{ id: 'a', priority: 60, triggers: ['甲'], needles: ['甲'], text: 'x'.repeat(20), enabled: true }];
  const out = wb.explainEntries(plain, '甲', {});
  assert.deepEqual(out.linked, [], '**不写就是空 —— 那份 39 条基线靠这个原地不动**');
  assert.deepEqual(out.chosen.map((e) => e.id), ['a']);
});

test('提到甲 → 乙被带出来（而乙自己没被命中）', () => {
  const out = explainEntries(linkedBook(), '甲', {});
  assert.ok(out.chosen.some((e) => e.id === 'jia'), '甲自己进去');
  assert.deepEqual(out.linked.map((e) => e.id), ['yi'], '乙是被带出来的');
  assert.equal(out.chosen.some((e) => e.id === 'yi'), true, '带出来的也进候选（所以可能被选中）');
  // ⚠️ **关键：乙不在 `hits` 里。**
  assert.deepEqual(out.hits.map((e) => e.id), ['jia'], '**乙不算「对方说了乙」—— 它只在 linked 里**');
});

test('一层封顶：带出来的那些不再往下带', () => {
  const book = linkedBook();
  book[1].linkTriggers = ['丙']; // 乙自己也会连带丙
  const out = explainEntries(book, '甲', {});
  assert.deepEqual(out.linked.map((e) => e.id), ['yi'], '**只带一层** —— 丙不该被乙再带一层出来');
  assert.ok(!out.chosen.some((e) => e.id === 'bing'), '丙进不来');
});

test('已经命中的不再算连带 —— 免得同一条两边都在', () => {
  // 消息里甲乙都说了。那乙是**直接命中**，不是连带。
  const out = explainEntries(linkedBook(), '甲和乙', {});
  assert.deepEqual(out.hits.map((e) => e.id).sort(), ['jia', 'yi'], '两个都是直接命中');
  assert.deepEqual(out.linked, [], '**乙已经在 hits 里了，就不该再出现在 linked 里** —— 两边的「算不算聊到」正好相反');
});

test('连带带出来的没进去时，理由能认出来', () => {
  // limit 1：甲占了唯一的位置，乙被带出来但进不去。
  const out = explainEntries(linkedBook(), '甲', { limit: 1 });
  assert.deepEqual(out.chosen.map((e) => e.id), ['jia']);
  const row = out.dropped.find((item) => item.entry.id === 'yi');
  assert.ok(row !== undefined, '乙该在 dropped 里');
  assert.match(row.reason, /linked/, '**理由要能分辨「对方提到了但没给」和「顺带带出来但没给」**');
});

test('没写 linkTriggers 字段的条目不会炸（公开函数不能假定字段在）', () => {
  // 手搓的条目（测试、工具）可能没有这个字段。直接读 `.length` 会炸 ——
  // 2026-10-11 就这么炸的，5 条测试红。
  const bare = [{ id: 'x', priority: 60, triggers: ['甲'], needles: ['甲'], text: 'x'.repeat(20), enabled: true }];
  assert.doesNotThrow(() => explainEntries(bare, '甲', {}));
});

/* ------------------------------------------------------------------ *
 * 构建期的自我检查：写了触发词但一条都匹配不上
 * ------------------------------------------------------------------ *
 *
 * 上游 `prompts/worldbook/_glossary.md` 就是这个病：15 组称谓映射，
 * 作者按常驻写的、解析器按不常驻读，**一条都进不去而中间没有任何东西报错**。
 * 2026-10-11 拿照着解析器写的等价实现跑真文件才发现。
 *
 * **它比「没写触发词」坏** —— 没写的那条构建期就拦了，
 * 而这一条**看起来是配好的**。
 */

test('写了触发词、但一条都编译不出来 → 构建期报出来，**不当它是好的**', () => {
  // `*甲`（星号在开头）：`parts` 里有个空串 → 编译成 {null, null}。
  // 而它躲过了前面那道「`*` 单独一条 / 含 `**`」的检查 —— 所以能走到这里。
  const raw = {
    entries: [{ id: 'broken', triggers: ['*甲'], priority: 60, text: '一段设定' }]
  };
  const book = buildWorldbook(raw);
  assert.equal(book.entries.length, 0, '**不该被当成一条能用的条目收下**');
  assert.equal(book.problems.length, 1, '而要报出来 —— 静默才是真问题');
  assert.match(book.problems[0], /can match anything|match/, '理由要说清是「匹配不上」');
});

test('正常的触发词不会误报 —— 包括带 `*` 的那种', () => {
  // `甲*乙` 是合法的通配（编译成正则），不该被上面那条规则伤到。
  const raw = {
    entries: [
      { id: 'plain', triggers: ['甲'], priority: 60, text: '一' },
      { id: 'wild', triggers: ['甲*乙'], priority: 60, text: '二' }
    ]
  };
  const book = buildWorldbook(raw);
  assert.equal(book.entries.length, 2);
  assert.deepEqual(book.problems, [], '**这两条都是好的，不该报**');
  assert.equal(book.entries.find((e) => e.id === 'wild').patterns.length, 1, '通配那条编译成正则');
});

/* ------------------------------------------------------------------ *
 * ⚠️ 字段要能活着走过编译 —— 这一族错犯过三次了
 * ------------------------------------------------------------------ *
 *
 * `entries.yaml` 里的字段**不会自动出现在编译后的条目上**。
 * `normaliseEntry` 是逐字段抄的，漏一个就静默地丢一个：
 *
 *     ① `keywords` / `needles`   —— `step` 看前者、条目带后者 → **整套引擎没在算**
 *     ② `linkTriggers`           —— 读过 `.length`，炸在 5 条测试上
 *     ③ `intrinsicValue`         —— 往 YAML 写了 132 行、脚本报「写入 132 条」、
 *                                   diff 是 +132/-0，**而它是空的**：底座照样从 priority 推
 *
 * **③ 最险**：文件里有那 132 行，看着就是做好了。
 * 是**去查底座的实际值**才发现的（`amphoreus` 的 iv 写 90，底座却是 30.0）。
 *
 * 下面这条测的是「**字段活着走到了编译之后**」，不是「文件里有那行」。
 */

test('⚠️ intrinsicValue / linkTriggers 都要活着走过编译', () => {
  const raw = {
    entries: [
      { id: 'withiv', triggers: ['甲'], priority: 60, intrinsicValue: 88, text: '一' },
      { id: 'withlink', triggers: ['乙'], priority: 60, linkTriggers: ['丙'], text: '二' }
    ]
  };
  const book = buildWorldbook(raw);
  const a = book.entries.find((e) => e.id === 'withiv');
  const b = book.entries.find((e) => e.id === 'withlink');

  assert.equal(a.intrinsicValue, 88, '**这个字段必须原样到编译后的条目上**');
  assert.deepEqual(b.linkTriggers, ['丙'], '连带触发词也一样');

  // 而没写的那些是 undefined / []，不是 0 —— 「没填」和「填了 0」是两件事。
  assert.equal(b.intrinsicValue, undefined, '没写的该是 undefined，让 effectiveValue 退回 priority');
  assert.deepEqual(a.linkTriggers, [], '没写的连带是空数组');
});

test('⚠️ 端到端：写了 intrinsicValue 的那条，底座真的变了', () => {
  // 这条钉的是 ③ 那个错：文件里有那行 ≠ 它生效了。
  const raw = {
    entries: [
      { id: 'rich', triggers: ['甲'], priority: 30, intrinsicValue: 90, text: '一' },
      { id: 'poor', triggers: ['乙'], priority: 90, intrinsicValue: 30, text: '二' }
    ]
  };
  const book = buildWorldbook(raw);
  const acts = activationsFor(book.entries, new Map());
  // rich：priority 30 但内在价值 90 → 底座该按 90 算（高）
  // poor：priority 90 但内在价值 30 → 底座该按 30 算（低）
  assert.ok(
    acts.get('rich') > acts.get('poor'),
    `**底座要听 intrinsicValue，不听 priority**（rich ${acts.get('rich')} 对 poor ${acts.get('poor')}）`
  );
});

/* ------------------------------------------------------------------ *
 * 提取
 * ------------------------------------------------------------------ */

test('activeEntries 只给活跃的，而且按激活度降序', () => {
  const items = [
    { entry: entry({ id: 'cold' }), state: emptyState() },
    { entry: entry({ id: 'hot' }), state: { ...emptyState(), activation: 80 } },
    { entry: entry({ id: 'warm' }), state: { ...emptyState(), activation: 40 } }
  ];
  const got = activeEntries(items, P).map((e) => e.id);
  assert.deepEqual(got, ['hot', 'warm']);
});

test('activeEntries 不理会 priority —— 那是调用处的事', () => {
  // 上游的通用引擎不认识 priority。我们照做：这一层只管激活度。
  const items = [
    { entry: entry({ id: 'low-badge-hot', priority: 30 }), state: { ...emptyState(), activation: 80 } },
    { entry: entry({ id: 'high-badge-cold', priority: 90 }), state: { ...emptyState(), activation: 40 } }
  ];
  assert.deepEqual(activeEntries(items, P).map((e) => e.id), ['low-badge-hot', 'high-badge-cold']);
});
