/**
 * 审 git 历史 —— 不是审当前文件树。
 *
 * ## 为什么需要另一个工具
 *
 * `tools/audit-shareable.mjs` 查的是**工作区里现在的文件**。
 * 而 `git push` 推的是**历史**：每个文件在每一次提交时的样子。
 *
 * 一个文件现在干净，不等于它在历史里干净。最容易踩的两个：
 *
 *   · `dist/` 被 `make-share` 排除了，但它在历史里被提交过几十次，
 *     而 `dist/skills/cyrene/SKILL.md` 里**内联着作者的说话方式修正** ——
 *     那是私人材料。
 *   · 绝对路径在工作区里已经有工具洗过，但**历史里的那份是原件**。
 *
 * 所以：要么别推历史（推荐 —— 开一个新仓库放一份当前状态），
 * 要么先知道历史里到底有什么。
 *
 * ## 做法
 *
 * `git rev-list --objects --all` 列出所有对象，去重之后只取 blob，
 * 逐个 `git cat-file` 出来扫。扫的是**唯一内容**，不是逐提交的差异 ——
 * 否则同一个文件会被扫上百遍。
 *
 * 用法：
 *   node audit-git-history.mjs <仓库路径> [--top 20]
 */
import { execFileSync } from 'node:child_process';

const repo = process.argv[2] ?? '.';
const topAt = process.argv.indexOf('--top');
const TOP = topAt === -1 ? 15 : Number(process.argv[topAt + 1]);

const git = (...args) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 1e9 }).toString('utf8');

/** 要找的东西。每条给一个名字和一段正则，以及自述。 */
//
// ⚠️ 用户名和安装目录**从环境取，不写死**。
//
// 规则必须含有它要匹配的字符串。写进源码的话，这个工具自己就成了导出物里的
// 一处命中 —— 2026-10-10 实际发生过：清洗跑完，独立复查还能在
// `tools/audit-shareable.mjs` 里找到用户名，因为那条规则里写着它。
const USER = process.env.USERNAME ?? process.env.USER ?? '';
const INSTALL_DIR = (() => {
  const m = /^[A-Z]:[\\/]([^\\/]+)/u.exec(process.env.DSH_ASAR ?? '');
  return m === null ? '' : m[1];
})();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const RULES = [
  {
    name: '私人记忆文本',
    why: '作者的长期记忆 / 说话方式修正。它们会被内联进 dist/skills 和 dist/system-prompt。',
    // 不在这里写出原文 —— 那会把泄露抄进这个工具自己的源码。
    // 用结构特征找：记忆块抬头、修正块抬头。
    re: /【你对说话方式的修正|【你对对方的长期记忆|以下是对方明确要求过的/g
  },
  {
    name: '用户名',
    why: 'Windows 用户名。',
    re: USER === '' ? /$^/g : new RegExp(`\\b${esc(USER)}\\b`, 'gi')
  },
  {
    name: '主目录绝对路径',
    why: '写死的 C:\\Users\\<名字>。',
    re: /C:\\Users\\[A-Za-z0-9_.-]+/g
  },
  {
    name: '仓库绝对路径',
    why: '写死的盘符路径。换台机器就失效，而且暴露目录结构。',
    re: new RegExp(`[A-Z]:\\\\+(?:${['DSH_Plugins', 'DSH_AI_Learning', INSTALL_DIR].filter(Boolean).map(esc).join('|')})[^\\\\\\s"'\]]*`, 'g')
  }
];

process.stdout.write(`\n  审 ${repo} 的历史\n\n`);

const objects = git('rev-list', '--objects', '--all').split('\n').filter(Boolean);
const blobs = [];
for (const line of objects) {
  const sp = line.indexOf(' ');
  if (sp === -1) continue;
  blobs.push(line.slice(sp + 1));
}
// 只保留路径看起来像文本的，并且去重
const TEXT = /\.(mjs|js|json|yaml|yml|md|txt|css|ts|html|py|cmd|ps1|vbs|jsonl)$/i;
const paths = [...new Set(blobs.filter((p) => TEXT.test(p)))];

process.stdout.write(`  ${objects.length} 个对象，其中文本类文件 ${paths.length} 个（去重后）\n\n`);

const found = new Map();
let scanned = 0;
for (const path of paths) {
  let content;
  try {
    content = execFileSync('git', ['-C', repo, 'show', `HEAD:${path}`], { maxBuffer: 1e9, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
  } catch {
    // 这个路径在 HEAD 里不存在（历史里删掉了）—— 也要查，用 rev-list 找最后一次
    try {
      const sha = git('rev-list', '--all', '--', path).trim().split('\n')[0];
      content = execFileSync('git', ['-C', repo, 'show', `${sha}:${path}`], { maxBuffer: 1e9, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
    } catch { continue; }
  }
  scanned += 1;
  for (const rule of RULES) {
    const hits = content.match(rule.re);
    if (hits === null) continue;
    if (!found.has(rule.name)) found.set(rule.name, new Map());
    const perFile = found.get(rule.name);
    perFile.set(path, (perFile.get(path) ?? 0) + hits.length);
  }
}

process.stdout.write(`  实际扫了 ${scanned} 份内容（HEAD 有的话用 HEAD，没有的取最后一次出现的版本）\n\n`);

if (found.size === 0) {
  process.stdout.write('  没有在历史里找到这几类东西。\n\n');
} else {
  for (const rule of RULES) {
    const perFile = found.get(rule.name);
    if (perFile === undefined) continue;
    const entries = [...perFile].sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((s, [, n]) => s + n, 0);
    process.stdout.write(`  ⚠️  ${rule.name} —— ${entries.length} 个文件，${total} 处\n`);
    process.stdout.write(`      ${rule.why}\n`);
    for (const [p, n] of entries.slice(0, TOP)) {
      process.stdout.write(`        ${String(n).padStart(4)}  ${p}\n`);
    }
    if (entries.length > TOP) process.stdout.write(`        …… 另外 ${entries.length - TOP} 个文件\n`);
    process.stdout.write('\n');
  }
}

// 历史本身的样子：有多少提交、多少是「去掉误提交」
const total = git('rev-list', '--count', 'HEAD').trim();
const noise = git('log', '--oneline').split('\n').filter((l) => /去掉误提交|临时文件/.test(l)).length;
process.stdout.write(`  历史：${total} 个提交，其中 ${noise} 个是「去掉误提交的临时文件」\n`);
process.stdout.write(`  → 面试的人翻历史时，这 ${noise} 条会先被看到。\n\n`);
