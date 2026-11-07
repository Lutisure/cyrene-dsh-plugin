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

import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';



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
let warns = 0;
const ok = (label, extra = '') => console.log(`  ✓  ${label}${extra ? '  ' + extra : ''}`);
const bad = (label, why) => { failures += 1; console.log(`  ✗  ${label}\n       ${why}`); };
// 警告不算失败：只在「这条把握不大」时用。一个会误报的检查会被关掉，
// 所以宁可让不确定的东西显形，不让它拦住启动。
const warn = (label, why) => { warns += 1; console.log(`  ⚠  ${label}\n       ${why}`); };

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

// ---- 5. 补丁里的每一行插件名都能真的被解析到 ----------------------------
//
// 这一节出过一次**静默漏检**，教训留着。
//
// 旧版的做法：拿 row.name 去 join(nm, ...) 看目录在不在；只要名字以
// `@deepseek-ai/` 开头，就直接 ok('（内置）') 通过 —— 理由是内置包在 app.asar 里，
// 查不了。于是它**从来没验过一个子路径**。
//
// 2026-11-04 应用升级到内置运行时 0.2.2-rc.1。这一版把
// `@deepseek-ai/dsh-tool-subagent-control` 的 `./list-agents` 子路径撤了
// （list_agents 并进了 index.js），而昔涟 dev 预设里还留着一行
//     - name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
// 挂载时 import 直接抛 ERR_PACKAGE_PATH_NOT_EXPORTED。注意：**包在、名字也对**，
// 错的是子路径 —— 这种错，按包名做的检查永远看不见。那一行连 fiber 都没建出来，
// auditRows 报 "never started"，设置页那张卡从此写着「加载失败」，而这一节当时
// 印的是「✓ 内置」。
//
// 所以改成：**不按名字猜，按解析结果判**。app.asar 不是真实目录（Node 的
// createRequire 在里面找不到文件），所以得自己读 asar 里的 package.json，
// 再按 exports 的规则匹配子路径。格式不复杂，抄一遍比「跳过内置包」划算。
//
// 另外：旧版只遍历**顶层** insert 行。预设里的人 (preset) 把插件写在
// config.plugins 里，那是嵌套的 —— 出问题的那一行正好就在那一层，
// 旧版连看都没看到它。所以这里递归。

/** asar 头：`[4][pickleSize][json]`，数据区紧跟其后。读不出来就是 -1（不当成失败）。 */
let ASAR_INDEX = undefined;
function asarIndex() {
  if (ASAR_INDEX !== undefined) return ASAR_INDEX;
  ASAR_INDEX = null;
  if (!ASAR) return ASAR_INDEX;
  try {
    const fd = openSync(ASAR, 'r');
    try {
      const head = Buffer.alloc(16);
      readSync(fd, head, 0, 16, 0);
      // 两种可能的布局都试一遍，哪种 JSON 解得开用哪种 —— 比记死偏移量可靠。
      for (const [jsonAt, jsonLen] of [[12, head.readUInt32LE(4) - 4], [16, head.readUInt32LE(12)]]) {
        try {
          const buf = Buffer.alloc(jsonLen);
          readSync(fd, buf, 0, jsonLen, jsonAt);
          const header = JSON.parse(buf.toString('utf8'));
          ASAR_INDEX = { header, base: jsonAt + jsonLen };
          break;
        } catch { /* 换下一种布局 */ }
      }
    } finally { closeSync(fd); }
  } catch { ASAR_INDEX = null; }
  return ASAR_INDEX;
}

/** 读 asar 里的一个文件（路径用 `/` 分隔）。读不到返回 null。 */
function asarFile(relPath) {
  const idx = asarIndex();
  if (!idx) return null;
  let node = idx.header;
  for (const part of relPath.split('/')) {
    node = node?.files?.[part];
    if (!node) return null;
  }
  if (typeof node.offset !== 'string' || typeof node.size !== 'number') return null;
  if (node.unpacked) {
    // 这类文件在 app.asar.unpacked 里，是真目录。
    try { return readFileSync(join(ASAR + '.unpacked', relPath)); } catch { return null; }
  }
  try {
    const fd = openSync(ASAR, 'r');
    try {
      const buf = Buffer.alloc(node.size);
      readSync(fd, buf, 0, node.size, idx.base + Number(node.offset));
      return buf;
    } finally { closeSync(fd); }
  } catch { return null; }
}

/**
 * asar 里的一个目录节点（不读内容，只拿到子树）。找不到返回 null。
 *
 * 和 `asarFile` 分开是因为这里要**遍历**：一个包有哪些文件，只有索引知道。
 */
function asarNode(relPath) {
  const idx = asarIndex();
  if (!idx) return null;
  let node = idx.header;
  for (const part of relPath.split('/')) {
    node = node?.files?.[part];
    if (!node) return null;
  }
  return node;
}

// 一个包的全部源码拼起来，按包名缓存 —— 同一个包常被好几行引用。
const SOURCES = new Map();

/**
 * 把装在 app.asar 里的某个包，能读到的源码全拼成一段。
 *
 * 用途只有一个：核对**配置键还在不在这一版里**。
 *
 * 为什么不真读 schema：插件导出的 Config 是运行时构造的 zod 对象，躺在 asar 里，
 * 普通 node 既 import 不了、也 eval 不了 —— 它不在真目录里，`require` 找不到文件。
 * 而当一版撤掉一个键或把它改名，那个字符串在包里必然跟着消失。
 *
 * 2026-11-04 那次升级就是两件事一起发生：`@deepseek-ai/dsh-tool-subagent-control`
 * 撤了 `./list-agents` 子路径（那一条现在会报失败），同时两个键改了名
 * （`modelSelectionSettings` → `modelSelection`，`backgroundMode` 整个没了）。
 * 前一件让行直接起不来，后一件**一声不响**地把配置丢掉 —— 后者才是更难发现的。
 *
 * 反过来不成立：键名可能是拼出来的、或藏在被压缩过的代码里，所以**只在找不到时
 * 警告，不判失败**。
 */
function inBoxSources(pkg) {
  if (SOURCES.has(pkg)) return SOURCES.get(pkg);
  let text = '';
  const root = asarNode(`dsh/node_modules/${pkg}`);
  if (root) {
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node?.files ?? {})) {
        const rel = prefix ? `${prefix}/${name}` : name;
        if (child.files) { walk(child, rel); continue; }
        if (!/\.(?:js|mjs|cjs|d\.ts|json)$/u.test(name)) continue;
        const buf = asarFile(`dsh/node_modules/${pkg}/${rel}`);
        if (buf) text += buf.toString('utf8');
      }
    };
    walk(root, '');
  }
  SOURCES.set(pkg, text);
  return text;
}

/**
 * 行里写的 `config` 键，在这一版的包里还认不认。
 *
 * 只看**第一层**键：嵌套里的东西（比如预设的 `plugins` 数组）由各自的行自己负责，
 * 在这一层往下钻只会把别的插件用到的键算到当前这个头上。
 */
function checkConfigKeys(row) {
  const config = row.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
  const keys = Object.keys(config);
  if (keys.length === 0) return [];
  const { pkg } = splitSpecifier(row.name);
  const text = inBoxSources(pkg);
  if (!text) return []; // 读不到源码（没打包 / 没 unpacked）→ 不猜
  return keys.filter((k) => !text.includes(k));
}

/**
 * exports 里有没有这个子路径。
 *
 * `subpath` 形如 `''`（包本身）或 `'./list-agents'`。
 * 没有 exports 字段的老式包一律放行 —— 那是 Node 自己的语义，不是我们放宽。
 */
function exportsAllows(exportsField, subpath) {
  if (exportsField === undefined || exportsField === null) return true;
  const isMap = exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)
    && Object.keys(exportsField).length > 0
    && Object.keys(exportsField).every((k) => k.startsWith('.'));
  if (!isMap) return subpath === ''; // 整个 exports 描述的是 "."
  const want = subpath === '' ? '.' : subpath;
  const hit = (key) => {
    if (key === want) return true;
    const star = key.indexOf('*');
    if (star < 0) return false;
    const pre = key.slice(0, star);
    const post = key.slice(star + 1);
    return want.length >= pre.length + post.length && want.startsWith(pre) && want.endsWith(post);
  };
  return Object.keys(exportsField).some(hit);
}

/** `@scope/pkg/sub/path` → { pkg: '@scope/pkg', subpath: './sub/path' } */
function splitSpecifier(name) {
  const parts = name.split('/');
  const take = name.startsWith('@') ? 2 : 1;
  return { pkg: parts.slice(0, take).join('/'), subpath: parts.length > take ? './' + parts.slice(take).join('/') : '' };
}

/** 内置包（app.asar 里的）能不能解析到。 */
function checkInBox(name) {
  const { pkg, subpath } = splitSpecifier(name);
  const manifest = asarFile(`dsh/node_modules/${pkg}/package.json`);
  if (manifest === null && !asarIndex()) return { unknown: true };
  if (manifest === null) return { ok: false, why: `app.asar 里没有这个包 —— 装着的应用是哪个版本？` };
  let json;
  try { json = JSON.parse(manifest.toString('utf8')); } catch { return { ok: false, why: '包里那份 package.json 读不动' }; }
  if (!exportsAllows(json.exports, subpath)) {
    const keys = json.exports && typeof json.exports === 'object' ? Object.keys(json.exports) : [];
    return {
      ok: false,
      why: `子路径 "${subpath}" 不在 exports 里（这一版只有 ${keys.length ? keys.map((k) => `"${k}"`).join('、') : '无 exports'}）\n`
        + `       应用 ${json.version ? json.version + ' ' : ''}挂载到这一行时会抛 ERR_PACKAGE_PATH_NOT_EXPORTED —— 整行不会启动。`
    };
  }
  return { ok: true, note: `${pkg}${subpath.replace(/^\./u, '')}（内置 ${json.version ?? '?'}）` };
}

/**
 * 递归收集所有插件行 —— 包括预设 config.plugins 里的那些。
 *
 * 只在**数组元素**上认行。预设那一行自己长这样：
 *     - id: preset-cyrene
 *       name: '@deepseek-ai/dsh-agent-preset'
 *       config: { id: cyrene, name: 昔涟, plugins: [...] }
 * 它 config 里的 `{ id, name }` 是**预设的名字**，不是插件；按「有 id 和 name
 * 就是一行」去认，会把「昔涟」当成一个包名去解析，然后报一堆假失败。
 * 一个会误报的检查会被关掉，所以宁可窄：插件行永远在数组里，预设的元信息永远不在。
 */
function collectRows(node, out = [], inArray = false) {
  if (Array.isArray(node)) { for (const item of node) collectRows(item, out, true); return out; }
  if (!node || typeof node !== 'object') return out;
  if (inArray && typeof node.id === 'string' && typeof node.name === 'string') {
    out.push({ id: node.id, name: node.name, config: node.config });
  }
  for (const value of Object.values(node)) if (value && typeof value === 'object') collectRows(value, out, false);
  return out;
}

const PSEUDO = /^[a-z][a-z0-9-]*:/u; // cordis:group 这种是宿主自己认的名字，不是包
for (const row of collectRows(patches)) {
  if (PSEUDO.test(row.name)) { ok(`行 ${row.id}`, `${row.name}（宿主内置组名）`); continue; }
  if (IN_BOX.test(row.name)) {
    const res = checkInBox(row.name);
    if (res.ok) ok(`行 ${row.id}`, res.note);
    else if (res.unknown) ok(`行 ${row.id}`, `${row.name}（找不到 app.asar，跳过子路径校验）`);
    else bad(`行 ${row.id}  →  ${row.name}`, res.why);
    // 名字对得上 ≠ 配置还在。这一版把键改名或撤掉时，那一段会被**静默丢掉**：
    // 行照常启动，只是少了一个设置。2026-11-04 就是这样丢了两个键。
    const dead = checkConfigKeys(row);
    if (dead.length > 0) {
      warn(
        `行 ${row.id} 的 config`,
        `${dead.map((k) => `"${k}"`).join('、')} 在 ${splitSpecifier(row.name).pkg} 这一版的源码里找不到`
        + ' —— 可能已改名或被撤掉，这里的设置会被静默忽略。',
      );
    }
    continue;
  }
  try {
    require.resolve(row.name);
    ok(`行 ${row.id}`, `${row.name} → profile`);
  } catch (e) {
    if (existsSync(join(nm, row.name))) { ok(`行 ${row.id}`, `${row.name} → profile（目录）`); continue; }
    bad(`行 ${row.id}  →  ${row.name}`, `profile 里解析不到（${e.code ?? e.message}）—— 挂载会失败`);
  }
}

// ---- 6. 每个我们自己写的插件都能 import 且导出正确 ----------------------
// 只测链接到本地的那些：node_modules 里的第三方包不归我们管，而且它们没有副作用地
// import 未必可行。
//
// ⚠️ 判「是不是我们自己写的」换过两次写法，**两次都错在同一件事上：拿名字去比，
//    而手里那个名字不是名单里那一个。**
//
//   1. 一开始写死三个**裸名** `['cyrene-guard', 'cyrene-agent', 'dsh-theme-cyrene']`。
//      2026-10-12 三个包都加了 `@lutisure/` 作用域（裸名 `cyrene-agent` 在 npm 上
//      被别人占了 1.2.1），这个数组一个都对不上 —— **这一节静悄悄地一个包都不测了**，
//      而它照常打印别的节、照常看起来是健康的。
//   2. 第二版改成从各包 `package.json` 现取 `name` 建名单 —— **仍然对不上**，
//      因为 profile 里依赖的键是 **link 名**（`link:<本仓库>/cyrene-agent`，
//      所以是裸的），跟包自己声明的 `name` 是**两个不同的标识**。
//
// 现在不问名字，问**它实际落在哪**：依赖目录的真身在这个仓库里，就是我们的。
// 包名再改多少次都不影响它。
const REPO_ROOT = realpathSync(fileURLToPath(new URL('..', import.meta.url))).toLowerCase();
const isOurs = (dep) => {
  try {
    return realpathSync(join(nm, dep)).toLowerCase().startsWith(REPO_ROOT);
  } catch {
    return false;
  }
};
const ours = deps.filter(isOurs);
// 这一节出过的那个错**形态就是「安静」**：条件恒 false，循环体一次不跑，
// 于是没有任何一行输出，而整份报告仍然写着「全部通过」。所以「一个都没认出」
// 必须自己喊出来 —— 否则下一次它还会以同样的方式安静地失效。
if (ours.length === 0) {
  bad('插件自检', '一个都没认出是自己写的 —— 判据失效，这一节等于没测');
}
for (const dep of ours) {
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
if (warns > 0) {
  console.log(`  另有 ${warns} 处警告 —— 不拦启动，但多半是过期的配置，值得看一眼。`);
}
if (failures === 0) {
  console.log('  全部通过 —— 这份 profile 可以启动。');
  process.exit(0);
}
console.log(`  ${failures} 处问题 —— 先修再重启，否则会像上次一样起不来。`);
process.exit(1);
