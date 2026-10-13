/**
 * 模型文件清单（固定版本）—— 安装脚本与自检脚本共用
 *
 * 版本：Xenova/bge-small-zh-v1.5（BAAI/bge-small-zh-v1.5 的 int8 ONNX 转换）
 * 来源：https://hf-mirror.com/Xenova/bge-small-zh-v1.5
 *
 * 六个文件的 sha256 全部固定。**二进制拷坏了不会报错，只会让检索悄悄变差** ——
 * 所以装完必须逐个核对，对不上就不写。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MANIFEST = [
  { path: 'config.json', bytes: 716, sha256: 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f' },
  { path: 'onnx/model_quantized.onnx', bytes: 24010842, sha256: '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc' },
  { path: 'special_tokens_map.json', bytes: 125, sha256: 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3' },
  { path: 'tokenizer.json', bytes: 439125, sha256: '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26' },
  { path: 'tokenizer_config.json', bytes: 367, sha256: 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a' },
  { path: 'vocab.txt', bytes: 109540, sha256: '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c' }
];

export const HF_BASE = 'https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main';

/**
 * 运行位置：`<包>/cyrene_embedding/bge-small-zh-v1.5`。
 *
 * ⚠️ 必须和 `embedder.mjs` 的 `modelDir()` 指着**同一个地方**。
 * 两边各指一处的话，会出现「模型装好了、插件却读不到」这种一声不响的失败。
 */
export function defaultModelDir() {
  return fileURLToPath(new URL('../cyrene_embedding/bge-small-zh-v1.5', import.meta.url));
}

export const sha256Of = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** 单个文件是否与清单完全一致（存在 + 字节数 + sha256）。 */
export function matches(file, entry) {
  if (!existsSync(file)) return { ok: false, why: '文件不存在' };
  const size = statSync(file).size;
  if (size !== entry.bytes) return { ok: false, why: `字节数 ${size} ≠ ${entry.bytes}` };
  if (sha256Of(file) !== entry.sha256) return { ok: false, why: 'sha256 对不上' };
  return { ok: true, why: '' };
}
