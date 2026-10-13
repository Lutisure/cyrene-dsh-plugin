/**
 * 向量检索那一层 —— `agent/pre-step` 开着 embedding 时的行为。
 *
 * ## 为什么单独一个文件
 *
 * `story.mjs` 的 `load()` 是记忆化的：在 `DSH_STORY_EMBED=off` 下加载过一次，
 * `state.windows` 就永远是 `null`，同一个进程里再把开关拨回去也没用。
 * `story-plugin.test.mjs` 全程钉着 `off`，所以这一层只能换一个进程测 ——
 * `node --test` 每个文件一个子进程，正好。
 *
 * ## 测什么
 *
 *   一、模型在时，向量召回真的参与了排序 —— 留痕里 `vector` 那一格是唯一证据，
 *      `story.mjs` 里它的注释就写着「全是 null 就是没生效」。
 *   二、要不到模型时安静退回词法 —— 不报错，也不空手。
 *
 * 第一条在没装模型的机器上 skip：它测的是「装了之后通不通」，不是「这台机器有没有」。
 * 第二条**不 skip** —— 它测的是「拿不到模型时调用方拿到的确实是空」，任何机器上都该成立。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createEmbedder } from '../embedder.mjs';
import { storyLogFile } from '../story.mjs';
import { run, userMessage, withAudit } from './story-harness.mjs';

process.env.DSH_STORY_EMBED = 'on';

const MODEL_DIR = new URL('../cyrene_embedding/bge-small-zh-v1.5/', import.meta.url);
const HAS_MODEL = existsSync(new URL('tokenizer.json', MODEL_DIR));

/** 跑一句、把留痕读回来。 */
async function auditRecordFor(q) {
  const claimed = [userMessage(q)];
  const decision = await run(claimed, q);
  assert.equal(decision.messages.length, 2, `「${q}」应当注入`);
  return JSON.parse(readFileSync(storyLogFile(), 'utf8').trim());
}

test(
  '开着向量：留痕里的 vector 是个数，不是 null',
  { skip: HAS_MODEL ? false : '本机没装模型（cyrene_embedding/）' },
  withAudit(async () => {
    const record = await auditRecordFor('遐蝶的死亡之触是怎么回事');
    assert.equal(
      typeof record.vector,
      'number',
      '开着向量时 vector 必须是数 —— 它是「embedding 到底有没有生效」在真机上的唯一证据'
    );
    assert.ok(
      record.vector <= 1.0001 && record.vector >= -1.0001,
      `余弦不该跑出 [-1,1]，拿到 ${record.vector}`
    );
  })
);

test('要不到模型时拿不到编码器 —— 调用方据此退回词法', async () => {
  // ⚠️ 这里直接调 `createEmbedder()`，不走 `story.mjs` 的 `getEmbedder()`：
  // 那一层是**单例**，上面第一条用例已经把编码器建好并缓存住了，
  // 之后再把目录指坏也换不掉它。测「模型不在会怎样」只能绕开那个缓存。
  const previous = process.env.DSH_STORY_EMBED_DIR;
  process.env.DSH_STORY_EMBED_DIR = join(tmpdir(), 'story-embed-不存在-所以没有模型');
  try {
    let made = null;
    let threw = false;
    try {
      made = await createEmbedder();
    } catch {
      threw = true;
    }
    assert.ok(threw || made === null, '模型不在时不该给出一个能用的编码器');
  } finally {
    if (previous === undefined) delete process.env.DSH_STORY_EMBED_DIR;
    else process.env.DSH_STORY_EMBED_DIR = previous;
  }
});
