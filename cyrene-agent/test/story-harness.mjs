/**
 * 剧情插件那一层的测试夹具 —— `story-plugin.test.mjs` 与 `story-embedding.test.mjs` 共用。
 *
 * ## 为什么分成两个文件
 *
 * `story.mjs` 的 `load()` 是**记忆化**的：在 `DSH_STORY_EMBED=off` 下加载过一次之后，
 * `state.windows` 就是 `null`，进程里再把开关拨回去也回不来 —— 那次加载的结果被缓存住了。
 * 所以「开着向量」那几条必须跑在**另一个进程**里。
 * `node --test` 每个测试文件一个子进程，正好。
 *
 * 这个文件名不以 `.test.mjs` 结尾，不会被当成用例跑。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../story.mjs';

/** 一个只会 `on()` 的假 ctx —— 够 `apply()` 用。 */
export function fakeContext() {
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
export function hookOf(registrations, claimed) {
  const hook = registrations.hooks.find((candidate) => candidate.name === 'agent/pre-step');
  assert.notEqual(hook, undefined, 'story.mjs 必须挂 agent/pre-step');
  const next = async () => ({ kind: 'enter', messages: claimed });
  return { hook, next };
}

/** 一个普通用户消息，按 loop 给出的形状。 */
export function userMessage(text) {
  return { id: 'user-1', role: 'user', content: [{ type: 'text', text }] };
}

/** 让这个用例的留痕写到临时文件里，别写进生产那份。 */
export const withAudit = (body) => async (t) => {
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
export async function run(claimed, text) {
  const { ctx, registrations } = fakeContext();
  apply(ctx);
  // ⚠️ `hookOf` 返回的是**注册对象** `{ name, handler, options }`，不是 handler 本身。
  // 第一版写成 `hook(...)`，五个用例全报 `hook is not a function`。
  const { hook, next } = hookOf(registrations, claimed);
  return hook.handler({ messages: claimed }, next);
}
