/**
 * 用到的 `cy-*` 类名，样式里都该有。
 *
 * ## 它守的是哪一次
 *
 * 2026-10-11：`90-panel.js` 那个 live region 用了 `class: "cy-sr"` ——
 * 名字取得对、语义也对，**但 CSS 里从来没有 `.cy-sr`**。
 * 于是「视觉隐藏」只存在于类名里：它实际是个普通 div，
 * reorder 的提示语写进去就**一直挂在屏幕上**。
 *
 * **这类错读代码读不出来** —— 类名看着完全正确。只有把用到的类名和样式对一遍才看得见。
 * 所以这一份对的是**全部**类名，不是只对看见的那一个。
 *
 * ## 允许名单
 *
 * 有五个类名是**有意不设样式**的：它们给测试断言或 `dataset` 查询当钩子用。
 * 名单是显式的 —— 这样「新冒出来一个没样式的类名」会红，
 * 而「有人把 `cy-sr` 的规则删了」也会红。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const DIR = join(import.meta.dirname, '..', 'lib', 'client');

/**
 * 收集用到的类名、以及样式里定义过的类名。
 * @returns {{used: Set<string>, styled: Set<string>}} 两边。
 */
function scan() {
  const used = new Set();
  const styled = new Set();
  for (const f of readdirSync(DIR).filter((n) => n.endsWith('.js'))) {
    const text = readFileSync(join(DIR, f), 'utf8');
    // 字符串里的类名，以及 class: "a b c" 这种
    for (const m of text.matchAll(/["'`](cy-[a-z0-9-]+)/g)) used.add(m[1]);
    for (const m of text.matchAll(/class:\s*"([^"]+)"/g)) {
      for (const cls of m[1].split(/\s+/)) if (cls.startsWith('cy-')) used.add(cls);
    }
    // 样式选择器：".cy-xxx" 后面跟着空格、逗号、{、: 或行尾
    for (const m of text.matchAll(/\.(cy-[a-z0-9-]+)(?=[\s,{:.\[]|$)/gm)) styled.add(m[1]);
  }
  return { used, styled };
}

/**
 * 有意不设样式的类名，以及**为什么**。
 *
 * 加东西进这张表要有理由 —— 它默不作声地放行一个类名，
 * 而这一条检查存在的全部意义就是「别让没样式的类名悄悄过去」。
 */
const INTENTIONALLY_UNSTYLED = new Map([
  ['cy-fold', '测试断言用的钩子（`shape[4] === "cy-btn cy-fold"`），样式跟着 `cy-btn` 走'],
  ['cy-dockrows', '配 `dataset.dockList` 做查询钩子，外观由内层元素承担'],
  ['cy-list', '配 `dataset.fontSets` 做查询钩子'],
  ['cy-more', '`<details>` 元素本身自带外观，类名只用于查询'],
  ['cy-dockrow-state', '状态行，样式在父级的 `[data-*]` 选择器里']
]);

test('用到的 cy-* 类名，样式里都有（或有明确的不设理由）', () => {
  const { used, styled } = scan();
  const missing = [...used].filter((c) => !styled.has(c) && !INTENTIONALLY_UNSTYLED.has(c));
  assert.deepEqual(
    missing,
    [],
    `这些类名用了但没有样式，也不在允许名单里：${missing.join(', ')}\n` +
      '要么补样式，要么加进 INTENTIONALLY_UNSTYLED 并写清理由。'
  );
});

test('cy-sr 有样式 —— 不许再丢掉', () => {
  // 单独一条，因为丢掉它的症状是「屏幕上一行字不消失」，很容易被当成别的问题。
  const { styled } = scan();
  assert.ok(styled.has('cy-sr'), '.cy-sr 的规则不见了 —— live region 会重新变得可见');
});

test('允许名单里的每一条都还在用 —— 名单不该积灰', () => {
  const { used } = scan();
  for (const [cls, why] of INTENTIONALLY_UNSTYLED) {
    assert.ok(used.has(cls), `${cls}（${why}）已经不在代码里了，把它从名单里删掉。`);
  }
});
