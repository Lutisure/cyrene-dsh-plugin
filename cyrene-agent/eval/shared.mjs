/**
 * 评测台的共用底座：仓库根、yaml、世界书装配、会话文件的读取。
 *
 * 本来这些和三层检查挤在 tools/eval.mjs 一个文件里（723 行）。要改 L2 的文风
 * 规则得先翻过 400 行检索断言，而检索那部分一年也动不了一次。
 *
 * 拆的原则：**一层一个文件，层与层之间不互相 import。** 只认这里的底座。
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import zlib from 'node:zlib';

// ---- 仓库根，从本文件的位置推（由 tools/derive-roots.mjs 加的头）----
//
// 以前这里写的是作者机器上的绝对路径。那只在那台机器上成立，
// 而且清洗脚本会把绝对路径换成占位符，于是代码里出现 <本仓库> 这种目录名，直接崩。
import { fileURLToPath as __f } from 'node:url';
import { dirname as __d, join as __j } from 'node:path';
export const REPO_ROOT = __j(__d(__f(import.meta.url)), '../..');

// ⚠️ `presets-check.mjs` 不在这里静态 import —— 它属于模式那一套，刻意不随包分发。
//    改成下面预设检查那段的按需动态 import。静态的话模块不在，整个评测台起不来。

const require = createRequire(import.meta.url);
export const yaml = require('js-yaml');

/**
 * profile 补丁里有 `!!js` 动态值表达式：
 *
 *     disabled: !!js process.platform === 'win32'
 *
 * js-yaml 默认不认识这个标签会抛。用一个自定义 Type 把它当字符串吃掉就行 ——
 * 这里只是**读**补丁做断言，不求值。
 */
export const PATCH_SCHEMA = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => data === null || typeof data === 'string',
    construct: (data) => (data === null ? '' : String(data)),
    predicate: () => false
  })
]);

/**
 * 会话日志是**多帧 zstd**（一个 zstd 帧接一个），不能整体解压 ——
 * 扫 `28 B5 2F FD` 魔数逐帧解，再拼起来。
 *
 * 为什么要内置这一步：第一版让人先手动导出成一份 jsonl 再喂进来，
 * 结果那份快照几小时后就过期了 —— 里面最后一个 `/cyrene` 是**更早那一次**，
 * 于是截出来零个样本，而所有检查对着零个样本打勾。
 * **评测台要自己去读当下的事实，不能依赖一份会过期的中间产物。**
 */
export function readSession(file) {
  const buf = readFileSync(file);
  const offsets = [];
  for (let i = 0; i + 3 < buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i);
  }
  if (offsets.length === 0) return buf.toString('utf8');
  const parts = [];
  for (let k = 0; k < offsets.length; k += 1) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(offsets[k], end)).toString('utf8')); } catch { /* 跳过坏帧 */ }
  }
  return parts.join('');
}

/** 找本机最新的一个会话文件。 */
export function newestSession() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  let best = null;
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let items; try { items = readdirSync(dir); } catch { return; }
    for (const item of items) {
      const full = `${dir}/${item}`;
      let info; try { info = statSync(full); } catch { continue; }
      if (info.isDirectory()) { walk(full, depth + 1); continue; }
      if (!item.startsWith('session.v4.jsonl')) continue;
      if (best === null || info.mtimeMs > best.mtimeMs) best = { full, mtimeMs: info.mtimeMs };
    }
  };
  walk(`${home}/.dsh/sessions`, 0);
  return best?.full ?? null;
}

export const ROOT = `${REPO_ROOT}/cyrene-agent`;
export const {
  buildWorldbook, explainEntries, createInjectionLog, DEFAULT_LIMIT, DEFAULT_BUDGET
} = await import(`file://${REPO_ROOT}/cyrene-agent/worldbook-logic.mjs`);
