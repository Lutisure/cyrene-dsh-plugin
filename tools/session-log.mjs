/**
 * 会话日志的读取底座 —— session-tail / session-brief / session-dump 三个脚本共用。
 *
 * 有三个坑，都在这里处理掉：
 *
 * ① **磁盘上的是 `.zstd`，导出包里的是明文 `.jsonl`。**
 *    `~/.dsh/sessions/--<workspace>--/<session-id>/session.v4.jsonl.zstd` 是压缩的；
 *    界面导出的 zip 里那份是明文。同一个文件两种形态，按内容自动分流。
 *
 * ② **`.zstd` 是「多个 zstd 帧首尾相接」，而它们不是一行一帧。**
 *    2026-10-10 那个会话的日志里前 288 字节的明文就跨了 5 个帧边界。
 *    Node 自带的 `zstdDecompressSync` 只解**第一个**帧就停，紧接着报
 *    `ZSTD_error_prefix_unknown` —— 看着像文件坏了，其实是读法错了。
 *
 *    ⚠️ 帧边界**不能靠魔数扫描**：zstd 的魔数允许省略，
 *    而压缩数据里本来就可能出现那四个字节。这里让 zstd 自己算：
 *    流的 `bytesWritten` 就是「吃掉了我多少输入」，一点不含糊。
 *
 * ③ **它很大。** 同一份日志解压后 75.9 MB / 21,118 条。所以一律流式。
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createZstdDecompress } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const hasMagic = (b, at = 0) => b.length >= at + 4 && b.subarray(at, at + 4).equals(MAGIC);

export const isZstdName = (file) => /\.zstd$/i.test(String(file));

/** 解一个帧：喂齐字节、收完整输出、报出它吃了多少。 */
function inflateFrame(frame) {
  return new Promise((resolve, reject) => {
    const dec = createZstdDecompress();
    const out = [];
    dec.on('data', (c) => out.push(c));
    dec.on('error', reject);
    dec.on('end', () => resolve({ text: Buffer.concat(out), consumed: dec.bytesWritten }));
    dec.end(frame);
  });
}

/**
 * 把「多个首尾相接的 zstd 帧」解完。返回帧数、明文、以及**没能解开的尾巴**
 * （尾巴非空就是真异常 —— 别把它当成文件正常结束）。
 */
export async function decompressFrames(buf, limit = 1e6) {
  const out = [];
  let rest = buf;
  let frames = 0;
  while (hasMagic(rest)) {
    const { text, consumed } = await inflateFrame(rest);
    if (!(consumed > 0)) break;
    out.push(text);
    rest = rest.subarray(consumed);
    if (++frames >= limit) break;
  }
  return { frames, text: Buffer.concat(out).toString('utf8'), rest };
}

/** 读出整份日志的文本。`.zstd` 走解帧，明文原样返回。 */
export async function readLogText(file) {
  const chunks = [];
  const stream = createReadStream(file);
  for await (const c of stream) chunks.push(c);
  const buf = Buffer.concat(chunks);
  if (!hasMagic(buf)) {
    return { text: buf.toString('utf8').replace(/^\uFEFF/, ''), frames: 0, rest: Buffer.alloc(0) };
  }
  return decompressFrames(buf);
}

/** 逐行回调；跳过空行，坏行交给 onBad。 */
export async function forEachLine(file, onLine, onBad = null) {
  const { text } = await readLogText(file);
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { if (onBad) onBad(line); continue; }
    await onLine(o);
  }
}

/** 取末尾 n 条记录。顺序读完、只留最后 n 条。 */
export async function lastRecords(file, n) {
  const ring = [];
  await forEachLine(file, (o) => {
    ring.push(o);
    if (ring.length > n) ring.shift();
  });
  return ring;
}

/** 打印用：压成一行、掐断。 */
export function clip(s, n = 1200) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…[+${t.length - n}]` : t;
}

/** 序号：v4 放在 data 里，早期版本放在顶层。 */
export const seqOf = (o) => o?.data?.seq ?? o?.seq ?? null;

/** 给别人的调试入口：一眼看出这份日志有多少帧、多少行、尾巴干不干净。 */
export async function describeLog(file) {
  const { frames, text, rest } = await readLogText(file);
  const lines = text.split('\n').filter(Boolean);
  let parseable = 0;
  for (const l of lines) { try { JSON.parse(l); parseable++; } catch { /* 计数用 */ } }
  return { frames, lines: lines.length, parseable, restBytes: rest?.length ?? 0 };
}
