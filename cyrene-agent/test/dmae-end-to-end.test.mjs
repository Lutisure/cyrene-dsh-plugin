// 端到端：**开着开关时，那条链真的会动吗。**
//
// ## 为什么这个测试长得和别的不一样
//
// 别的测试直接 import 模块、调它的纯函数。**这一个必须先把模块复制到临时目录。**
//
// 原因在 `dataPath`：
//
//     export function dataPath(relative) {
//       return fileURLToPath(new URL(relative, import.meta.url));
//     }
//
// **它按模块自己的位置解析，不认 `DSH_HOME`。** 所以直接调生产那份，
// 它会往**真实的 `data/`** 里写状态和审计 —— 而这个项目里有一条规矩：
// 「不碰本机现有安装」。
//
// 复制一份到临时目录，`dataPath` 就自然落在那边。**隔离是从代码结构里来的，
// 不是从环境变量里来的。**
//
// ## 它在验什么
//
// 2026-10-11 接线落地之后，我写进设计文档里的一句话是：
//
//     关着时是 no-op            **验过**
//     接线不语法错、不加载失败   **验过**
//     **开着时真的会动**         **没验**
//
// **这一份就是去还那个「没验」。**

import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

/** 这条链要的文件。少一个都会在 import 或运行时炸。 */
const NEEDED = ['worldbook.mjs', 'worldbook-logic.mjs', 'worldbook-activation.mjs', 'dmae.mjs', 'file-cache.mjs'];

const HERE = new URL('..', import.meta.url);

/**
 * 把插件复制到一个自成一体的临时目录。
 *
 * @returns {string} 那份副本的路径。
 */
function isolate() {
  const dir = mkdtempSync(join(tmpdir(), 'cyrene-e2e-'));
  for (const name of NEEDED) {
    copyFileSync(new URL(name, HERE), join(dir, name));
  }
  // `worldbook.mjs` 读的是编译产物 `dist/worldbook.json`。
  // 拿真实的那个 —— 它不含私人数据（就是设定库），而且是这台机器上真的会用的那份。
  mkdirSync(join(dir, 'dist'), { recursive: true });
  copyFileSync(new URL('dist/worldbook.json', HERE), join(dir, 'dist', 'worldbook.json'));
  return dir;
}

/**
 * 造一个够用的假 ctx，把它注册的那个 handler 拿出来。
 *
 * 只实现 `on` —— 插件只用了这一个 API（还有 try/catch 包着别的）。
 *
 * @param {object} mod - 那个副本的模块。
 * @returns {Function} 注册在 `agent/pre-step` 上的处理函数。
 */
function grabHook(mod) {
  const handlers = new Map();
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    logger: { warn() {}, error() {}, info() {} }
  };
  mod.apply(ctx);
  const hook = handlers.get('agent/pre-step');
  assert.equal(typeof hook, 'function', '该在 agent/pre-step 上注册一个 handler');
  return hook;
}

/**
 * 跑一轮，返回它返回的东西。
 *
 * @param {Function} hook - 那处理函数。
 * @param {string} text - 对方说了什么。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<object>} `next()` 的结果。
 */
async function turn(hook, text, sessionId) {
  let got = null;
  const payload = {
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    agent: { session: { id: sessionId } }
  };
  await hook(payload, async () => {
    got = { kind: 'enter', system: [] };
    return got;
  });
  return got;
}

/* ------------------------------------------------------------------ *
 * 一、关着的时候：一个字都不该写
 * ------------------------------------------------------------------ */

test('开关关着 → 那条链不碰磁盘，状态文件不出现', async () => {
  const saved = process.env.CYRENE_ACTIVATION;
  delete process.env.CYRENE_ACTIVATION;
  const dir = isolate();
  try {
    const mod = await import(pathToFileURL(join(dir, 'worldbook.mjs')).href);
    const hook = grabHook(mod);
    await turn(hook, '那刻夏是谁', 's1');
    assert.equal(
      existsSync(join(dir, 'data', 'worldbook-activation.json')),
      false,
      '**关着的时候不该有任何状态落盘** —— 那是默认状态，动它就是回归'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CYRENE_ACTIVATION;
    else process.env.CYRENE_ACTIVATION = saved;
  }
});

/* ------------------------------------------------------------------ *
 * 二、开着的时候：真的会动
 * ------------------------------------------------------------------ */

test('开关开着 → 一轮之后状态真的落盘了', async () => {
  const saved = process.env.CYRENE_ACTIVATION;
  process.env.CYRENE_ACTIVATION = '1';
  const dir = isolate();
  try {
    const mod = await import(pathToFileURL(join(dir, 'worldbook.mjs')).href);
    const hook = grabHook(mod);
    await turn(hook, '那刻夏是谁', 's1');

    const file = join(dir, 'data', 'worldbook-activation.json');
    assert.equal(existsSync(file), true, '**这一条就是「开着时真的会动」**');

    const payload = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(payload.turn, 1, '第一轮');
    const ids = Object.keys(payload.states);
    assert.ok(ids.length > 0, '该有条目被记下来');
    // 问的是那刻夏，那么 anaxa-* 那几条该有激活度
    assert.ok(ids.some((id) => id.startsWith('anaxa-')), `被记下来的该包含那刻夏那几条，实际：${ids.slice(0, 6).join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CYRENE_ACTIVATION;
    else process.env.CYRENE_ACTIVATION = saved;
  }
});

test('开着 → 轮号一轮一轮往上走，而且跨「重启」不回退', async () => {
  const saved = process.env.CYRENE_ACTIVATION;
  process.env.CYRENE_ACTIVATION = '1';
  const dir = isolate();
  try {
    const file = join(dir, 'worldbook.mjs');
    const hook1 = grabHook(await import(pathToFileURL(file).href));
    await turn(hook1, '那刻夏是谁', 's1');
    await turn(hook1, '那刻夏是谁', 's1');
    await turn(hook1, '白厄是谁', 's2');

    const after = JSON.parse(readFileSync(join(dir, 'data', 'worldbook-activation.json'), 'utf8'));
    assert.equal(after.turn, 3, '三轮就是 3');

    // 「重启」：重新 import 一份（内存全没），再走一轮
    const hook2 = grabHook(await import(`${pathToFileURL(file).href}?v=2`));
    await turn(hook2, '风堇是谁', 's3');
    const restarted = JSON.parse(readFileSync(join(dir, 'data', 'worldbook-activation.json'), 'utf8'));
    assert.equal(restarted.turn, 4, '**重启之后接着数，不是从 1 重来**');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CYRENE_ACTIVATION;
    else process.env.CYRENE_ACTIVATION = saved;
  }
});

/* ------------------------------------------------------------------ *
 * 涨和落 —— 这一组在走通之前抓出了三处错
 * ------------------------------------------------------------------ *
 *
 * 它们红过三次，而每次红都是真问题：
 *
 *   一、`step` 看的是 `entry.keywords`，而世界书条目带的是 `needles`
 *       → 每条都被判成「没有触发词」→ **整套东西一直没在算**，数值停在底座上
 *   二、`hitIds` 只取了 `decision.hits`（过了 skip 的那些）
 *       → 连着问同一件事，反而被当成「没问」→ 一路落到归档
 *   三、归档的条目被存档策略滤掉 → 下一轮当成新条目 → **从底座复活，五轮一循环**
 *
 * **三处都不报错。** 抓出它们的是这一组曲线，不是读代码。
 */

test('开着 → 连着问，被问的那些**真的在涨**', async () => {
  const saved = process.env.CYRENE_ACTIVATION;
  process.env.CYRENE_ACTIVATION = '1';
  const dir = isolate();
  try {
    const hook = grabHook(await import(pathToFileURL(join(dir, 'worldbook.mjs')).href));
    const file = join(dir, 'data', 'worldbook-activation.json');
    const read = () => JSON.parse(readFileSync(file, 'utf8')).states;
    const who = (states) => states['anaxa-who']?.activation ?? -1;

    await turn(hook, '那刻夏是谁', 's1');
    const first = who(read());
    for (let i = 0; i < 9; i += 1) await turn(hook, '那刻夏是谁', 's1');
    const later = who(read());

    assert.ok(
      later > first,
      `**目标第四条要的正是这一条**：连问十轮之后该比第一轮高（${first.toFixed(1)} → ${later.toFixed(1)}）`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CYRENE_ACTIVATION;
    else process.env.CYRENE_ACTIVATION = saved;
  }
});

test('开着 → 没被提起的**真的在落，而且归档之后不会复活**', async () => {
  const saved = process.env.CYRENE_ACTIVATION;
  process.env.CYRENE_ACTIVATION = '1';
  const dir = isolate();
  try {
    const hook = grabHook(await import(pathToFileURL(join(dir, 'worldbook.mjs')).href));
    const file = join(dir, 'data', 'worldbook-activation.json');
    const read = () => JSON.parse(readFileSync(file, 'utf8')).states;
    const aglaea = (states) => states['view-aglaea']?.activation ?? -1;

    await turn(hook, '那刻夏是谁', 's1');
    const first = aglaea(read());
    for (let i = 0; i < 9; i += 1) await turn(hook, '那刻夏是谁', 's1');
    const archived = aglaea(read());

    assert.ok(archived < first, `没被提起的该在落（${first.toFixed(1)} → ${archived.toFixed(1)}）`);
    assert.equal(archived, 0, '十轮不提该归档了');

    // ⚠️ **再问几轮，它不能复活。** 这一条钉的是第三处错 ——
    //    归档的条目曾被存档策略滤掉，于是下一轮被当成新条目、从底座重新进场，
    //    表现成一个五轮一循环：`40 35 26 13 0 | 40 35 26 13 0 | …`
    for (let i = 0; i < 3; i += 1) await turn(hook, '那刻夏是谁', 's1');
    assert.equal(aglaea(read()), 0, '**归档就是归档，不该自己冒出来**');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CYRENE_ACTIVATION;
    else process.env.CYRENE_ACTIVATION = saved;
  }
});
