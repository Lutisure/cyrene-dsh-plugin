/**
 * 把 `DSH_Plugins`（这个仓库在 GitHub 上的名字）换成另一个。
 *
 * ## 为什么要有这一步工具
 *
 * 仓库改名的成本不在 GitHub 那一下 —— 点两下就完事。
 * **成本在于仓库名写死在十九个地方**，而且分两种形状：
 *
 *     https://github.com/Lutisure/DSH_Plugins/tree/main/cyrene-agent   ← 十六处
 *     Lutisure__DSH_Plugins--cyrene-agent.yml                          ← 三处（投稿文件名）
 *
 * 手工改要动四个文件、十九处，**改漏一处不会有任何报错** ——
 * 直到别人点那个链接、或者投稿的 CI 报「仓库不存在」。
 * **那正是该做成一条命令的形状**（和 `set-owner.mjs` 同一个理由）。
 *
 * ## ⚠️ 而它**不能**改什么
 *
 * `DSH_Plugins` 在这仓库里是**两个意思**：
 *
 *   **仓库名**      `github.com/Lutisure/DSH_Plugins`      → 该改
 *   **本机目录名**   `<本仓库>\...`                   → **绝对不能改**
 *
 * 后面那种有四十多处（`setup/`、`tools/`、若干 README），讲的是
 * 「东西在这台机器的哪个盘上」。**一刀切替换会把它们全改成一个不存在的目录**，
 * 而照做的人会在 install 那一步找不到路径。
 *
 * 所以下面的规则**只匹配 URL 里那个位置**，不匹配裸的 `DSH_Plugins`。
 *
 * ## 用法
 *
 *     node tools/set-repo.mjs <新仓库名>     改过去
 *     node tools/set-repo.mjs --check        只看还剩几处，不改
 *     node tools/set-repo.mjs --revert       换回 DSH_Plugins
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

/** 现在写着的名字。 */
const CURRENT = 'DSH_Plugins';

const arg = process.argv[2];
if (arg === undefined) {
  process.stdout.write('\n  用法：node tools/set-repo.mjs <新仓库名>\n');
  process.stdout.write('        node tools/set-repo.mjs --check\n');
  process.stdout.write('        node tools/set-repo.mjs --revert\n\n');
  process.exit(1);
}

const check = arg === '--check';
const apply = arg === '--revert' ? CURRENT : arg;

/**
 * 真正要写进去的名字。
 *
 * ⚠️ `--check` 时**不能**把它当成名字 —— 那会把仓库名改成字面的 `--check`
 * （第一版就是这么写的）。所以用一个占位串，让它和 `CURRENT` 不同、
 * 从而能被规则匹配到、数得出来，**但那条路一步都不写盘**。
 */
const next = check ? '«新名字»' : apply;

/**
 * 两条规则，都**锚在 URL / 文件名那个位置上** —— 不碰本机路径。
 *
 * `esc` 是给 `CURRENT` 里可能出现的正则元字符用的。现在它是纯字母加下划线，
 * 但规则写死成「反斜杠在这里不重要」是要还债的：**下划线没有特殊含义，
 * 而下一个改这个名字的人未必还叫这个。**
 *
 * @param {string} name - 目标仓库名。
 * @returns {[RegExp, string][]} 替换规则。
 */
function rules(name) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return [
    // ① **紧跟 `<用户名>/` 的那个仓库名。**
    //
    //    锚是 `owner/` 而不是 `github.com/` —— 第一版写成后者，于是漏了四处：
    //      name: <用户名>/DSH_Plugins#cyrene-agent        （投稿的 name 字段没域名）
    //      gh api … repos/<用户名>/DSH_Plugins/topics     （gh 的路径写法）
    //    **而 `<用户名>/DSH_Plugins` 这个形状不可能是本机路径** ——
    //    本机那条是 `<本仓库>`，前面根本没有 `<用户名>/`。
    //    所以锚在斜杠上是窄得刚好、又不会误伤的写法。
    //
    //    `\\b` 在末尾：`DSH_Plugins_backup` 那种不该被吃进来。
    [new RegExp(`(<用户名>/)${esc(CURRENT)}\\b`, 'gu'), `$1${name}`],
    // ② 投稿文件名：`Lutisure__DSH_Plugins--cyrene-agent.yml`。
    //    `__` 和 `--` 是那个仓库的命名格式，不是随便的分隔符。
    //    （它其实也会被 ① 之外的这一条单独命中，保留是因为语义不同 ——
    //      「文件名」和「URL」两类以后可能各自改法不一样。）
    [new RegExp(`(Lutisure__)${esc(CURRENT)}(--)`, 'gu'), `$1${name}$2`]
  ];
}

/** 被跟踪的文件 —— 用 `git grep`，不遍历目录（那会把 node_modules 里碰巧带这串的包也改了）。 */
function files() {
  try {
    return execSync('git ls-files', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const targets = files();
let touched = 0;
let total = 0;

for (const file of targets) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\u0000')) continue;

  const before = text;
  let after = text;
  const counts = [];
  for (const [pattern, replacement] of rules(next)) {
    const n = (after.match(pattern) ?? []).length;
    if (n > 0) {
      counts.push(n);
      after = after.replace(pattern, replacement);
    }
  }
  if (after === before) continue;

  const n = counts.reduce((a, b) => a + b, 0);
  total += n;
  // ⚠️ `--check` 一步都不写盘 —— 它的用处是「先看有几处」，看了才决定动不动。
  if (!check) {
    writeFileSync(file, after, 'utf8');
    touched += 1;
  }
  process.stdout.write(`  ${String(n).padStart(3)} 处  ${file}\n`);
}

if (check) {
  process.stdout.write(`\n  还剩 ${total} 处 —— 上面每一条都要处理。\n\n`);
} else if (total === 0) {
  process.stdout.write(`\n  一处都没改。仓库名已经是 ${next}，或者规则没匹配上。\n\n`);
} else {
  process.stdout.write(`\n  改好了：${touched} 个文件，${total} 处 → ${next}\n`);
  process.stdout.write(`\n  接下来：\n`);
  process.stdout.write(`    · GitHub 上把仓库改名（Settings → General → Repository name）\n`);
  process.stdout.write(`      **它会自动重定向旧地址**，所以顺序无所谓\n`);
  process.stdout.write(`    · node tools/make-share.mjs <导出目录>   重新导出\n`);
  process.stdout.write(`    · 核对导出物里那九处 URL（三个 package.json）\n\n`);
}
