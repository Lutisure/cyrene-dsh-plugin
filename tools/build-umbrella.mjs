#!/usr/bin/env node
/**
 * Derive the umbrella package's patch from the agent's own patch.
 *
 * ## Why this exists
 *
 * The wrapper that made this package worth publishing was never enough on its
 * own. It loaded three plugins; it declared no presets. So somebody who
 * installed this from npm got a theme, a scanner, and an agent they could not
 * select in a new session — the presets only ever reached machines that ran
 * `setup/install.ps1`, and that script is not in the distributed copy. The
 * marketplace entry pointed at this package, so the gap sat on the main path.
 *
 * The two preset declarations therefore live in `cyrene-agent`'s build, and this
 * script forwards them. Forwarding rather than copying is the whole point: a
 * second hand-maintained copy would drift, and the drift would show up as a
 * preset that loads on one machine and not another.
 *
 * ## The one difference between the two carriers
 *
 * `cyrene-agent/dist/cordis.patch.yml` names its plugin rows `cyrene-agent/...`,
 * because the machines that read it link the package under that bare directory
 * name. An npm install puts it at `@lutisure/cyrene-agent`, so a row spelled
 * the bare way resolves there to nothing. This script rewrites exactly those
 * `name:` lines and nothing else.
 *
 * Usage:
 *   node tools/build-umbrella.mjs           write cordis.patch.yml
 *   node tools/build-umbrella.mjs --check   exit 1 if the file on disk is stale
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReport, parsePatch, validatePatchYaml } from '../cyrene-agent/build.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'cyrene-agent', 'dist', 'cordis.patch.yml');
const OUT = join(ROOT, 'cordis.patch.yml');
const PKG = join(ROOT, 'package.json');

/** The scope every package in this repo publishes under. */
const SCOPE = '@lutisure/';

/**
 * The rows this package loads, in the order they should start.
 *
 * `id` is the loader's name for the entry and `pkg` is the npm name — they are
 * two different things, and the theme is the case where they disagree. The
 * theme calls itself `dsh-theme-cyrene` but is loaded as `ui-theme-cyrene`;
 * that was fixed in its own patch and is copied here rather than invented.
 */
const LOAD_ROWS = [
  { id: 'cyrene-agent', pkg: `${SCOPE}cyrene-agent` },
  { id: 'cyrene-guard', pkg: `${SCOPE}cyrene-guard` },
  { id: 'ui-theme-cyrene', pkg: `${SCOPE}dsh-theme-cyrene` }
];

/** The presets this file must end up carrying, in order. */
const EXPECTED_PRESETS = [
  { row: 'preset-cyrene', id: 'cyrene' },
  { row: 'preset-cyrene-dev', id: 'cyrene-dev' }
];

const BANNER = `# cyrene-dsh-plugin — 整合包的 bundle 补丁
#
# ⚙️ 由 tools/build-umbrella.mjs 生成，两个预设那两段转发自
# cyrene-agent/dist/cordis.patch.yml。改预设请改 cyrene-agent 那边的源，
# 再跑一遍这个脚本；手改这里会在下次生成时丢掉。
#   node tools/build-umbrella.mjs          重新生成
#   node tools/build-umbrella.mjs --check  查这份是不是过期的
#
# ## 这一份和三个子包各自那份的关系
#
# 三个子包各带一份 patch，各挂自己那一行：
#
#     cyrene-agent/cordis.patch.yml        insert: id cyrene-agent    name 'cyrene-agent'
#     cyrene-guard/cordis.patch.yml        insert: id cyrene-guard    name 'cyrene-guard'
#     dsh-theme-cyrene/cordis.patch.yml    insert: id ui-theme-cyrene name 'dsh-theme-cyrene'
#
# **这一份把三行写在一处。** 那就是这个包自己做的事 —— 插件市场对聚合包的规则是
# 「收插件，不收聚合包」，而列出的三种够格行为里第一种就是**合成配置**：
#
#     内容只有一份依赖清单的包不单独收录。
#     而如果它自己做事（合成配置、提供设置界面、在运行时协调各部分），
#     那它就是个插件，按普通标准审。
#
# 装这一个 = 三行一起进 loader。**而三个子包各自那份仍然有效** —— 它们只在
# 有人单独装那个子包时才被读到，所以留着不会冲突，只是「三条各自可装」那条路
# 仍然在（市场里不再单独立条目，但包本身照旧装得上）。
#
# ## 四件事要说清
#
# 1. **三行载入行保持纯 \`insert(id/name)\` 形式。** 这是可热挂载的。三个子包那份
#    的注释里写着同一条，理由也相同。两个预设行带 \`config:\` —— 那个插件的
#    config 就是它的全部内容，没有 config 的行等于没声明。
#
# 2. **不要在这里写任何机器相关的路径。** patch 里的硬编码路径在别人机器上必然
#    指向不存在的目录，插件会直接起不来。
#
# 3. **\`name\` 写的是包的 npm 名，而 \`id\` 是 loader 里的标识。**
#    主题那一行的 id 是 \`ui-theme-cyrene\` 而不是 \`dsh-theme-cyrene\` ——
#    那是 \`dsh-theme-cyrene/cordis.patch.yml\` 里定下的，这里照抄，不要改。
#
# 4. **预设里那七行 \`@lutisure/cyrene-agent/...\` 不能写回裸名。**
#    上游那份（\`cyrene-agent/dist/cordis.patch.yml\`）写的是 \`cyrene-agent/worldbook\`，
#    在**作者的机器上**解析得到 —— 那里这个包是以裸目录名 link 进去的。
#    npm 装的人没有那个目录，只有 \`@lutisure/cyrene-agent\`，裸名解析到空。
#    这个脚本负责逐行改写，别再手写一遍。
#
# ## 而三行的顺序
#
# 按「谁先能跑起来」排：agent 提供 systemPrompt（guard 与主题都间接依赖它），
# guard 挂在 fs/observed 上，主题最后（它是客户端那一侧，读 ui-theme 槽位）。
#
# ⚠️ 而 loader 对 insert 顺序**并不做依赖排序** —— 这个顺序只是为了日志好读，
# 不是正确性所必需的。真正的依赖由每个包自己的 \`inject\` 声明决定。
#
# ⚠️ 2026-10-12：三个 \`name\` 都加了 \`@lutisure/\` 作用域 —— 因为裸名 \`cyrene-agent\`
# 在 npm 上已经被人占了，而 \`name\` 是**包的去处**，必须和 registry 上的一致。
# 三个 \`id\` **都没动**：它们是 loader 里的标识，不是 npm 名。
#
# ## 下面两段：预设声明
#
# 上面三行只是把插件挂起来。**挂起来不等于能选** —— 新建会话里那个下拉列的是
# 「预设」，而预设是 \`@deepseek-ai/dsh-agent-preset\` 的声明行，得有人写。
# \`setup/install.ps1\` 会往 profile 补丁里写一份，但那份脚本不随分享副本分发，
# 所以从 npm 装的人从来没有过预设。这两段就是补上那一块。
#
# 行 id（\`preset-cyrene\` / \`preset-cyrene-dev\`）是 loader 的定址方式；
# 预设身份是 config.id（\`cyrene\` / \`cyrene-dev\`），会话存的是后者。
#
# 两条预设：\`昔涟\` 是给她用的（整段系统提示词就是人设，只留联网检索），
# \`昔涟（研发）\` 是调试她本人用的夹具（保留 harness 身份与全套工具）。
#
# ## 和本机那份撞车怎么办 —— 不用办
#
# \`setup/install.ps1\` 会把同样两条预设写进 profile 自己的 \`cordis.patch.yml\`。
# 那样的机器上再装这个包，合成出来的列表里会有**四行**，两两同 id。
#
# 这无害。挂载时 loader 按行 id 收成字典（\`Object.fromEntries\`），同 id 的两行
# 塌缩成一行，**后面那行赢**。层序是 bundle 在前、profile 与 home 补丁在后，
# 所以本机原来那份赢、这个包那份静默让位 —— 全程只有一个人去注册那个
# \`config.id\`，不会撞上下面这条硬规则。
#
# ⚠️ 而这个性质**只在行 id 相同时成立**，别把它推广。行 id 撞车是静默换配置；
# \`config.id\` 撞车是硬错误（registry 里 \`Duplicate agent preset: <id>\`）——
# 先注册的活下来，后到的那一行激活失败，启动照常、那个预设从此选不了，而且
# 只在 stderr 留一句。所以上面两个行 id 必须和 install.ps1 写的、以及上游
# dist 里那两条**一字不差**。
`;

/**
 * Rewrite the bare package names the agent's carrier uses into their npm names.
 *
 * Line-level on purpose: the surrounding comments explain the rows and are worth
 * keeping, and re-serialising the YAML would throw all of them away. Both
 * spellings have to be handled — the generated preset quotes its values and the
 * hand-written dev preset does not — and an earlier version of this function
 * matched only the quoted form, so it silently skipped four rows and then
 * reported zero problems, because the check used the same narrow pattern.
 *
 * @param {string} body - the preset entries, already stripped of file comments.
 * @returns {{text: string, rewritten: number, leftover: number}} the result.
 */
function scopePluginNames(body) {
  let rewritten = 0;
  const text = body
    .split('\n')
    .map((line) => {
      const match = /^(\s*name: )'?(cyrene-agent\/[^\s'"]+)'?\s*$/u.exec(line);
      if (match === null) return line;
      rewritten += 1;
      return `${match[1]}'${SCOPE}${match[2]}'`;
    })
    .join('\n');
  const leftover = text.split('\n').filter((line) => /^\s*name: '?cyrene-agent\//u.test(line)).length;
  return { text, rewritten, leftover };
}

/**
 * Take the preset entries out of the agent's patch and drop the comments that
 * belong to that carrier.
 *
 * That file explains how to install itself with `sync-desktop-patch.mjs` and
 * where `dist/system-prompt.md` is read from. None of that is true for somebody
 * who installed this package from npm, and a patch that describes a route the
 * reader does not have is worse than one that says nothing. Indented comments
 * survive: those explain the rows.
 *
 * @param {string} dist - the agent's patch text.
 * @returns {string} the entries, with a blank line between them.
 */
function presetEntries(dist) {
  return dist
    .split('\n')
    .filter((line) => !/^#/u.test(line))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/**
 * Read one key out of a JSON file, or undefined if the file is missing.
 *
 * @param {string} path - the file.
 * @param {string} key - the key to pull.
 * @returns {any} the value.
 */
function readJsonKey(path, key) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))[key];
  } catch {
    return undefined;
  }
}

/**
 * Does a plain `^` / `~` / exact range accept this version?
 *
 * Deliberately small. This repo writes three forms and nothing else, and half a
 * semver is worse than none — anything else comes back as `null`, which the
 * caller reads as "cannot tell, a person should look". `^0.2` meaning "same
 * minor" is the one case that is easy to get wrong and is handled explicitly.
 *
 * @param {string} range - the dependency range, e.g. `^0.17.0`.
 * @param {string} version - the version being depended on.
 * @returns {boolean|null} true/false, or null for a form this cannot read.
 */
function rangeAccepts(range, version) {
  const r = /^([\^~]?)(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  const v = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version).trim());
  if (!r || !v) return null;

  const op = r[1];
  const base = [Number(r[2]), Number(r[3]), Number(r[4])];
  const got = [Number(v[1]), Number(v[2]), Number(v[3])];

  if (op === '') return got.join('.') === base.join('.');
  if (op === '~') {
    return got[0] === base[0] && got[1] === base[1] && got[2] >= base[2];
  }
  if (got[0] !== base[0]) return false;
  if (base[0] > 0) {
    const cmp = (got[0] - base[0]) || (got[1] - base[1]) || (got[2] - base[2]);
    return cmp >= 0;
  }
  return got[1] === base[1] && got[2] >= base[2];
}

/**
 * Cross-check the loader rows against the package's own dependencies, and the
 * three places a version number is written down.
 *
 * The three rows and the three dependency entries have to name the same
 * packages; a dependency added without a row (or the reverse) is a package that
 * installs and never starts, which looks like nothing at all from the outside.
 *
 * Each package also carries its version twice (`package.json` and
 * `dsh.plugin.json`), and the root's dependency range is a third opinion about
 * it. npm has no opinion on whether the two manifests agree, and the market
 * reads one while dsh reads the other — so a bump that touches one file and not
 * the other ships something no check would have caught.
 *
 * @param {object} report - the collector.
 */
function checkDependencies(report) {
  const manifest = JSON.parse(readFileSync(PKG, 'utf8'));
  const declared = manifest.dependencies ?? {};
  for (const row of LOAD_ROWS) {
    if (declared[row.pkg] === undefined) {
      report.problems.push(`package.json has no dependency on ${row.pkg}, but the patch loads it`);
    }
  }
  for (const name of Object.keys(declared)) {
    if (!LOAD_ROWS.some((row) => row.pkg === name)) {
      report.problems.push(`package.json depends on ${name}, but the patch never loads it`);
    }
  }

  for (const row of LOAD_ROWS) {
    const dir = row.pkg.slice(SCOPE.length);
    const inPackage = readJsonKey(join(ROOT, dir, 'package.json'), 'version');
    const inPlugin = readJsonKey(join(ROOT, dir, 'dsh.plugin.json'), 'version');
    if (inPackage === undefined || inPlugin === undefined) {
      report.problems.push(`${dir}: 少一份清单（package.json ${inPackage} / dsh.plugin.json ${inPlugin}）`);
      continue;
    }
    if (inPackage !== inPlugin) {
      report.problems.push(
        `${dir}: 版本号写了两处却不一致 —— package.json 是 ${inPackage}，dsh.plugin.json 是 ${inPlugin}`
      );
    }
    const range = declared[row.pkg];
    if (rangeAccepts(range, inPackage) === false) {
      report.problems.push(
        `package.json 里 ${row.pkg} 写的是 ${range}，而它的实际版本是 ${inPackage} —— 这个范围不接受它`
      );
    }
  }
}

/**
 * Collect every plugin `name` in a row's `config.plugins`, however deeply the
 * groups nest.
 *
 * @param {any} row - a preset row.
 * @returns {string[]} the names.
 */
function pluginNames(row) {
  const found = [];
  const walk = (list) => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (typeof entry?.name === 'string') found.push(entry.name);
      // A `cordis:group` row carries its children as its config; a leaf row's
      // config is an object and the walk stops there.
      walk(entry?.config);
    }
  };
  walk(row?.config?.plugins);
  return found;
}

/**
 * Assert the presets actually landed, by structure rather than by text.
 *
 * `validatePatchYaml` checks that each preset row is well-formed; this checks
 * that the right ones are here, in order, carrying the identities sessions save
 * and naming packages that exist on the machine that will read this. A missing
 * preset is not a crash — it is an empty dropdown on somebody else's machine,
 * which is the exact bug this file exists to fix.
 *
 * @param {any} parsed - the parsed patch document.
 * @param {object} report - the collector.
 */
function checkPresets(parsed, report) {
  if (!Array.isArray(parsed)) {
    report.problems.push('生成结果不是一个顶层列表');
    return;
  }
  const rows = parsed
    .flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : []))
    .filter((row) => row?.name === '@deepseek-ai/dsh-agent-preset');

  if (rows.length !== EXPECTED_PRESETS.length) {
    report.problems.push(`预设行 ${rows.length} 条，应该是 ${EXPECTED_PRESETS.length} 条`);
    return;
  }
  rows.forEach((row, index) => {
    const want = EXPECTED_PRESETS[index];
    if (row.id !== want.row) {
      report.problems.push(`第 ${index + 1} 条预设的行 id 是 ${String(row.id)}，应该是 ${want.row}`);
    }
    // The row id addresses the loader entry; config.id is what a session saves.
    // Getting those two swapped produces a preset that loads and cannot be
    // selected twice, which is a confusing half-failure.
    if (row.config?.id !== want.id) {
      report.problems.push(`第 ${index + 1} 条预设的 config.id 是 ${String(row.config?.id)}，应该是 ${want.id}`);
    }
    // Every row that names this repo's own package has to name it the way npm
    // does. Left in the bare form it resolves on the maintainer's machine —
    // where the package is linked under that directory name — and nowhere else.
    for (const name of pluginNames(row)) {
      if (name.includes('cyrene-agent/') && !name.startsWith(SCOPE)) {
        report.problems.push(`第 ${index + 1} 条预设里 ${name} 还是裸名，npm 装的人解析不到`);
      }
    }
  });
}

function render() {
  const report = createReport();
  const dist = readFileSync(DIST, 'utf8');
  const { text: body, rewritten, leftover } = scopePluginNames(presetEntries(dist));

  if (rewritten === 0) {
    report.problems.push(`${DIST} 里一个 cyrene-agent/ 的 name 都没找到 —— 预设那几行是不是被改掉了？`);
  }
  if (leftover !== 0) {
    report.problems.push(`还有 ${leftover} 行 name 留在裸名下，npm 装的人解析不到`);
  }

  const loads = LOAD_ROWS.map((row) => `    - id: ${row.id}\n      name: '${row.pkg}'`).join('\n');
  const text = `${BANNER}\n- insert:\n${loads}\n\n${body}\n`;

  checkDependencies(report);
  validatePatchYaml(text, report);
  try {
    checkPresets(parsePatch(text), report);
  } catch {
    // 解析失败时 validatePatchYaml 已经报过一次，这里不重复。
  }

  return { text, report };
}

function main() {
  const check = process.argv.includes('--check');
  const { text, report } = render();

  for (const problem of report.problems) process.stdout.write(`  error    ${problem}\n`);
  if (report.problems.length > 0) {
    process.exitCode = 1;
    return;
  }

  if (check) {
    let current = '';
    try {
      current = readFileSync(OUT, 'utf8');
    } catch {
      process.stdout.write('  error    cordis.patch.yml 不存在\n');
      process.exitCode = 1;
      return;
    }
    if (current !== text) {
      process.stdout.write('  error    cordis.patch.yml 和生成结果不一致，跑 node tools/build-umbrella.mjs 重新生成\n');
      process.exitCode = 1;
      return;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    process.stdout.write(`校验通过：cordis.patch.yml ${bytes} 字节，${EXPECTED_PRESETS.length} 个预设\n`);
    return;
  }

  writeFileSync(OUT, text, 'utf8');
  // `text.length` counts UTF-16 units — 14203 for a file that occupies 16471
  // bytes on disk, because the banner is Chinese. Reported 字节 while printing a
  // character count, which is the kind of wrong number somebody later quotes.
  process.stdout.write(`写出 cordis.patch.yml：${Buffer.byteLength(text, 'utf8')} 字节\n`);
  process.stdout.write(`  载入行  ${LOAD_ROWS.map((row) => row.id).join(' / ')}\n`);
  process.stdout.write(`  预设行  ${EXPECTED_PRESETS.map((preset) => preset.row).join(' / ')}\n`);
}

main();
