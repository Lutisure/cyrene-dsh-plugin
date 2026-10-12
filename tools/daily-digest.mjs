/**
 * 每日素材汇总 —— 把某一天发生过的事收成一份，供人（或模型）写成日志。
 *
 * ## 它做什么，不做什么
 *
 * **做收料**：那一天动过哪些会话、人和她各自说了什么、两个仓库提交了什么。
 * **不做判断**：哪几件事重要、哪一处是推翻了自己 —— 那是理解活，不是脚本活。
 *
 * 所以它的产物文件名叫 `_素材-<日期>.md`，前缀下划线是要它排在真正的日志后面。
 * 它是一份原材料，不是成品。
 *
 * ## 为什么不用导出包
 *
 * 磁盘上的 `.jsonl.zstd` 就在 `~/.dsh/sessions/--<工作区>--/<会话 id>/`，
 * **不用导出就能读，而且比导出包更新** —— 导出的那一刻之后就没了。
 * 读取走 `session-log.mjs`，它管着那个「几百个 zstd 帧首尾相接」的坑。
 *
 * 用法：
 *
 *   node tools/daily-digest.mjs                    # 今天
 *   node tools/daily-digest.mjs --date 2026-10-10
 *   node tools/daily-digest.mjs --date 2026-10-10 --out F:\daily
 *
 * 需要 `README.md` 里那个 node：
 *   $env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { forEachLine, seqOf } from './session-log.mjs';

const argv = process.argv.slice(2);
const argOf = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? null : (argv[at + 1] ?? null);
};

/** 默认今天，按本机时区。 */
function todayLocal() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const DATE = argOf('--date') ?? todayLocal();

/**
 * 窗口模式：`--hours 24` 取「此刻往前 24 小时」，而不是一个日历日。
 *
 * ⚠️ 排到凌晨 4 点跑的时候，日历日是**错的** —— 那一刻的「前 24 小时」横跨两天，
 * 按日期切会漏掉前一天白天那一整段。
 *
 * 两种模式不并存：给了 `--hours` 就按滚动窗口，`--date` 被忽略。
 */
const HOURS_AT = argv.indexOf('--hours');
const HOURS = HOURS_AT === -1 ? null : (Number(argv[HOURS_AT + 1]) || 24);
const UNTIL = new Date();
const SINCE = HOURS === null ? null : new Date(UNTIL.getTime() - HOURS * 3600 * 1000);

/** 这次跑的窗口，进文件名和正文抬头。 */
const LABEL = HOURS === null ? DATE : `近${HOURS}小时`;

const OUT_DIR = argOf('--out') ?? 'F:\\daily';
const SESSIONS = join(homedir(), '.dsh', 'sessions');

/**
 * 每份会话留多少条、每行留多少字。
 *
 * ⚠️ 第一版没设上限，一天跑出 **757 KB** —— 那不是素材，是倾倒，
 * 而这份东西存在的理由恰恰是「不要烧上下文」。
 *
 * 超限时**两头留、中间砍**：一天的开头和结尾通常各有一件事，
 * 只留最新的会把「早上从哪儿开始」丢掉。
 */
const PER_SESSION = 60;
const PER_LINE = 240;
const TOTAL_CHARS = 120000;
/** 每个仓库的提交正文留多少行。 */
const COMMIT_LINES = 400;

/**
 * 一个仓库，以及它相对工作区目录的名字。
 *
 * 会话目录是按**工作区**分的（`<本仓库>`），
 * 而提交是按**仓库**分的。两者对不上，所以这里手工列出来 ——
 * 想加仓库就在这里加一行，别去猜。
 */
const REPOS = [
  { name: 'dsh-theme-cyrene', path: '<本仓库>\\dsh-theme-cyrene' },
  { name: 'cyrene-agent', path: '<本仓库>\\cyrene-agent' }
];

/**
 * 某条记录属于哪一天（本机时区）。
 *
 * ⚠️ 用 `time` 而不是文件名或目录时间戳。目录 mtime 是最后一次写的时刻，
 * 一个跨天的会话会被整个算到第二天去。
 *
 * @param {object} row - 一条记录。
 * @returns {string} `YYYY-MM-DD`，取不到时间时返回空串。
 */
function dayOf(row) {
  const raw = row?.time ?? row?.data?.time;
  if (typeof raw !== 'string' && typeof raw !== 'number') return '';
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * 一条记录落不落在这次要收的窗口里。
 *
 * @param {object} row - 一条记录。
 * @returns {boolean} 在窗口内为真。
 */
function inWindow(row) {
  const raw = row?.time ?? row?.data?.time;
  if (typeof raw !== 'string' && typeof raw !== 'number') return false;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return false;
  // 记录时间在未来的不收 —— 时钟漂移会让一句还没发生的话进素材。
  if (at.getTime() > UNTIL.getTime()) return false;
  if (SINCE === null) return dayOf(row) === DATE;
  return at.getTime() >= SINCE.getTime();
}

/** 从一条记录里取正文。工具调用、思考、附件都不算说话。 */
function bodyOf(row) {
  const content = row?.data?.message?.content ?? row?.data?.content ?? [];
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

/** 递归找出目录下所有会话日志。 */
function findLogs(dir, found = []) {
  let items;
  try {
    items = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const item of items) {
    const full = join(dir, item.name);
    if (item.isDirectory()) findLogs(full, found);
    else if (/\.jsonl(\.zstd)?$/i.test(item.name)) found.push(full);
  }
  return found;
}

/**
 * 读一份日志，只留某一天的「人说的话」。
 *
 * 只收 `user/message` 和 `assistant/message` —— 系统提示、注入的世界书、
 * 工具结果都会以 user 身份出现，那些不是对话。
 */
async function slice(file) {
  const kept = [];
  try {
    await forEachLine(file, (row) => {
      if (!inWindow(row)) return;
      const type = row?.type;
      if (type !== 'user/message' && type !== 'assistant/message') return;
      const text = bodyOf(row);
      if (text === '') return;
      // 注入块以特定标记开头，剔掉。
      if (/^【(设定检索|你对对方|长期记忆|修正|锚点)/.test(text)) return;
      kept.push({ who: type === 'user/message' ? 'U' : 'A', seq: seqOf(row), text });
    });
  } catch {
    return null;
  }
  return kept;
}

/** 一天的提交，带正文。 */
function commits(repo, date) {
  // 用 spawnSync 而不是 shell —— 提交正文里全是引号、反引号和换行，
  // 走 shell 一定会被吃掉一层。
  const result = spawnSync('git', [
    '-C', repo.path, 'log',
    // ⚠️ 只给日期，不带 ` 00:00:00`。带时间的那一版实测没生效 ——
    // 跑出来 2828 行，是整个历史，被下面的行数上限截成了 400。
    // 那就是「截断掩盖了过滤没生效」，比不截更坏：看着一切正常。
    `--since=${date}T00:00:00`,
    `--until=${date}T23:59:59`,
    '--pretty=format:=== %h %s%n%b'
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return result.status === 0 ? String(result.stdout ?? '').trim() : '';
}

const lines = [];
lines.push(`# 素材 · ${LABEL}`, '');
lines.push('> 这是**原材料**，不是日志。判断哪几件重要、哪一处推翻了什么，是写的人的事。', '');

// ── 会话 ──────────────────────────────────────────────────────────────
lines.push('## 会话', '');
const logs = existsSync(SESSIONS) ? findLogs(SESSIONS) : [];
const touched = [];
for (const file of logs) {
  let mtime = null;
  try {
    mtime = statSync(file).mtime;
  } catch {
    continue;
  }
  // 一天前的文件不可能含今天的话。
  if (mtime !== null && mtime.getTime() < new Date(`${DATE}T00:00:00`).getTime() - 86400000) continue;
  const kept = await slice(file);
  if (kept === null || kept.length === 0) continue;
  const parts = file.split(/[\\/]/);
  const workspace = parts.find((part) => /^--.*--$/.test(part)) ?? '(未知工作区)';
  touched.push({ file, workspace, kept });
}

if (touched.length === 0) {
  lines.push('这一天没有读到的会话记录。', '');
} else {
  lines.push(`读到 ${touched.length} 份会话。`, '');
  for (const entry of touched) {
    const mine = entry.kept.filter((x) => x.who === 'U');
    const hers = entry.kept.filter((x) => x.who === 'A');
    lines.push(`### ${entry.workspace}`, '');
    lines.push(`对方 ${mine.length} 条 / 她 ${hers.length} 条`, '');

    // 两头留、中间砍。超限时明写砍了多少，免得读的人以为这就是全部。
    let shown = entry.kept;
    if (shown.length > PER_SESSION) {
      const half = Math.floor(PER_SESSION / 2);
      const cut = shown.length - PER_SESSION;
      shown = [
        ...shown.slice(0, half),
        { who: '…', seq: '', text: `（中间省略 ${cut} 条）` },
        ...shown.slice(-half)
      ];
    }
    for (const item of shown) {
      lines.push(`- \`${item.who}${item.seq}\` ${item.text.replace(/\s+/g, ' ').slice(0, PER_LINE)}`);
    }
    lines.push('');
  }
}

// ── 提交 ──────────────────────────────────────────────────────────────
//
// 每条提交留多少行。今天那十几条提交信息里写着「为什么」，
// 那正是这份素材最值钱的部分 —— 但一条长的能到几十行，不截会淹掉会话那一半。
lines.push('## 提交', '');
for (const repo of REPOS) {
  if (!existsSync(repo.path)) continue;
  const body = commits(repo, DATE);
  lines.push(`### ${repo.name}`, '');
  if (body === '') {
    lines.push('这一天没有提交。', '');
    continue;
  }
  const all = body.split('\n');
  if (all.length > COMMIT_LINES) {
    lines.push('```', ...all.slice(0, COMMIT_LINES),
      `（还有 ${all.length - COMMIT_LINES} 行，用 git log 看全）`, '```', '');
  } else {
    lines.push('```', ...all, '```', '');
  }
}

// ── 总量兜底 ──────────────────────────────────────────────────────────
//
// ⚠️ 必须在**所有**小节拼完之后。第一版把它放在会话那一节的后面，
// 而提交是后加的，于是上限根本没管住提交 —— 459 KB 跑出来才发现。
if (lines.join('\n').length > TOTAL_CHARS) {
  const kept = [];
  let size = 0;
  for (const line of lines) {
    size += line.length + 1;
    if (size > TOTAL_CHARS) break;
    kept.push(line);
  }
  const dropped = lines.length - kept.length;
  kept.push('', `> ⚠️ 总量超限，末尾 ${dropped} 行没有写进来。`,
    '> 要看全的用 `tools/session-dump.mjs <文件> <fromSeq> <toSeq>`。', '');
  lines.length = 0;
  lines.push(...kept);
}

try {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `_素材-${LABEL}.md`);
  writeFileSync(file, lines.join('\n'), 'utf8');
  process.stdout.write(`  素材写到 ${file}\n`);
  process.stdout.write(`  会话 ${touched.length} 份\n`);
} catch (error) {
  process.stdout.write(`  写不出去：${String(error?.message ?? error)}\n`);
  process.exitCode = 1;
}
