/**
 * 把工具里写死的绝对路径换成「从文件自身位置推」。
 *
 * ## 为什么会有这个脚本
 *
 * 2026-10-10，导出分享副本之后跑了一遍，`check-grounding.mjs` 当场崩：
 *
 *     Error: ENOENT ... '\cyrene-agent\<本仓库>\cyrene-agent\worldbook\entries.yaml'
 *
 * `<本仓库>` 是清洗脚本留下的占位符 —— 它把源码里写死的 `<本仓库>`
 * 换掉了。**但那个写死的路径本来就是缺陷**：这些工具只在作者那台机器上能跑。
 * 清洗只是让它变得显眼。
 *
 * ## 做法
 *
 * 每个用到的文件加三行，把根目录从 `import.meta.url` 推出来，然后把
 * `'<本仓库>/...'` 这类字面量换成模板字符串。
 *
 * 这样：换台机器照样能跑、仓库改名照样能跑、清洗也不会再碰到它。
 *
 * 用法：
 *   node tools/derive-roots.mjs <目录> [--dry]
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const [target, ...flags] = process.argv.slice(2);
if (target === undefined) {
  process.stderr.write('  用法：node tools/derive-roots.mjs <目录> [--dry]\n');
  process.exit(1);
}
const DRY = flags.includes('--dry');

const HEADER_MARK = '由 tools/derive-roots.mjs 加的头';

/** 这些字面量代表仓库根，替换成 REPO_ROOT。 */
const ROOTS = ['<本仓库>', '<本仓库>', '<本仓库>'];

/** 这个文件里出现过的、需要修的字面量形式。 */
const PATTERNS = [
  // const ROOT = '<本仓库>/cyrene-agent';
  [/(\bconst\s+\w+\s*=\s*)'(<本仓库>|F:[/\\]DSH_Plugins)(\/[^']*)'/gu, (_m, pre, _root, rest) => `${pre}\`\${REPO_ROOT}${rest}\``],
  // const OUT = process.env.HSR_DATA ?? '<本仓库>/.data/hsr'
  [/(\?\?\s*)'(<本仓库>|F:[/\\]DSH_Plugins)(\/[^']*)'/gu, (_m, pre, _root, rest) => `${pre}\`\${REPO_ROOT}${rest}\``],
  // createRequire('<本仓库>/cyrene-agent/x.js')
  [/createRequire\('(<本仓库>|F:[/\\]DSH_Plugins)(\/[^']*)'\)/gu, (_m, _root, rest) => `createRequire(\`\${REPO_ROOT}${rest}\`)`],

  [/import\('file:\/\/\/(<本仓库>|F:[/\\]DSH_Plugins)(\/[^']*)'\)/gu, (_m, _root, rest) => `import(\`file://\${REPO_ROOT}${rest}\`)`]
];

/** 这个文件需要几层 `..` 才到仓库根？按它在仓库里的深度算。 */
const depthOf = (rel) => rel.split(/[\\/]/u).length - 1;

const files = [];

/**
 * ⚠️ 这些文件**必须**写出那些字符串，不能改。
 *
 * 清洗和审计工具的词表里就得有 `<本仓库>` 这种路径 —— 它们的工作就是
 * 找到并替换它。把词表改成 `REPO_ROOT`，工具立刻失去作用。
 * （这个是脚本自己的本能反应，第一版 dry run 就把自己列了进去。）
 */
const NEVER = new Set([
  'derive-roots.mjs',
  'make-share.mjs',
  'audit-shareable.mjs',
  'audit-git-history.mjs'
]);

const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const at = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '__pycache__', '.git'].includes(entry.name)) continue;
      walk(at);
      continue;
    }
    if (!/\.(mjs|js)$/u.test(entry.name)) continue;
    if (NEVER.has(entry.name)) continue;
    files.push(at);
  }
};
walk(target);

let changed = 0;
for (const file of files) {
  const rel = relative(target, file);
  const before = readFileSync(file, 'utf8');
  if (!ROOTS.some((r) => before.includes(r))) continue;

  let after = before;
  let touched = false;
  for (const [re, fn] of PATTERNS) {
    const next = after.replace(re, fn);
    if (next !== after) { after = next; touched = true; }
  }
  // 注释里的占位符（`session-index.mjs` 那种）不动 —— 它不是代码。
  const codeOnly = after.replace(/^(\s*)(\*|\/\/).*$/gmu, '');
  if (!touched || !codeOnly.includes('REPO_ROOT')) {
    if (!touched) continue;
  }

  // 加头：算出 REPO_ROOT
  if (!after.includes(HEADER_MARK)) {
    const ups = depthOf(rel);
    const up = ups === 0 ? '.' : Array.from({ length: ups }, () => '..').join('/');
    const header = `
// ---- 仓库根，从本文件的位置推（${HEADER_MARK}）----
//
// 以前这里写的是作者机器上的绝对路径。那只在那台机器上成立，
// 而且清洗脚本会把绝对路径换成占位符，于是代码里出现 <本仓库> 这种目录名，直接崩。
import { fileURLToPath as __f } from 'node:url';
import { dirname as __d, join as __j } from 'node:path';
const REPO_ROOT = __j(__d(__f(import.meta.url)), '${up}');
`;
    after = after.replace(/^(import .*\n)+/mu, (m) => m + header);
    if (!after.includes(HEADER_MARK)) after = header + '\n' + after;
  }

  if (after !== before) {
    if (!DRY) writeFileSync(file, after, 'utf8');
    changed += 1;
    process.stdout.write(`  ${DRY ? '(dry) ' : ''}${rel}\n`);
  }
}

process.stdout.write(`\n  ${changed} 个文件${DRY ? '（没有写盘）' : ' 已改'}\n`);
