/**
 * 安装 embedding 模型到运行位置
 *
 * 默认目标：**这个脚本所在包的** `cyrene_embedding/bge-small-zh-v1.5`
 *
 * 正常安装（npm 包 / 分享副本）里模型**已经带着**，不用跑这个。
 * 它是给两种人用的：只拿了源码的人，和想自己换一份模型的人。
 *
 * ## 用法
 *
 *   node tools/deploy-embedding.mjs --download          # 从 hf-mirror 拉
 *   node tools/deploy-embedding.mjs --from F:/别的/目录   # 本地已有一份，直接拷
 *   node tools/deploy-embedding.mjs --target D:/x/models # 换个地方放
 *   node tools/deploy-embedding.mjs --force              # 已存在也重装
 *
 * **`--from` 没有默认值** —— 谁机器上的路径都不该写进要发出去的脚本里。
 *
 * ## 为什么要有 sha256
 *
 * 模型文件是**二进制**，拷坏了不会报错，只会让检索悄悄变差。
 * 六个文件的 sha256 固定在 `embedding-manifest.mjs` 里，装完逐个核对；对不上就**不写**。
 *
 * ## 网络
 *
 * 只有 `--download` 才会联网，而且**只允许 https + 白名单主机**。
 * 下载地址由常量与硬编码清单拼成，不接受任何外部传入的 URL。
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { HF_BASE, MANIFEST, defaultModelDir, matches, sha256Of } from './embedding-manifest.mjs';

/** 只允许这两台主机 —— 防止清单被改动后把请求发到别处。 */
const ALLOWED_HOSTS = new Set(['hf-mirror.com', 'huggingface.co']);

const arg = (name, fallback = null) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? true);
};

const TARGET = String(arg('target', defaultModelDir()));
const SOURCE = arg('from', null) === null ? null : String(arg('from'));
const DOWNLOAD = process.argv.includes('--download');
const FORCE = process.argv.includes('--force');

/**
 * 下载单个文件。
 *
 * ⚠️ 这里对 URL 做**白名单校验**：只允许 https、只允许 `ALLOWED_HOSTS` 里的主机。
 * 光靠「调用方传的是常量」不够 —— 校验写在函数里，改坏了也拦得住。
 */
async function fetchTo(url, dest) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`不是合法 URL：${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`只允许 https，拒绝 ${parsed.protocol}`);
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`只允许从 ${[...ALLOWED_HOSTS].join(' / ')} 取模型，拒绝 ${parsed.hostname}`);
  }
  const res = await fetch(parsed);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
}

console.log(`\n  目标  ${TARGET}`);
console.log(`  源    ${DOWNLOAD ? `${HF_BASE}（下载）` : (SOURCE ?? '（没给 --from —— 只能靠 --download）')}\n`);

let installed = 0;
let skipped = 0;
const failed = [];
for (const entry of MANIFEST) {
  const dest = join(TARGET, entry.path);
  const existing = matches(dest, entry);
  if (!FORCE && existing.ok) {
    console.log(`  ✓ 已是最新  ${entry.path}`);
    skipped += 1;
    continue;
  }
  const src = SOURCE === null ? null : join(SOURCE, entry.path);
  try {
    if (src !== null && existsSync(src) && sha256Of(src) === entry.sha256) {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    } else if (DOWNLOAD) {
      process.stdout.write(`  ↓ 下载 ${entry.path} … `);
      await fetchTo(`${HF_BASE}/${entry.path}`, dest);
      process.stdout.write('完成\n');
    } else {
      throw new Error(`本地源没有（${src}）；加 --download 从 hf-mirror 取`);
    }
    const check = matches(dest, entry);
    if (!check.ok) throw new Error(`装完校验失败：${check.why}`);
    console.log(`  ✓ 已安装    ${entry.path}  ${entry.bytes} bytes`);
    installed += 1;
  } catch (error) {
    const why = String(error?.message ?? error);
    failed.push(`${entry.path}: ${why}`);
    console.log(`  ✗ 失败      ${entry.path}  ${why}`);
  }
}

console.log(`\n  安装 ${installed}　跳过 ${skipped}　失败 ${failed.length}`);
if (failed.length > 0) {
  console.log('  ✗ 有文件没装好 —— 别急着开 embedding，先解决上面的失败项\n');
  process.exit(1);
}
console.log(`
  下一步：
  下一步：
    1. 在**包目录**里生成窗口向量表：  node tools/build-story-windows.mjs
    2. 自检：                          node tools/check-embedding.mjs
`);
