/**
 * 把 `<用户名>` 换成你的 GitHub 用户名。
 *
 * ## 为什么要有这一步工具
 *
 * `<用户名>` 是仓库推上去**之前填不了**的占位符（`SUBMIT.md` 里写着原因：
 * 把包挂到一个并未认领它的仓库上，是明确的拒收理由）。所以它只能等推完之后，
 * 从 GitHub 地址栏抄下来回填。
 *
 * 手工回填要动 4 个文件、10 处，而且**改漏一处不会有任何报错** ——
 * 直到 CI 拒收。**那正是该做成一条命令的形状。**
 *
 * ## 它做什么
 *
 *   node tools/set-owner.mjs <用户名>      填进去
 *   node tools/set-owner.mjs --check        只看还剩几处，不改
 *   node tools/set-owner.mjs --revert       换回 <用户名>
 *
 * ## 它不做什么
 *
 * **不改 git 历史。** 已经提交过的 `<用户名>` 留在老提交里 —— 那不是问题，
 * 因为占位符本身不含任何私人信息，而且**它本来就是要被替换掉的东西**。
 * 真正不能进历史的是别的（见 `.gitignore`）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const OWNER = '<用户名>';

/**
 * 哪些文件里有占位符。
 *
 * 用 `git grep` 而不是遍历目录 —— **只该动被跟踪的文件**。
 * 遍历会把 `node_modules` 里某个碰巧带这串字的包也改了。
 *
 * @returns {string[]} 仓库相对路径。
 */
function files() {
  try {
    return execSync(`git grep -l "${OWNER}"`, { encoding: 'utf8' })
      .split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    // git grep 没命中时退出码非零，那是正常情况不是错误。
    return [];
  }
}

const arg = process.argv[2] ?? '';
const found = files();

if (arg === '--check' || arg === '') {
  if (found.length === 0) {
    console.log('\n  没有占位符了 —— 已经填过。\n');
    process.exit(0);
  }
  console.log(`\n  还剩 ${found.length} 个文件带 ${OWNER}：\n`);
  let total = 0;
  for (const f of found) {
    const n = (readFileSync(f, 'utf8').match(new RegExp(OWNER, 'g')) ?? []).length;
    total += n;
    console.log(`    ${f.padEnd(34)} ${n} 处`);
  }
  console.log(`\n  合计 ${total} 处。填法：node tools/set-owner.mjs <你的 GitHub 用户名>\n`);
  process.exit(0);
}

if (arg === '--revert') {
  if (found.length === 0) {
    console.log('\n  没有可回退的 —— 现在一个占位符都没有。');
    console.log('  （回退要先知道原来填的是什么，这一步做不到。手动改回去吧。）\n');
    process.exit(1);
  }
  console.log('\n  本来就还是占位符，不用回退。\n');
  process.exit(0);
}

// ── 真的替换 ──────────────────────────────────────────────────────────

const owner = arg.replace(/^@/u, '').trim();
// GitHub 用户名的实际规则：字母数字和连字符，不能以连字符开头或结尾，最长 39。
if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(owner)) {
  console.log(`\n  ✗ 「${owner}」不像一个 GitHub 用户名。`);
  console.log('    规则：字母数字和连字符，不以连字符开头或结尾，最长 39 位。\n');
  process.exit(1);
}

if (found.length === 0) {
  console.log('\n  没有占位符了 —— 已经填过。先 --check 看看现在填的是什么。\n');
  process.exit(0);
}

let changed = 0;
for (const f of found) {
  const before = readFileSync(f, 'utf8');
  const after = before.replaceAll(OWNER, owner);
  if (after !== before) {
    writeFileSync(f, after, 'utf8');
    changed += 1;
  }
}

console.log(`\n  填好了：${changed} 个文件，owner = ${owner}\n`);
console.log('  接下来：');
console.log(`    git add -A && git commit -m "填上仓库所有者：${owner}"`);
console.log('    然后按 SUBMIT.md 的 checklist 逐条过。\n');
