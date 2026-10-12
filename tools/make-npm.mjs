/**
 * 打一份可以发 npm 的包。
 *
 * ## 它解决的那件事
 *
 * `make-share.mjs` 给朋友的副本是干净的 —— 它**排除** `dist/`。
 *
 * **但 `npm publish` 不看那张排除表，它看 `package.json` 的 `files`。**
 * 而 `cyrene-agent/package.json` 的 `files` 里有 `dist/`，于是 npm 会发出去这个：
 *
 *     dist/skills/cyrene/SKILL.md
 *
 * ⚠️ **那里面带着使用者私人记忆的原文**（`build.mjs` 把 `memory.md` 内联进了 SKILL.md）。
 * **具体内容不复述** —— 一个「防止记忆外泄」的脚本自己抄着那段话，是这类事里最容易犯的错：
 * `audit-shareable.mjs` 和这个文件都犯过一次，2026-10-12 才发现（它们当时已经推上 GitHub）。
 *
 * 原因：`build.mjs` 构建时把 `memory.md` 和 `corrections.md` **内联进 SKILL.md**。
 *
 * ## 为什么不能「不发 dist、让使用者自己 build」
 *
 * 这个包的运行时**要读 `dist/`**：`persona.mjs` 读 `dist/system-prompt.md`、
 * `worldbook.mjs` 读 `dist/worldbook.json`。不发 `dist/`，装完就是坏的。
 *
 * ## 所以：**用空的 memory 重建一份 dist**
 *
 * `build.mjs` 里那两个读取函数都听 `DSH_HOME`：
 *
 *     const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
 *     const file = join(home, 'cyrene-agent', 'memory.md');
 *
 * 所以把 `DSH_HOME` 指到一个临时目录，里面放**空的 memory.md** 和
 * **照抄的 corrections.md**，重建出来的 `dist/` 里就只有规则、没有记忆。
 *
 * `corrections.md` 保留是**他 2026-10-11 明确说的**：
 * 「corrections 内的数据其实可以保留，只是 memory 要根据每一个不同的宿主来记录」。
 *
 * ## 它会动你本机的 dist
 *
 * 构建写的是同一个 `dist/`。所以脚本**先备份、用完再恢复** ——
 * 恢复的是本机那份（带你自己记忆的），发出去的只是临时构建的那份。
 *
 * 用法：
 *   node tools/make-npm.mjs              # 只构建并检查，不发
 *   node tools/make-npm.mjs --pack       # 构建 + 打包成 .tgz
 *   node tools/make-npm.mjs --publish    # 构建 + 真正 npm publish
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// ---- 仓库根，从本文件的位置推（由 tools/derive-roots.mjs 加的头）----
//
// 以前这里写的是作者机器上的绝对路径。那只在那台机器上成立，
// 而且清洗脚本会把绝对路径换成占位符，于是代码里出现 <本仓库> 这种目录名，直接崩。
import { fileURLToPath as __f } from 'node:url';
import { dirname as __d, join as __j } from 'node:path';
const REPO_ROOT = __j(__d(__f(import.meta.url)), '..');

const ROOT = `${REPO_ROOT}/cyrene-agent`;
const REAL_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const REAL_MEMORY = join(REAL_HOME, 'cyrene-agent', 'memory.md');
const REAL_CORRECTIONS = join(REAL_HOME, 'cyrene-agent', 'corrections.md');
const DIST = join(ROOT, 'dist');

const argv = process.argv.slice(2);
const doPack = argv.includes('--pack') || argv.includes('--publish');
const doPublish = argv.includes('--publish');

// ── 一、临时 home：memory 空、corrections 照抄 ─────────────────────────

const staging = mkdtempSync(join(tmpdir(), 'cyrene-npm-'));
const fakeHome = join(staging, 'home');
writeFileSync(join(staging, 'placeholder'), '', 'utf8');
cpSync(REAL_HOME, fakeHome, {
  recursive: true,
  filter: (src) => !src.includes('node_modules')
});
// memory 清空 —— 这一步就是整个脚本存在的理由。
const fakeMemory = join(fakeHome, 'cyrene-agent', 'memory.md');
writeFileSync(fakeMemory, '', 'utf8');

const realMemoryBytes = existsSync(REAL_MEMORY) ? readFileSync(REAL_MEMORY, 'utf8').trim().length : 0;
const realCorrectionsBytes = existsSync(REAL_CORRECTIONS) ? readFileSync(REAL_CORRECTIONS, 'utf8').trim().length : 0;
console.log(`\n  本机 memory      ${realMemoryBytes} 字符   →  临时 home 里清空`);
console.log(`  本机 corrections  ${realCorrectionsBytes} 字符   →  **保留**（他明说的）`);

// ── 二、备份本机 dist，然后用干净的 home 重建 ─────────────────────────

const backup = join(staging, 'dist-backup');
let hadDist = false;
if (existsSync(DIST)) {
  cpSync(DIST, backup, { recursive: true });
  hadDist = true;
  console.log(`\n  备份本机 dist → 临时目录（${readdirSync(DIST).length} 项）`);
}

const restore = () => {
  try {
    if (hadDist) {
      rmSync(DIST, { recursive: true, force: true });
      cpSync(backup, DIST, { recursive: true });
    }
  } catch (error) {
    console.log(`  ⚠️ 恢复 dist 失败：${error.message} —— **本机那份要手动重建**`);
  }
};

console.log('\n  用空的 memory 重建 dist……');
const built = spawnSync(process.execPath, [join(ROOT, 'build.mjs')], {
  cwd: ROOT,
  env: { ...process.env, DSH_HOME: fakeHome },
  encoding: 'utf8'
});
if (built.status !== 0) {
  console.log(`  ✗ 构建失败：\n${built.stderr ?? ''}`);
  restore();
  rmSync(staging, { recursive: true, force: true });
  process.exit(1);
}

// ── 三、验**构建产物**，不是验源目录 ─────────────────────────────────
//
// 和 make-share.mjs 同一条纪律：验源只能证明「我知道什么该排除」，
// 验产物才能证明「我真的排除了」。
//
// ⚠️ **第一版这里是错的**：我调了 `audit-shareable.mjs` 并把它 cwd 设成仓库根，
// 于是它扫了**整个仓库 5926 个文件**（那里当然有 90 多处：deploy/、游戏素材……），
// 而不是我刚刚构建的那份 dist。**它报的是「仓库有 97 处」，不是「产物有泄漏」。**
//
// 判据本来可以很直接：临时 home 里 **memory.md 是空的**，所以构建出来的
// SKILL.md 里**根本不该出现「【你对对方的长期记忆」那一段**。而 corrections 该在。

const skillFile = join(DIST, 'skills', 'cyrene', 'SKILL.md');
const skill = existsSync(skillFile) ? readFileSync(skillFile, 'utf8') : '';
const hasMemory = skill.includes('【你对对方的长期记忆');
const hasCorrections = skill.includes('【你对说话方式的修正');
const hasPersona = skill.length > 5000;

console.log(`\n  构建产物 dist/skills/cyrene/SKILL.md   ${skill.length} 字符`);
console.log(`    「长期记忆」那一段      ${hasMemory ? '**在 ← 泄漏**' : '不在 ✓'}`);
console.log(`    「说话方式修正」那一段    ${hasCorrections ? '在 ✓（他明说要保留）' : '不在 ← 丢了'}`);
console.log(`    人设正文               ${hasPersona ? '在 ✓' : '不在 ← 产物是坏的'}`);

console.log('');
if (hasMemory) {
  console.log('  ✗ **构建产物里还有私人记忆 —— 不能发。**');
  restore();
  rmSync(staging, { recursive: true, force: true });
  process.exit(1);
}
if (!hasCorrections || !hasPersona) {
  console.log('  ✗ **产物不完整** —— 不该发的没了，但该发的也没了。');
  restore();
  rmSync(staging, { recursive: true, force: true });
  process.exit(1);
}
console.log('  ✓ 产物干净且完整：只有规则，没有记忆。');

// ── 四、打包 / 发布 ───────────────────────────────────────────────────

if (doPack) {
  console.log('\n  打包……');
  const packed = spawnSync('npm', ['pack', '--dry-run'], { cwd: ROOT, encoding: 'utf8', shell: true });
  const out = `${packed.stdout ?? ''}${packed.stderr ?? ''}`;
  const list = (out.match(/npm notice.*\n/g) ?? []).slice(0, 6);
  console.log(list.map((l) => `    ${l.trim()}`).join('\n'));
  const bad = /SKILL\.md/.test(out) && /memory|人家做成了/.test(readFileSync(join(DIST, 'skills', 'cyrene', 'SKILL.md'), 'utf8'));
  console.log(bad ? '    ✗ SKILL.md 里仍有记忆' : '    ✓ 包里那份 SKILL.md 是干净的');
}

if (doPublish) {
  console.log('\n  ⚠️ 真正 publish 这一步**留给人按** —— 见 SUBMIT.md。');
  console.log('     命令：cd cyrene-agent && npm publish --access public');
}

restore();
rmSync(staging, { recursive: true, force: true });
console.log('\n  本机 dist 已恢复。\n');
