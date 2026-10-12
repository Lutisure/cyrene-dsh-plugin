/**
 * 整份 profile 的起飞前检查。
 *
 * 崩过一次之后，光看单个插件不够了 —— DSH 的启动路径是：
 *
 *     readProfileManifest(package.json)      ← JSON.parse，BOM 就是在这里炸的
 *       → loadProfileDirectory
 *         → 按 bundles + 补丁挂载每个插件
 *
 * 任何一步抛就是整个进程起不来。这个脚本把那三步都走一遍，尽量在重启之前发现问题。
 *
 * 它跑在**真实的 profile 目录**上，读的是真实文件，不做任何修改。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';



const dir = process.argv[2];
if (!dir) {
  console.error('  用法: node preflight-profile.mjs <profile 目录>');
  process.exit(2);
}
/**
 * 内置包的判定。
 *
 * `@deepseek-ai/*` 是随应用发出来的，装在 app.asar 里，不在 profile 的 node_modules。
 * 它们一直是这样，不是问题 —— 第一版检查把它们报成失败，那是检查写错了。
 * 一个会误报的检查会被忽略，然后真正的问题也跟着被忽略。
 */
const IN_BOX = /^@deepseek-ai\//u;

/** app.asar 在哪。找不到就退化成「按内置处理」，不误报。 */
function inBoxRoot() {
  for (const guess of [
    '<DSH 安装目录>/resources/app.asar',
    join(process.env.LOCALAPPDATA ?? '', 'Programs/@deepseek-ai/dsh-desktop/resources/app.asar')
  ]) {
    try { if (existsSync(guess)) return guess; } catch { /* 忽略 */ }
  }
  return null;
}

const ASAR = inBoxRoot();

const require = createRequire(join(dir, 'noop.js'));
/**
 * 优先用 js-yaml —— 它支持自定义标签，而下面那个 \`!!js\` 是必需的。
 * 退到 \`yaml\` 时自定义标签会被忽略，那时解析含 \`!!js\` 的补丁会失败并如实报出来。
 */
const yaml = require('js-yaml');

/**
 * 让 js-yaml 认识 DSH 自己的 `!!js` 标签。
 *
 * 补丁里允许写 `!!js ctx.webStartup.openBrowser` —— 那是个**待求值的表达式**，
 * 由 Loader 在目标行注入的服务就绪之后才算。而 `js-yaml` 不认识这个标签，遇到
 * 就直接抛 `unknown tag !<tag:yaml.org,2002:js>`。
 *
 * 这个检查器以前没遇到它，只因为那时候补丁里一个 `!!js` 都没有。加上第一个之后，
 * 整个 preflight 就在 YAML 那一步挂了 —— 一个看不懂输入格式的检查器等于没有检查器。
 *
 * 处理方式：把 `!!js` 的值**原样当字符串收下**。这里要验的是「文件能不能被解析、
 * 结构对不对」，不是「表达式求值成什么」—— 后者只有 Loader 做得了。
 */
const JS_TAG = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (value) => typeof value === 'string',
  construct: (value) => ({ __js: value })
});

/** 带 `!!js` 的解析器。定义必须在 JS_TAG 之后 —— 上一版就是顺序反了，直接 TDZ 崩掉。 */
const SCHEMA = yaml.DEFAULT_SCHEMA.extend([JS_TAG]);

let failures = 0;
const ok = (label, extra = '') => console.log(`  ✓  ${label}${extra ? '  ' + extra : ''}`);
const bad = (label, why) => { failures += 1; console.log(`  ✗  ${label}\n       ${why}`); };

/** 有没有 BOM。JSON.parse 会在第一个字符上炸，而错误信息不会告诉你是 BOM。 */
function hasBom(path) {
  const b = readFileSync(path);
  return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
}

// ---- 1. package.json ----------------------------------------------------
const pkgPath = join(dir, 'package.json');
let pkg = null;
try {
  if (hasBom(pkgPath)) bad('package.json', '文件带 BOM —— JSON.parse 会在第一个字符上失败（就是上次崩的原因）');
  else {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    ok('package.json', 'JSON.parse 通过');
  }
} catch (e) {
  bad('package.json', e.message);
}

// ---- 2. cordis.patch.yml ------------------------------------------------
const patchPath = join(dir, 'cordis.patch.yml');
let patches = [];
try {
  if (hasBom(patchPath)) bad('cordis.patch.yml', '文件带 BOM');
  else {
    patches = yaml.load(readFileSync(patchPath, 'utf8'), { schema: SCHEMA }) ?? [];
    ok('cordis.patch.yml', `YAML 通过，顶层 ${patches.length} 项`);
  }
} catch (e) {
  bad('cordis.patch.yml', e.message);
}

// ---- 3. 每个依赖都能解析到 ----------------------------------------------
const deps = Object.keys(pkg?.dependencies ?? {});
const nm = join(dir, 'node_modules');
for (const dep of deps) {
  const at = join(nm, dep);
  if (!existsSync(at)) { bad(`依赖 ${dep}`, `node_modules/${dep} 不存在`); continue; }
  let entry;
  try {
    const manifest = JSON.parse(readFileSync(join(at, 'package.json'), 'utf8'));
    entry = manifest.main ?? 'index.js';
  } catch (e) {
    bad(`依赖 ${dep}`, `它的 package.json 读不动：${e.message}`);
    continue;
  }
  const target = join(at, typeof entry === 'string' ? entry : 'index.js');
  if (!existsSync(target)) { bad(`依赖 ${dep}`, `入口不存在：${target}`); continue; }
  ok(`依赖 ${dep}`, `→ ${target.startsWith('F:') || target.startsWith('C:') ? target : target.replace(dir + '\\', '')}`);
}

// ---- 4. bundles 里的每个包都在 ------------------------------------------
for (const bundle of pkg?.dsh?.profile?.bundles ?? []) {
  if (existsSync(join(nm, bundle))) ok(`bundle ${bundle}`, '在 profile 里');
  else if (IN_BOX.test(bundle)) ok(`bundle ${bundle}`, '内置包' + (ASAR ? '' : '（未找到 app.asar，按内置处理）'));
  else bad(`bundle ${bundle}`, 'bundles 里列了但装不上');
}

// ---- 5. 补丁 insert 的每一行都能解析到 ----------------------------------
for (const row of patches.flatMap((r) => r?.insert ?? [])) {
  const at = join(nm, row.name);
  if (existsSync(at)) { ok(`补丁行 ${row.id}`, `→ ${row.name}`); continue; }
  if (IN_BOX.test(row.name)) { ok(`补丁行 ${row.id}`, `→ ${row.name}（内置）`); continue; }
  bad(`补丁行 ${row.id}`, `名字 "${row.name}" 在 node_modules 里找不到 —— 挂载会失败`);
}

// ---- 6. 每个我们自己写的插件都能 import 且导出正确 ----------------------
// 只测链接到本地的那些：node_modules 里的第三方包不归我们管，而且它们没有副作用地
// import 未必可行。
const OURS = ['cyrene-guard', 'cyrene-agent', 'dsh-theme-cyrene'];
for (const dep of deps.filter((d) => OURS.includes(d))) {
  const at = join(nm, dep);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(at, 'package.json'), 'utf8'));
  } catch (e) {
    bad(`插件 ${dep}`, `package.json：${e.message}`);
    continue;
  }
  const main = join(at, typeof manifest.main === 'string' ? manifest.main : 'index.js');
  // 只 import 宿主侧入口。客户端那一半要浏览器环境，在这里 import 会缺 window。
  if (/client/i.test(main)) { ok(`插件 ${dep}`, '客户端入口，跳过 import'); continue; }
  try {
    const mod = await import(pathToFileURL(main).href);
    const exported = mod.default ?? mod;
    const shape = typeof exported === 'function' || typeof exported.apply === 'function';
    if (!shape) { bad(`插件 ${dep}`, '没有导出 apply()（也不是一个函数）'); continue; }
    const injectList = mod.inject ?? exported.inject;
    ok(`插件 ${dep}`, `import 通过，inject=${JSON.stringify(injectList ?? null)}`);
  } catch (e) {
    bad(`插件 ${dep}`, `import 失败：${e.message.split('\n')[0]}`);
  }
}

// ---- 结论 --------------------------------------------------------------
console.log('');
if (failures === 0) {
  console.log('  全部通过 —— 这份 profile 可以启动。');
  process.exit(0);
}
console.log(`  ${failures} 处问题 —— 先修再重启，否则会像上次一样起不来。`);
process.exit(1);
