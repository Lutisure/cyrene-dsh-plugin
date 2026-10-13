/**
 * 本地编码器：ONNX 模型 + 手写 WordPiece
 *
 * ## 为什么手写 tokenizer
 *
 * `@huggingface/transformers` 会带进一整层运行时（几百 MB）。这里只要两件事：
 * 把中文切成 BERT WordPiece、把 512 token 以内的序列喂给 ONNX。手写约 90 行，
 * 而且**可以离线测**（不需要模型也能验分词）。
 *
 * ## 契约（和 file-cache.mjs 同一套纪律）
 *
 *   绝不抛错：加载失败返回 null，调用方退回词法检索
 *   只警告一次：不刷屏
 *   可注入：`DSH_STORY_EMBED_DIR` 指定模型目录；`DSH_STORY_EMBED=fake` 用假向量
 *
 * ## 池化
 *
 * bge 系列用 **CLS 向量**（`last_hidden_state[:, 0]`），再 L2 归一化。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MAX_TOKENS = 512;

/** 包自己的目录 —— 和 `worldbook.mjs` 同一条纪律：按模块位置定，不认 `DSH_HOME`。 */
const PACKAGE_DIR = fileURLToPath(new URL('.', import.meta.url));

/**
 * 模型目录：默认 `<包>/cyrene_embedding/bge-small-zh-v1.5`。
 *
 * 放在包里，是为了让模型和代码同一次安装一起到 —— 装到 `$DSH_HOME` 下的话，
 * 换一台机器、或重装一次包，模型和读它的那份代码就分成两处各自过期。
 * `DSH_STORY_EMBED_DIR` 仍然可以指到别处（离线机器、包目录只读的场合）。
 */
export function modelDir() {
  if (process.env.DSH_STORY_EMBED_DIR) return process.env.DSH_STORY_EMBED_DIR;
  return join(PACKAGE_DIR, 'cyrene_embedding', 'bge-small-zh-v1.5');
}

/** 是不是「假向量」模式（测试与离线验证用）。 */
export const isFake = () => process.env.DSH_STORY_EMBED === 'fake';

let warned = false;
const warnOnce = (message) => {
  if (warned) return;
  warned = true;
  try { process.stderr.write(`[cyrene-agent/embedder] ${message}\n`); } catch { /* 放弃 */ }
};

/** CJK 与全角标点的范围 —— 这些字符在 BERT 中文词表里通常各自成 token。 */
const isCjk = (ch) => {
  const code = ch.codePointAt(0);
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x3040 && code <= 0x30ff) || (code >= 0xf900 && code <= 0xfaff);
};
const isSpace = (ch) => /\s/u.test(ch);
/** BERT 的标点切分：标点单独成 token。 */
const isPunct = (ch) => {
  const code = ch.codePointAt(0);
  return (code >= 0x21 && code <= 0x2f) || (code >= 0x3a && code <= 0x40)
    || (code >= 0x5b && code <= 0x60) || (code >= 0x7b && code <= 0x7e)
    || (code >= 0x3000 && code <= 0x303f) || (code >= 0xff00 && code <= 0xffef);
};

/**
 * 读 tokenizer.json，返回 `{vocab, ids}`。
 *
 * 只取需要的东西：词表、三个特殊 token 的 id、是否小写。
 */
export function loadVocab(dir) {
  const file = join(dir, 'tokenizer.json');
  if (!existsSync(file)) return null;
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    const vocab = cfg.model?.vocab;
    if (vocab === null || typeof vocab !== 'object') return null;
    const idOf = (token) => vocab[token];
    const unk = idOf('[UNK]');
    const cls = idOf('[CLS]');
    const sep = idOf('[SEP]');
    if (unk === undefined || cls === undefined || sep === undefined) return null;
    const lower = String(cfg.normalizer?.lowercase ?? true) !== 'false';
    const maxChars = cfg.model?.max_input_chars_per_word ?? 100;
    return { vocab, unk, cls, sep, lower, maxChars };
  } catch {
    return null;
  }
}

/**
 * WordPiece：先按「空格 / 标点 / CJK」切开，再对拉丁串做最长匹配。
 *
 * @param {string} text - 原文。
 * @param {object} tk - `loadVocab()` 的结果。
 * @returns {string[]} token 串（不含 [CLS]/[SEP]）。
 */
export function tokenize(text, tk) {
  const out = [];
  const src = String(text ?? '');
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (isSpace(ch)) { i += 1; continue; }
    if (isPunct(ch) || isCjk(ch)) { out.push(ch); i += 1; continue; }
    // 拉丁/数字串：一路吃到空格、标点或 CJK 为止
    let j = i;
    while (j < src.length && !isSpace(src[j]) && !isPunct(src[j]) && !isCjk(src[j])) j += 1;
    let word = src.slice(i, j);
    i = j;
    if (tk.lower) word = word.toLowerCase();
    if (word.length > tk.maxChars) { out.push('[UNK]'); continue; }
    // 贪心最长匹配
    let start = 0;
    const pieces = [];
    let ok = true;
    while (start < word.length) {
      let end = word.length;
      let found = null;
      while (start < end) {
        const piece = (start > 0 ? '##' : '') + word.slice(start, end);
        if (tk.vocab[piece] !== undefined) { found = piece; break; }
        end -= 1;
      }
      if (found === null) { ok = false; break; }
      pieces.push(found);
      start = end;
    }
    if (!ok) out.push('[UNK]');
    else out.push(...pieces);
  }
  return out;
}

/** token 串 → id 序列（带 [CLS]/[SEP]，截到 512）。 */
export function encodeIds(text, tk) {
  const pieces = tokenize(text, tk).slice(0, MAX_TOKENS - 2);
  return [tk.cls, ...pieces.map((p) => (tk.vocab[p] ?? tk.unk)), tk.sep];
}

/**
 * 假编码器：**确定性**哈希词袋向量。
 *
 * 用途只有一个 —— 让「向量那条路」的管线在**不下载模型、不联网**的情况下可测。
 * 它不是语义模型：`DSH_STORY_EMBED=fake` 只验证接线，不验证效果。
 *
 * @param {number} [dim] - 维度。
 * @returns {(texts: string[]) => Promise<Float32Array[]>} 编码函数。
 */
export function fakeEmbedder(dim = 64) {
  return async (texts) => texts.map((text) => {
    const vec = new Float32Array(dim);
    const clean = String(text ?? '').replace(/\s+/gu, '');
    for (let i = 0; i + 1 < clean.length; i += 1) {
      const g = clean.slice(i, i + 2);
      const h = createHash('sha1').update(g).digest();
      vec[h[0] % dim] += 1;
      vec[h[1] % dim] += 0.5;
    }
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i += 1) vec[i] /= norm;
    return vec;
  });
}

/**
 * 真编码器：ONNX Runtime + bge-small-zh-v1.5。
 *
 * @param {string} [dir] - 模型目录。
 * @returns {Promise<{embed: (texts: string[]) => Promise<Float32Array[]>, dim: number, model: string}|null>}
 *          加载失败时返回 null（调用方退回词法检索）。
 */
export async function createEmbedder(dir = modelDir()) {
  if (isFake()) {
    const embed = fakeEmbedder();
    return { embed, dim: 64, model: 'fake' };
  }
  const onnx = join(dir, 'onnx', 'model_quantized.onnx');
  const tk = loadVocab(dir);
  if (tk === null) { warnOnce(`读不到 tokenizer.json（${dir}）—— 退回词法检索`); return null; }
  if (!existsSync(onnx)) { warnOnce(`读不到模型文件（${onnx}）—— 退回词法检索`); return null; }
  let ort;
  try {
    ort = (await import('onnxruntime-node')).default;
  } catch {
    warnOnce('没装 onnxruntime-node —— 退回词法检索');
    return null;
  }
  let session;
  try {
    session = await ort.InferenceSession.create(onnx, { intraOpNumThreads: 4 });
  } catch (error) {
    warnOnce(`模型加载失败（${String(error?.message ?? error)}）—— 退回词法检索`);
    return null;
  }

  const batch = Number(process.env.DSH_STORY_EMBED_BATCH ?? 8);

  /** 一批文本 → 归一化后的 CLS 向量。 */
  async function run(texts) {
    const ids = texts.map((t) => encodeIds(t, tk));
    const width = Math.min(MAX_TOKENS, Math.max(...ids.map((r) => r.length)));
    const n = ids.length;
    const inputIds = new BigInt64Array(n * width);
    const mask = new BigInt64Array(n * width);
    const types = new BigInt64Array(n * width);
    for (let r = 0; r < n; r += 1) {
      for (let c = 0; c < width; c += 1) {
        const value = ids[r][c] ?? 0;
        inputIds[r * width + c] = BigInt(value);
        mask[r * width + c] = BigInt(c < ids[r].length ? 1 : 0);
      }
    }
    const feeds = {
      input_ids: new ort.Tensor('int64', inputIds, [n, width]),
      attention_mask: new ort.Tensor('int64', mask, [n, width]),
      token_type_ids: new ort.Tensor('int64', types, [n, width])
    };
    const result = await session.run(feeds);
    const first = result[session.outputNames[0]];
    const dim = first.dims[2];
    const out = [];
    for (let r = 0; r < n; r += 1) {
      // CLS 池化：第 0 个 token
      const vec = new Float32Array(dim);
      for (let c = 0; c < dim; c += 1) vec[c] = first.data[r * width * dim + c];
      let norm = 0;
      for (const v of vec) norm += v * v;
      norm = Math.sqrt(norm) || 1;
      for (let c = 0; c < dim; c += 1) vec[c] /= norm;
      out.push(vec);
    }
    return out;
  }

  const probe = await run(['探针']);
  return {
    dim: probe[0].length,
    model: `bge-small-zh-v1.5@${dir}`,
    embed: async (texts) => {
      const out = [];
      for (let i = 0; i < texts.length; i += batch) {
        out.push(...await run(texts.slice(i, i + batch)));
      }
      return out;
    }
  };
}
