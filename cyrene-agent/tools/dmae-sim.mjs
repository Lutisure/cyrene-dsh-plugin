/**
 * 激活引擎的模拟器：看「常提起」和「久没提起」到底有没有差别。
 *
 * ## 为什么要有它
 *
 * 上游那份文档自己承认（`worldbook.ts:43`）：
 *
 *   > 任何参数都只是默认值，不是结论。所有参数以后都通过 Simulator 调整
 *
 * **而他们那个模拟器没留下任何跑出来的数字。** 所以参数在那边是「继承」或
 * 「抄默认」，不是「量出来的」。**这一份就是要把那个缺口补上。**
 *
 * ## 干什么
 *
 * 喂它几串对话，看几条设定的激活度曲线：
 *
 *   甲  每轮都聊到        → 该稳稳在线上
 *   乙  只第 1 轮聊到      → 该掉下去
 *   丙  一次都没聊到      → 该只在底座上
 *   丁  隔几轮聊一次      → 该在中间，起起伏伏
 *
 * **判据是「行为不同」，不是「数字好看」。** 乙和丙如果曲线一样，
 * 那说明这条设定「聊没聊过」根本不重要 —— **那就不用做了。**
 *
 * 用法：
 *   node tools/dmae-sim.mjs                 # 四组对照
 *   node tools/dmae-sim.mjs --sweep         # 扫 decayAlpha，找「几轮跌破」
 *   node tools/dmae-sim.mjs --real          # 用真实的 132 条 priority 分布
 */

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';

import {
  DEFAULT_PARAMS as P,
  baseFromPriority,
  emptyState,
  resistanceFromPriority,
  step,
  deriveState
} from '../dmae.mjs';

const ROUNDS = 10;

/**
 * 跑一串命中，把每轮的激活度记下来。
 *
 * @param {object} entry - 条目（带 resistance）。
 * @param {number[]} hitTurns - 哪几轮用户提到它。
 * @param {object} [params] - 参数。
 * @returns {object[]} 每轮一个 `{turn, activation, state}`。
 */
function run(entry, hitTurns, params = P) {
  const base = baseFromPriority(entry.priority ?? 60, params);
  let state = emptyState();
  const out = [];
  for (let turn = 1; turn <= ROUNDS; turn += 1) {
    state = step(state, { entry, base, userHit: hitTurns.includes(turn), turn }, params);
    out.push({ turn, activation: state.activation, state: deriveState(state.activation, params) });
  }
  return out;
}

/** 把一串数字画成一行。 */
const line = (trace) => trace.map((x) => x.activation.toFixed(0).padStart(4)).join('');

/** 一条设定。 */
const entryFor = (priority, id = 'x') => ({
  id,
  keywords: ['那刻夏'],
  priority,
  resistance: resistanceFromPriority(priority),
  enabled: true
});

/* ------------------------------------------------------------------ *
 * 一、四组对照
 * ------------------------------------------------------------------ */

if (!process.argv.includes('--sweep') && !process.argv.includes('--real') && !process.argv.includes('--floor')) {
  console.log(`\n  激活引擎模拟 · ${ROUNDS} 轮 · 阈值 ${P.promptThreshold} · α=${P.decayAlpha} β=${P.decayBeta}\n`);
  console.log('  每条设想的场景，从左到右是第 1–10 轮的激活度：\n');

  const cases = [
    ['甲 每轮都聊到', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]],
    ['乙 只第 1 轮聊到', [1]],
    ['丙 一次都没聊到', []],
    ['丁 每 3 轮聊一次', [1, 4, 7, 10]],
    ['戊 前 3 轮聊到后就停', [1, 2, 3]]
  ];

  for (const priority of [90, 60, 30]) {
    console.log(`  ── priority ${priority} ──`);
    const e = entryFor(priority);
    const base = baseFromPriority(priority, P);
    console.log(`     A_base ${base.toFixed(1)}   I ${e.resistance.toFixed(2)}`);
    for (const [label, hits] of cases) {
      const t = run(e, hits);
      console.log(`     ${label.padEnd(22)}${line(t)}   末态 ${t[t.length - 1].state}`);
    }
    console.log('');
  }

  console.log('  ⚠️ 要看的是**乙和丙有没有差别**。');
  console.log('     一样的话，说明「聊没聊过」不影响结果 —— 那这套就不用做了。');
  console.log('     （另外注意：丙 全是 0，因为现在跑的是 `floorMode: \'wake\'` ——');
  console.log('      底座只当醒来时的高度。要看成地板的样子，跑 `--floor`。）\n');
}

/* ------------------------------------------------------------------ *
 * 一比一：底座是地板还是起点
 * ------------------------------------------------------------------ */

if (process.argv.includes('--floor')) {
  console.log('\n  底座是**地板**还是**醒来时的高度** —— 两种语义并排看\n');
  console.log('  ⚠️ 这是要人拿主意的那件事。两边都实现了，改 `DmaeParams.floorMode` 一行就换。\n');

  const cases = [
    ['每轮都聊到', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]],
    ['只第 1 轮聊到', [1]],
    ['一次都没聊到', []],
    ['聊过两次然后停', [1, 2]]
  ];

  for (const mode of ['wake', 'permanent']) {
    const params = { ...P, floorMode: mode };
    const label = mode === 'wake' ? 'wake（醒来时的高度 · 上游选的）' : 'permanent（永久地板）';
    console.log(`  ── ${label} ──\n`);
    for (const priority of [90, 60, 30]) {
      const e = entryFor(priority);
      const base = baseFromPriority(priority, params);
      console.log(`     priority ${String(priority).padEnd(4)}A_base ${base.toFixed(1)}`);
      for (const [name, hits] of cases) {
        const t = run(e, hits, params);
        console.log(`       ${name.padEnd(18)}${line(t)}   ${t[t.length - 1].state}`);
      }
    }
    console.log('');
  }

  console.log('  要看的是 **priority 90 那三行**：');
  console.log("     'wake'       「一次都没聊到」和「聊过两次然后停」最后都会归档");
  console.log("     'permanent'  那两行都停在 42，永远在线 —— **那和现在的行为没区别**");
  console.log('');
  console.log('  而「想不起来」和「不存在」是两件事 —— 归档的条目还在，');
  console.log('  还能被关键词命中，命中就唤醒。**那才是 `anaxa-creed` 那个 case 要修的东西。**\n');
}

/* ------------------------------------------------------------------ *
 * 二、扫 decayAlpha：几轮跌破阈值
 * ------------------------------------------------------------------ */

if (process.argv.includes('--sweep')) {
  // ⚠️ 第一版这张表只打「第几轮跌破」，结果 α=1.0 到 3.0 六倍的范围里答案全是「第 4 轮」——
  //    **不是参数不敏感，是那个度量太钝**：它把「跨在第 3 轮和第 4 轮之间」抹成一个整数。
  //    所以同时打出几个固定轮次的值，让敏感性看得见。
  console.log(`\n  扫 decayAlpha —— 一条 priority 60 的设定，第 1 轮聊到、之后不再提。\n`);
  console.log(`    阈值 ${P.promptThreshold}。三列分别是「第几轮跌破 / 第 3 轮的值 / 第 6 轮的值」。\n`);
  console.log('    α        跌破        第 3 轮    第 6 轮');
  for (const alpha of [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0]) {
    const params = { ...P, decayAlpha: alpha };
    const t = run(entryFor(60), [1], params);
    const fell = t.find((x) => x.turn > 1 && x.activation < params.promptThreshold);
    const at3 = t.find((x) => x.turn === 3).activation;
    const at6 = t.find((x) => x.turn === 6).activation;
    console.log(
      `    ${String(alpha).padEnd(9)}${(fell ? `第 ${fell.turn} 轮` : '一直没跌').padEnd(12)}` +
      `${at3.toFixed(1).padEnd(11)}${at6.toFixed(1)}`
    );
  }
  console.log('\n  ⚠️ 上游的 1.5 是「针对 8 轮跌破反推」出来的，而那次反推算的是 1.58。');
  console.log('     **上游的目标是 8 轮，而这张表里连 0.5 都只撑到第 5 轮** ——');
  console.log('     因为他们的 `I` 来自条目本身，而这里 priority 60 映出来的 I 只有 2.5。');
  console.log('     **这就是「照抄参数」和「在自己这边量」的差别。**\n');
}

/* ------------------------------------------------------------------ *
 * 三、用真实的 priority 分布
 * ------------------------------------------------------------------ */

if (process.argv.includes('--real')) {
  const book = new URL('../worldbook/entries.yaml', import.meta.url);
  if (!existsSync(book)) {
    console.log('\n  找不到 worldbook/entries.yaml\n');
    process.exit(1);
  }
  // 只为统计，不解析 YAML —— 用正则抓 priority，省一个依赖。
  const text = readFileSync(book, 'utf8');
  const values = [...text.matchAll(/^\s*priority:\s*(\d+)/gmu)].map((m) => Number(m[1]));
  const bucket = new Map();
  for (const v of values) bucket.set(v, (bucket.get(v) ?? 0) + 1);

  console.log(`\n  真实的 ${values.length} 条 priority，映射到 A_base：\n`);
  console.log('    priority   条数    A_base   相对阈值   醒来时的落点');
  for (const v of [...bucket.keys()].sort((a, b) => b - a)) {
    const base = baseFromPriority(v, P);
    const rel = base / P.promptThreshold;
    // ⚠️ 第一版这里打的是「不用聊也在」——**那句是错的**。
    //    `A_base` 不是永久地板：一次都没聊到的条目是 0，不是 `A_base`。
    //    它只是**醒来时的高度**（见 `dmae.mjs` 里 `baseFromPriority` 的注释）。
    console.log(
      `    ${String(v).padEnd(10)}${String(bucket.get(v)).padEnd(8)}${base.toFixed(1).padEnd(9)}` +
      `${rel.toFixed(2).padEnd(11)}${rel >= 1 ? '醒来就在线上' : '醒来在阈值下，要奖励才留得住'}`
    );
  }
  console.log('');
}
