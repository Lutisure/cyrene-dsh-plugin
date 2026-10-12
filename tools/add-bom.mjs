/**
 * 给 PowerShell 脚本补 UTF-8 BOM。
 *
 * ## 为什么
 *
 * **PowerShell 5.1 读 `.ps1` 时按 ANSI（本机是 GBK）解，除非文件带 UTF-8 BOM。**
 * PowerShell 7（`pwsh`）不看这个，两种都能读 —— 所以问题只在**只有 5.1 的机器**上出现。
 *
 * 这台机器就没有 `pwsh`，而 `setup/install.cmd` 调的正是 `powershell`（5.1）：
 *
 *     powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
 *
 * ## 症状是什么
 *
 * 不是「中文显示成乱码」那么简单。乱码会**破坏解析** ——
 * 一个三字节的汉字被按两字节解，末尾可能剩下半个字节序列，
 * 而那半个恰好能吃掉一个引号或括号，于是整个脚本 `Unexpected token` 起不来。
 *
 * 2026-10-11 实测：`install.ps1` 加了一句带中文的注释之后，
 * **解析错误报在注释行上** —— 因为乱的其实是更早的地方。
 *
 * ## 为什么 `.cmd` 也要
 *
 * `install.cmd` 里有 `chcp 65001`，那是为了控制台**输出**；
 * 而它自己的 `rem` 注释同样是 UTF-8 无 BOM，在 5.1 下一样会乱。
 * 不过 `.cmd` 由 `cmd.exe` 执行，行为不同 —— **这里统一补上，让它两边都对。**
 *
 * 用法：
 *   node tools/add-bom.mjs --check     只看哪些缺
 *   node tools/add-bom.mjs             补上
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

/** 脚本可能在的目录。 */
const ROOTS = ['setup', 'tools'];

/** 需要 BOM 的扩展名。`.mjs`/`.js` **不在里面** —— node 自己会处理，加了反而多余。 */
const EXTS = ['.ps1', '.cmd', '.vbs'];

/**
 * 递归收集脚本。
 *
 * @param {string} dir - 起始目录。
 * @returns {string[]} 文件路径。
 */
function collect(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__pycache__') continue;
      out.push(...collect(full));
    } else if (EXTS.some((x) => e.name.endsWith(x))) {
      out.push(full);
    }
  }
  return out;
}

const checkOnly = process.argv.includes('--check');
const files = ROOTS.flatMap((r) => collect(r));

const missing = [];
for (const f of files) {
  const buf = readFileSync(f);
  const has = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  if (has) continue;
  missing.push(f);
  if (!checkOnly) {
    writeFileSync(f, Buffer.concat([BOM, buf]));
  }
}

console.log(`\n  扫了 ${files.length} 个脚本，缺 BOM 的 ${missing.length} 个\n`);
for (const f of missing) console.log(`    ${checkOnly ? '' : '补了  '}${f}`);
if (missing.length === 0) console.log('    （都带了）');
console.log('');
if (checkOnly && missing.length > 0) {
  console.log('  跑 `node tools/add-bom.mjs` 补上。\n');
}
