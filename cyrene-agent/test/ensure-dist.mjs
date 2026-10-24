/**
 * 让测试自己准备 `dist/` 里那两份**构建产物**。
 *
 * ## 为什么需要这个
 *
 * `build.mjs` 装配的是人格、世界书、预设 —— 它不切剧情。切块是
 * `tools/build-story-index.mjs` 的活，向量表又是另一个脚本。两份都落在
 * `dist/`，而 `dist/` 不进 git。
 *
 * 于是干净克隆上 `node --test` 会读到不存在的文件：剧情那 7 个用例一起红。
 * 看起来像代码坏了，其实是**测试读了一个本该由它自己准备的文件** ——
 * 以前靠人记得先跑 `npm run build:story`，`npm test` 才碰巧能过，
 * 但 `node --test test/*.test.mjs`（CI 里跑的就是这个）不会触发 `pretest`。
 *
 * ## 为什么只建剧情索引，不建向量表
 *
 * 剧情切块是一秒级的纯文本运算，缺了就顺手补上，没有副作用。
 * 向量表要加载 23 MB 的模型、跑 986 次前向传播，分钟级 —— 不能塞进每次测试。
 * 所以那份缺失时，用它的用例自己 skip，并说清楚重建命令。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_DIR = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(AGENT_DIR, 'dist');
const CHUNKS = join(DIST, 'story-chunks.jsonl');

/**
 * 确保 `dist/story-chunks.jsonl` 存在；缺了就现在建。已有的一律不动。
 *
 * 并行跑的两个测试文件可能同时进这里，所以产物先写进程私有的临时名，
 * 再 `rename` 到位 —— 原子替换，读的人不会看见半截文件。
 * 两边造出来的字节是同一份，谁后 rename 都一样。
 */
export function ensureStoryIndex() {
  if (existsSync(CHUNKS)) return;
  const tmp = join(DIST, `.story-chunks.${process.pid}.tmp`);
  try {
    execFileSync(process.execPath, ['tools/build-story-index.mjs', '--out', tmp], {
      cwd: AGENT_DIR,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (err) {
    rmSync(tmp, { force: true });
    const detail = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    throw new Error(
      `剧情索引建不起来（${CHUNKS}）—— 多半是 corpus-src/ 不全。\n` +
        `先手动跑一次看输出：node tools/build-story-index.mjs\n${detail}`
    );
  }

  // Windows 的 rename 不覆盖同名目标（POSIX 会），于是并行跑测试时后到的那一方
  // 必然在这儿撞车。撞上不该算失败 —— 先到的那份是用同一套语料切出来的，
  // 字节相同。临时文件删掉，事情就算办完了。
  try {
    renameSync(tmp, CHUNKS);
  } catch (err) {
    rmSync(tmp, { force: true });
    if (!existsSync(CHUNKS)) {
      throw new Error(`剧情索引落不了盘（${CHUNKS}）：${err.message}`);
    }
  }
  if (!existsSync(CHUNKS)) {
    throw new Error(`建完了却没有 ${CHUNKS} —— build-story-index.mjs 没落盘？`);
  }
}

/**
 * 向量表在这份工作区里能不能用。
 *
 * 判据逐条照抄 `story.mjs` 的两个加载器 —— 少一条，skip 就会说谎：
 * 一份陈旧或者残缺的表在 `story.mjs` 里是 null（等于没开），
 * 在测试里也必须表现为 skip 并提示重建，而不是「通过了」。
 *
 * 两者的核对不一样，不能合并：
 *   · 窗口级 `loadWindows`：`meta.chunks` 对块数、`meta.count` 是**窗口数**，
 *     还有一条 `chunkOf`（窗口 → 块）
 *   · 块级 `loadVectors`：`meta.count` 就是块数
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function vectorTableState() {
  if (!existsSync(CHUNKS)) return { ok: false, reason: '剧情索引还没建（先跑一次测试）' };
  const sourceText = readFileSync(CHUNKS, 'utf8');
  const count = sourceText.split('\n').filter((l) => l.trim() !== '').length;
  const sha = createHash('sha256').update(sourceText).digest('hex');
  const perFloat = 4;

  const granularity = String(process.env.DSH_STORY_EMBED_GRANULARITY ?? 'window').toLowerCase();
  const problems = [];

  /** 按给定判据试一份表。 */
  const tryTable = (stem, label, verify) => {
    const metaFile = join(DIST, `${stem}.json`);
    const binFile = join(DIST, `${stem}.f32`);
    if (!existsSync(metaFile) || !existsSync(binFile)) return { ok: false, reason: `${label}（${stem}.*）文件不在` };
    let meta;
    try {
      meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    } catch (err) {
      return { ok: false, reason: `${label}（${stem}.json）读不动：${err.message}` };
    }
    if (meta.sourceSha256 !== sha) return { ok: false, reason: `${label}是按旧语料建的（sha256 对不上）` };
    const floats = statSync(binFile).size / perFloat;
    const bad = verify(meta, floats);
    return bad ? { ok: false, reason: `${label}：${bad}` } : { ok: true };
  };

  // 窗口级优先 —— 与 `loadWindows` 一致，`DSH_STORY_EMBED_GRANULARITY=chunk` 时它会整个跳过。
  if (granularity !== 'chunk') {
    const windows = tryTable('story-windows', '窗口级', (meta, floats) => {
      if (meta.chunks !== count) return `按 ${meta.chunks} 块建的，语料现在是 ${count} 块`;
      if (floats !== meta.count * meta.dim) return `大小 ${floats} 个浮点，与 ${meta.count}×${meta.dim} 对不上`;
      if (!Array.isArray(meta.chunkOf) || meta.chunkOf.length !== meta.count) return '缺 chunkOf（窗口→块 的映射）';
      return null;
    });
    if (windows.ok) return { ok: true };
    problems.push(windows.reason);
  }

  const blocks = tryTable('story-vectors', '块级', (meta, floats) => {
    if (meta.count !== count) return `按 ${meta.count} 块建的，语料现在是 ${count} 块`;
    if (floats !== count * meta.dim) return `大小 ${floats} 个浮点，与 ${count}×${meta.dim} 对不上`;
    return null;
  });
  if (blocks.ok) return { ok: true };
  problems.push(blocks.reason);

  return {
    ok: false,
    reason:
      `向量表不可用：${problems.join('；')}。` +
      '重建：node tools/build-story-windows.mjs（要 cyrene_embedding/ 里的模型）',
  };
}
