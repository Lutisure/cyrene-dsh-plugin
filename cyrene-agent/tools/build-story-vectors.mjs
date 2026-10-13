/**
 * 构建剧情块的向量表（离线，一次性）
 *
 * ## 产物
 *
 *   dist/story-vectors.f32    986 × dim 的 float32 矩阵（已 L2 归一化，行序 = chunks 行序）
 *   dist/story-vectors.json   元信息：模型、维度、条数、**源文件的 sha256**、分窗方式
 *
 * 运行时（`story.mjs`）拿元信息里的 sha256 与 chunk 条数核对 —— 对不上就**不用**向量表，
 * 直接退回词法检索。这样「chunks 重建了但向量忘了重建」不会静默出错。
 *
 * ## 为什么分窗
 *
 * bge-small-zh 的上限是 512 token，而中文基本一字一 token、平均每块约 839 字符。
 * 直接截断会把块尾的答案切掉（「…最后一位逝于光历4295年」正好在块尾的例子就有）。
 * 所以长块**分两窗编码再取平均**，覆盖整块。
 *
 * 用法：
 *   node tools/build-story-vectors.mjs            # 全量重建
 *   node tools/build-story-vectors.mjs --stats    # 只看统计，不写文件
 *   DSH_STORY_EMBED=fake node tools/build-story-vectors.mjs   # 假向量（验管线，不验效果）
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createEmbedder, modelDir, MAX_TOKENS } from '../embedder.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHUNKS = `${ROOT}dist/story-chunks.jsonl`;
const OUT_F32 = `${ROOT}dist/story-vectors.f32`;
const OUT_META = `${ROOT}dist/story-vectors.json`;
const STATS_ONLY = process.argv.includes('--stats');

if (!existsSync(CHUNKS)) {
  console.error(`✗ 找不到 ${CHUNKS} —— 先跑 node tools/build-story-index.mjs`);
  process.exit(1);
}

const raw = readFileSync(CHUNKS, 'utf8');
const docs = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const hay = (d) => `${d.chapter ?? ''} ${d.node ?? ''}\n${d.text ?? ''}`;

console.log(`\n  源文件 ${CHUNKS}`);
console.log(`  块数 ${docs.length}　源 sha256 ${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`);
console.log(`  模型目录 ${modelDir()}`);

const model = await createEmbedder(modelDir());
if (model === null) {
  console.error('✗ 编码器加载失败（见上面 stderr）—— 不写向量表');
  process.exit(1);
}
console.log(`  模型 ${model.model}　维度 ${model.dim}`);

/** 长块分两窗：避免 512 token 截断把块尾切掉。 */
function windows(text) {
  const chars = MAX_TOKENS - 8;                       // 给 [CLS]/[SEP] 留位
  if (text.length <= chars) return [text];
  return [text.slice(0, chars), text.slice(-chars)];  // 头 + 尾（中间重叠部分被舍弃）
}

const t0 = Date.now();
const vectors = new Float32Array(docs.length * model.dim);
let truncated = 0;
const BATCH = Number(process.env.DSH_STORY_EMBED_BATCH ?? 8);

for (let i = 0; i < docs.length; i += BATCH) {
  const slice = docs.slice(i, i + BATCH);
  const parts = slice.map((d) => windows(hay(d)));
  const flat = parts.flat();
  if (parts.some((w) => w.length > 1)) truncated += 1;
  const encoded = await model.embed(flat);
  let cursor = 0;
  for (let r = 0; r < slice.length; r += 1) {
    const count = parts[r].length;
    const acc = new Float32Array(model.dim);
    for (let w = 0; w < count; w += 1) {
      const v = encoded[cursor + w];
      for (let c = 0; c < model.dim; c += 1) acc[c] += v[c] / count;
    }
    let norm = 0;
    for (const x of acc) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let c = 0; c < model.dim; c += 1) vectors[r * model.dim + c] = acc[c] / norm;
    cursor += count;
  }
  if ((i / BATCH) % 12 === 0) {
    const done = Math.min(i + BATCH, docs.length);
    process.stdout.write(`\r  编码 ${done}/${docs.length}　${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
process.stdout.write('\n');

const meta = {
  model: model.model,
  dim: model.dim,
  count: docs.length,
  source: 'dist/story-chunks.jsonl',
  sourceSha256: createHash('sha256').update(raw).digest('hex'),
  pool: 'cls',
  windows: 'head+tail when longer than 512 tokens',
  twoWindowChunks: truncated,
  builtAt: new Date().toISOString(),
  ms: Date.now() - t0
};

console.log(`  编码完成：${docs.length} 块，其中 ${truncated} 块分了两窗`);
console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s（${((Date.now() - t0) / docs.length).toFixed(1)} ms/块）`);

if (STATS_ONLY) {
  console.log('  --stats：不写文件\n');
  process.exit(0);
}

writeFileSync(OUT_F32, Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength));
writeFileSync(OUT_META, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
console.log(`  → ${OUT_F32}（${(vectors.byteLength / 1024 / 1024).toFixed(2)} MB）`);
console.log(`  → ${OUT_META}\n`);
