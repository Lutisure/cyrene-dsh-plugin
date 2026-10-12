/**
 * 发布前的安全检查 —— 只看，不改，不联网。
 *
 * ## 查五件事
 *
 *   ① 生命周期脚本：`npm publish` 会跑 `prepare` / `prepublishOnly` / `prepack` 等，
 *      **那是任意代码，而它在 npm 进程里执行（带着 token）。** 装了别人写的依赖时
 *      这是最常见的攻击面；这里是自己的包，所以只要确认**没有意外的脚本**。
 *
 *   ② 包里有没有凭据类文件：`.npmrc` / `.env` / `*.pem` / `*.key` / `id_rsa`。
 *      `~/.npmrc` 就在家目录，**而包的目录在家目录之外** —— 所以照理不会撞上，
 *      但「照理」不是验证。**而如果 `.npmrc` 进了包，那等于把 token 公开发布。**
 *
 *   ③ 私人记忆的原文有没有落进要发的文件里。
 *
 *   ④ 要发的文件清单里有没有意料之外的东西（临时文件、.tgz、node_modules）。
 *
 *   ⑤ 版本号各处写的是不是同一个数：`dsh.plugin.json` 要等于同目录 `package.json`，
 *      根包那三条 dependencies 的范围要容得下子包的**实际**版本。
 *
 * 用法：node tools/check-npm-publish.mjs <仓库根>
 *       node tools/check-npm-publish.mjs <本仓库>
 *
 * ⚠️ 而它只查**静态**的那几样。**`cyrene-agent` 那一条它查不了** ——
 * 那个包的 `dist/` 在磁盘上本来就带着记忆（那是本机那份，对的），
 * 而发布走 `make-npm.mjs`：它**先用空 memory 重建、发完再恢复**。
 * 所以那个包的唯一可信验证是 `make-npm.mjs --pack` 自己那两行检查，
 * 以及发布之后**从 registry 下回来再读一遍**（那是最终判据）。
 *
 * 这份自认「查不了」的话原来只写在注释里，代码却照旧把那一处算成问题 ——
 * 于是每次跑完都是「✗ 有 1 处要处理，先别发」。**一个每次都喊狼来了的检查器，
 * 喊上几回就没人看了**，那正是本文件下面第 92 行自己写的教训。
 * 现在改成：命中的位置若落在 `REBUILT_BEFORE_PUBLISH` 那几处里，
 * 照样**打印**，但标成「已知且已被覆盖」，不计入 problems。
 * 落在别处（比如 dist 之外）仍旧照常拦。
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { memoryContentPattern } from './memory-pattern.mjs';

// 仓库根目录。原来是无条件读 `process.argv[2]` —— 不传参就 `join(undefined, …)`，
// 在第一次真正用到它的地方抛
// `TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string.
// Received undefined`。默认回落到本文件的上两级（本文件在 tools/ 下），
// 参数仍然可以显式覆盖。
const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = process.argv[2] ?? resolve(HERE, '..');
const PACKAGES = ['cyrene-agent', 'cyrene-guard', 'dsh-theme-cyrene', '.'];

/** 会跑的脚本名。`publish` 那一步触发的是前四个。 */
const LIFECYCLE = ['prepublish', 'prepublishOnly', 'prepare', 'prepack', 'postpack', 'publish', 'postpublish'];

/** 凭据类文件名的形状。 */
const SECRET_NAMES = /^(\.npmrc|\.env(\..+)?|\.git-credentials|id_rsa|id_ed25519)$|\.(pem|key|pfx|p12)$/u;

/**
 * 发布流程**自己会重建**的位置（相对包根）。
 *
 * `cyrene-agent` 的 `make-npm.mjs` 在打包前用空 memory 重建 `dist/`、发完再恢复，
 * 所以磁盘上 `dist/` 里带着记忆是**正常状态**，不是问题。
 * 只有这几处算「已知且已被覆盖」；同样一段记忆出现在别的地方，照样拦。
 */
const REBUILT_BEFORE_PUBLISH = { 'cyrene-agent': ['dist'] };

/** 不该出现在要发布的文件里的东西。 */
const UNWANTED = /(__pycache__|\.tgz$|_m\.txt$|_msg\.txt$|\.orig$|\.bak)/u;

// 私人记忆的片段**不在这里写**。
//
// 这里原来是一条写死的正则，装的是本机 `memory.md` 里那两行的**原文** ——
// 而它上面那行注释当时正写着「一个字都不要写全」。这条规矩在
// `audit-shareable.mjs` 里已经栽过一次（那次是抄进了检测器），2026-10-12
// 发现同一处漏被抄了第二遍。现在只有一份实现，现读本机那份生成：
// 见 tools/memory-pattern.mjs —— 那里记着这两次是怎么来的。
const MEMORY_SHAPE = memoryContentPattern();

let problems = 0;
const say = (s) => process.stdout.write(`${s}\n`);

for (const p of PACKAGES) {
  const dir = join(ROOT, p);
  const label = p === '.' ? '（根）' : p;
  if (!existsSync(join(dir, 'package.json'))) {
    say(`  ${label}  **没有 package.json** ✗`);
    problems += 1;
    continue;
  }
  const j = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  say(`  ── ${label}   ${j.name}@${j.version}`);

  // ① 生命周期脚本
  const scripts = j.scripts ?? {};
  const hits = LIFECYCLE.filter((k) => k in scripts);
  if (hits.length > 0) {
    problems += 1;
    for (const k of hits) say(`      ✗ **有生命周期脚本** ${k}: ${scripts[k]}`);
    say('        它会在 npm 进程里执行（带着 token）。**确认它是你要的再发。**');
  } else {
    say('      ✓ 没有生命周期脚本（publish 时不会跑任意代码）');
  }

  // ② 凭据类文件 / ③ 私人记忆 / ④ 意料之外的文件
  //
  // ⚠️ **只扫 npm 真的会打包的那些** —— 也就是 `files` 白名单里的。
  //
  // 第一版扫的是**整个目录**，于是 `deploy/`（本机快照，gitignore 拦着）
  // 和 `tools/` 都被报了「含私人记忆」—— 而它们根本不在 `files` 里，不会进包。
  // **检查器喊狼来了比不检查更坏** —— 喊几次之后没人再看它。
  //
  // 而 `files` 没写的包（默认全发）就退回扫整个目录，那是对的默认。
  const walk = (d) => {
    const out = [];
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = join(d, e.name);
      if (e.isDirectory()) out.push(...walk(full));
      else out.push(full);
    }
    return out;
  };
  const everything = walk(dir);
  const listed = Array.isArray(j.files) && j.files.length > 0 ? j.files : null;
  const files = listed === null
    ? everything
    : everything.filter((f) => {
        const rel = relative(dir, f).replace(/\\/gu, '/');
        // `files` 的每一项要么是目录（以 / 结尾或不带扩展名地指向目录），要么是文件 ——
        // 用「前缀命中或精确命中」两种都认。
        return listed.some((entry) => rel === entry || rel.startsWith(`${entry.replace(/\/$/u, '')}/`));
      });

  if (listed === null) {
    say(`      ⚠️  package.json 没写 \`files\` —— **整目录都会发**，所以按整目录扫`);
  } else {
    say(`      ·  按 \`files\` 白名单扫 ${files.length} 个（目录里共 ${everything.length} 个）`);
  }

  const secrets = files.filter((f) => SECRET_NAMES.test(f.split(/[\\/]/u).pop() ?? ''));
  if (secrets.length > 0) {
    problems += 1;
    for (const f of secrets) say(`      ✗ **凭据类文件** ${relative(ROOT, f)}`);
  } else {
    say(`      ✓ 没有凭据类文件（扫了 ${files.length} 个）`);
  }

  const withMemory = files.filter((f) => {
    try {
      if (statSync(f).size > 4 * 1024 * 1024) return false;
      return MEMORY_SHAPE.test(readFileSync(f, 'utf8'));
    } catch {
      return false;
    }
  });
  const covered = REBUILT_BEFORE_PUBLISH[p] ?? [];
  const isCovered = (f) => {
    const rel = relative(dir, f).replace(/\\/gu, '/');
    return covered.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
  };
  const coveredHits = withMemory.filter(isCovered);
  const realHits = withMemory.filter((f) => !isCovered(f));

  if (realHits.length > 0) {
    problems += 1;
    for (const f of realHits) say(`      ✗ **含私人记忆** ${relative(ROOT, f)}`);
  } else if (coveredHits.length === 0) {
    say('      ✓ 没有私人记忆的原文');
  } else {
    say(`      ✓ 没有私人记忆的原文（除下列 ${coveredHits.length} 处，它们在打包前会被重建）`);
  }
  for (const f of coveredHits) {
    say(`      ℹ️  已知且已被覆盖 ${relative(ROOT, f)}`);
    say('         发布走 `make-npm.mjs`：它先用空 memory 重建这里，发完再恢复。');
  }

  const unwanted = files.filter((f) => UNWANTED.test(relative(ROOT, f)));
  if (unwanted.length > 0) {
    for (const f of unwanted) say(`      ⚠️  意料之外： ${relative(ROOT, f)}`);
  } else {
    say('      ✓ 没有临时文件、tgz、备份残留');
  }
  // ⑤ 版本号在几个地方各写了一遍，没有东西保证它们相等
  //
  // `dsh.plugin.json` 带一份 version，`package.json` 带一份。手改一处就漂了，
  // 而漂了之后注册表读到的版本和实际发出去的包不是同一个数。
  const manifestPath = join(dir, 'dsh.plugin.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.version !== j.version) {
      problems += 1;
      say(`      ✗ **版本对不上** dsh.plugin.json 写 ${manifest.version}，package.json 写 ${j.version}`);
    } else {
      say(`      ✓ 版本和 dsh.plugin.json 一致（${j.version}）`);
    }
  }

  say('');
}

// ── 跨包：根包那三条依赖范围要容得下子包**实际**的版本 ────────────────
//
// 根包靠这三条 dependencies 把子包拉进来。范围写窄了，或者升版本时只改了子包
// 忘了改根，结果是「本地好好的、装下来是旧的」。
//
// 这里只认 `^X.Y.Z` 这一种写法。别的写法要完整的 semver 求值器才算得准 ——
// **不做比自己能力更多的事**：认不出来就明说这条查不了，而不是假装验过。
{
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const deps = rootPkg.dependencies ?? {};
  const num = (v) => v.split('.').map(Number);
  const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
  const lines = [];

  for (const p of PACKAGES.filter((x) => x !== '.')) {
    const sub = JSON.parse(readFileSync(join(ROOT, p, 'package.json'), 'utf8'));
    const range = deps[sub.name];
    if (range === undefined) {
      problems += 1;
      lines.push(`      ✗ **根包没有依赖它** ${sub.name} —— 装上了也不会启动`);
      continue;
    }
    const m = /^\^(\d+)\.(\d+)\.(\d+)$/u.exec(range.trim());
    if (m === null) {
      lines.push(`      ·  ${sub.name} 的范围是 \`${range}\` —— 不是 ^X.Y.Z 的写法，这条查不了`);
      continue;
    }
    const low = [Number(m[1]), Number(m[2]), Number(m[3])];
    const high = [Number(m[1]) + 1, 0, 0];
    const actual = num(sub.version);
    if (cmp(actual, low) < 0 || cmp(actual, high) >= 0) {
      problems += 1;
      lines.push(`      ✗ **范围容不下** ${sub.name}@${sub.version} 不在 ${range} 里`);
    } else {
      lines.push(`      ✓ ${sub.name} ${range} 容得下 ${sub.version}`);
    }
  }

  say('  ── 根包的依赖范围');
  for (const l of lines) say(l);
  say('');
}

say(problems === 0 ? '  ✓ 五项全过 —— 可以发。\n' : `  ✗ 有 ${problems} 处要处理 —— **先别发**。\n`);
process.exit(problems === 0 ? 0 : 1);
