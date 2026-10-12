/**
 * 「没扫成的文件」要留痕。
 *
 * ## 守的是什么
 *
 * 原来那几处都是**安静 `return`**：文件太大、读回来不是文本、读的时候抛了 ——
 * 一律不留痕。于是报告看起来是「扫过了，没问题」，**而实际是「有几个没扫」**。
 *
 * README 的 `Known Limitations` 里本来就把这条写着：
 *
 *   > 上限之外没有兜底：路径不在白名单、文件超 512 KB、目标读不回来 ——
 *   > 都是**安静跳过**，不会有「我没能扫这个文件」的记录。
 *
 * **两件事混起来才是真正的危险**：「扫过、没发现问题」和「根本没扫」在报告上
 * 长得一模一样。这一份把它们的差别钉住。
 *
 * ⚠️ **要一起守住的还有反面**：跳过 `node_modules`、构建产物是设计如此，
 * 那份清单不该被它们淹没 —— 见最后一条。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { apply } from '../index.js';

/**
 * 搭一个只够这个插件用的假上下文。
 *
 * ⚠️ **路径必须指向盘上真的存在的东西。** `scanTarget` 里第一关是
 * `existsSync(path)`，那一步是**真的查盘**，不是假的 —— 我第一版用 `'big.js'`
 * 这种凭空的名字，于是三个用例全在起跑线就 `return` 了，
 * **量到的是「文件不存在」，不是「文件太大」。**
 *
 * @param {object} options - `stat` / `readText` 的行为。
 * @returns {{ctx: object, run: (name: string) => Promise<void>, report: () => string, cleanup: () => void}} 抓手。
 */
function harness({ stat, readText } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-skip-'));
  let handler = null;
  let sectionText = null;
  const ctx = {
    effect() {},
    on(name, fn) {
      if (name === 'fs/observed') handler = fn;
    },
    fs: {
      stat: stat ?? (async () => ({ size: 10 })),
      readText: readText ?? (async () => 'const x = 1;\n')
    },
    systemPrompt: {
      section(spec) {
        sectionText = spec.text;
      }
    }
  };
  apply(ctx);
  assert.notEqual(handler, null, '要挂在 fs/observed 上');
  return {
    ctx,
    // scanTarget 是 async，但 fs/observed 的处理器不 await 它 —— 等一轮微任务。
    run: async (name) => {
      const path = join(dir, name);
      writeFileSync(path, 'const x = 1;\n', 'utf8');
      handler({ displayPath: path });
      await new Promise((resolve) => setImmediate(resolve));
    },
    /**
     * 只把路径递进去，**不造文件**。
     *
     * 给「按设计跳过」那一条用：那种路径在 `existsSync` 之前就被 `worthScanning`
     * 挡掉了，本来就不该存在。**造了文件反而是我搞错了这一步的顺序。**
     */
    runRaw: async (name) => {
      handler({ displayPath: join(dir, name) });
      await new Promise((resolve) => setImmediate(resolve));
    },
    report: () => (sectionText === null ? '' : String(sectionText())),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

test('文件太大 → 报告上要写明「没扫」，不能什么都不说', async () => {
  const h = harness({ stat: async () => ({ size: 2 * 1024 * 1024 }) });
  await h.run('big.js');
  const report = h.report();
  assert.match(report, /big\.js/, '要指出是哪个文件');
  assert.match(report, /512 KB/u, '要说清为什么 —— 超过上限');
  assert.match(report, /没能扫到/u, '要明说这是「没扫」，不是「扫过没问题」');
});

test('读回来不是文本 → 同样要写出来', async () => {
  const h = harness({ readText: async () => ({ kind: 'binary' }) });
  await h.run('blob.js');
  const report = h.report();
  assert.match(report, /blob\.js/);
  assert.match(report, /不是文本/u);
});

test('读的时候抛了 → 流程不受影响，但报告里要留一条', async () => {
  const h = harness({ readText: async () => { throw new Error('后端不支持读'); } });
  await h.run('unreadable.js');
  const report = h.report();
  assert.match(report, /unreadable\.js/);
  assert.match(report, /出错/u);
});

test('一切正常时，不该出现「没能扫到」那一段', async () => {
  const h = harness();
  await h.run('fine.js');
  assert.doesNotMatch(h.report(), /没能扫到/u, '没跳过就别报 —— 报了就是噪音');
});

test('跳过 node_modules 是设计如此，不该进这份清单', async () => {
  // 这一条守的是反面：**把「按设计跳过」也报出来，会把真正该看的挤掉。**
  //
  // 这两个路径**不需要真的存在** —— `worthScanning` 在 `existsSync` 之前就返回 false，
  // 这正是「按设计跳过」的意思：连看都不去看。
  const h = harness();
  try {
    for (const name of ['node_modules/foo/index.js', 'dist/bundle.js']) {
      await h.runRaw(name);
    }
    assert.doesNotMatch(h.report(), /没能扫到/u, '这两个是故意不扫的，不该报');
  } finally {
    h.cleanup();
  }
});
