/**
 * 构建**窗口级**向量表（离线，一次性）
 *
 * ## 为什么不用块级
 *
 * 2026-10-13 实测：块级向量（每块 986 个 CLS 向量）在 100 条剧情题上，
 * **含答案那一块排第 1 名的次数是 0/100**（词法余弦是 53/100）。
 * 原因是块太大（平均 839 字符、十几行、常常好几个话题），CLS 表示的是**整块主题**，
 * 答案那一行被平均掉了。冒烟测试之所以好看，是因为它拿问题去比**单句**。
 *
 * 所以改成窗口级：块内滑窗（默认 220 字符、步长 150），
 * **块分 = 它所有窗口里与查询最相似的那一个**（max-pooling）。
 *
 * ## 产物
 *
 *   dist/story-windows.f32     窗口数 × dim 的 float32（已归一化）
 *   dist/story-windows.json    {dim, count, chunkOf[], size, stride, sourceSha256, ...}
 *
 * `chunkOf[i]` = 第 i 个窗口属于第几块（行序 = chunks 行序）。
 *
 * 用法：
 *   node tools/build-story-windows.mjs
 *   node tools/build-story-windows.mjs --if-stale      # 已是最新就不重算（装脚本用这个）
 *   DSH_STORY_WINDOW_SIZE=220 DSH_STORY_WINDOW_STRIDE=150 node tools/build-story-windows.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createEmbedder, modelDir } from '../embedder.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHUNKS = `${ROOT}dist/story-chunks.jsonl`;
const OUT_F32 = `${ROOT}dist/story-windows.f32`;
const OUT_META = `${ROOT}dist/story-windows.json`;

const SIZE = Number(process.env.DSH_STORY_WINDOW_SIZE ?? 220);
const STRIDE = Number(process.env.DSH_STORY_WINDOW_STRIDE ?? 150);
const STATS_ONLY = process.argv.includes('--stats');
const IF_STALE = process.argv.includes('--if-stale');

if (!existsSync(CHUNKS)) {
  console.error(`✗ 找不到 ${CHUNKS} —— 先跑 node tools/build-story-index.mjs`);
  process.exit(1);
}

const raw = readFileSync(CHUNKS, 'utf8');
const sourceHash = createHash('sha256').update(raw).digest('hex');
const docs = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const hay = (d) => `${d.chapter ?? ''} ${d.node ?? ''}\n${d.text ?? ''}`;

/**
 * `--if-stale`：向量表还对得上就不重算。
 *
 * 判断依据是 meta 里的 `sourceSha256` 与当前 `story-chunks.jsonl` 的哈希 ——
 * **不是文件时间戳**。语料重建过、窗宽步长改过，哈希或字段都会变，
 * 而时间戳会因为一次 `git checkout` 骗人。
 */
if (IF_STALE && existsSync(OUT_META) && existsSync(OUT_F32)) {
  let current = null;
  try {
    const meta = JSON.parse(readFileSync(OUT_META, 'utf8'));
    current =
      meta.sourceSha256 === sourceHash &&
      meta.chunks === docs.length &&
      meta.size === SIZE &&
      meta.stride === STRIDE &&
      statSync(OUT_F32).size === meta.count * meta.dim * 4
        ? meta
        : null;
  } catch {
    current = null;
  }
  if (current !== null) {
    console.log(`\n  ✓ 向量表已是最新（${current.count} 窗 × ${current.dim} 维，源 ${sourceHash.slice(0, 12)}）—— 跳过\n`);
    process.exit(0);
  }
  console.log('\n  向量表过时或缺失 —— 重算');
}

/** 一块 → 若干窗口（按字符切；短块就一个窗口）。 */
function windowsOf(text) {
  if (text.length <= SIZE) return [text];
  const out = [];
  for (let at = 0; at < text.length; at += STRIDE) {
    out.push(text.slice(at, at + SIZE));
    if (at + SIZE >= text.length) break;
  }
  return out;
}

const chunkOf = [];
const texts = [];
for (let i = 0; i < docs.length; i += 1) {
  for (const w of windowsOf(hay(docs[i]))) { texts.push(w); chunkOf.push(i); }
}

console.log(`\n  块数 ${docs.length}　窗口 ${texts.length}（${(texts.length / docs.length).toFixed(1)} 个/块）`);
console.log(`  窗口 ${SIZE} 字符　步长 ${STRIDE}　源 sha256 ${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`);

const model = await createEmbedder(modelDir());
if (model === null) { console.error('✗ 编码器加载失败 —— 不写向量表'); process.exit(1); }
console.log(`  模型 ${model.model}　维度 ${model.dim}`);

const t0 = Date.now();
const vectors = new Float32Array(texts.length * model.dim);
const BATCH = Number(process.env.DSH_STORY_EMBED_BATCH ?? 16);
for (let i = 0; i < texts.length; i += BATCH) {
  const encoded = await model.embed(texts.slice(i, i + BATCH));
  for (let r = 0; r < encoded.length; r += 1) {
    vectors.set(encoded[r], (i + r) * model.dim);
  }
  if ((i / BATCH) % 20 === 0) {
    process.stdout.write(`\r  编码 ${Math.min(i + BATCH, texts.length)}/${texts.length}　${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
process.stdout.write('\n');

const meta = {
  model: model.model,
  dim: model.dim,
  count: texts.length,
  chunks: docs.length,
  chunkOf,
  size: SIZE,
  stride: STRIDE,
  pool: 'cls',
  scoring: 'max over windows (per chunk)',
  source: 'dist/story-chunks.jsonl',
  sourceSha256: createHash('sha256').update(raw).digest('hex'),
  builtAt: new Date().toISOString(),
  ms: Date.now() - t0
};

console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s（${((Date.now() - t0) / texts.length).toFixed(1)} ms/窗）`);
if (STATS_ONLY) { console.log('  --stats：不写文件\n'); process.exit(0); }

writeFileSync(OUT_F32, Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength));
writeFileSync(OUT_META, `${JSON.stringify(meta)}\n`, 'utf8');
console.log(`  → ${OUT_F32}（${(vectors.byteLength / 1024 / 1024).toFixed(2)} MB）`);
console.log(`  → ${OUT_META}\n`);
