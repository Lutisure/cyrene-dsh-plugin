/**
 * 会话日志索引 —— 面子的「哪个会话的日志在哪个文件」都在这里。
 *
 * 两个调用方（`tools/receipts.mjs` 和排查用的 `--debug-join`）必须看到**同一份**
 * 索引。第一版是各写一遍的，结果其中一份漏了一种布局，而漏掉的样子是
 * 「报账说 0 轮能接上」—— 看着像没有真实数据，其实是有、只是没找到。
 *
 * ## 磁盘上的布局不止一种
 *
 * ```text
 * ~/.dsh/sessions/--<工作区>--/
 *   session-<id>/session.v4.jsonl.zstd     ← 常见：一个会话一个目录
 *   session.v4.jsonl.zstd                  ← 也见过：日志直接躺在工作区目录下
 *   session-<id>/                          ← 空目录（会话建了但没写日志）
 * ```
 *
 * ⚠️ 第二种是**亲眼见的**：`<本仓库>` 下面就是
 * `session-029683de-…/` 和它**同级**的一个 1.3 MB 的 `session.v4.jsonl.zstd`。
 * 只按第一种扫，那个会话就被判成「没有对话内容」。
 *
 * 还有一种可以接受的漏：`session-ab967eba` 在留痕里有一轮，日志也在，但那一轮
 * **没有任何 assistant 文本**（她只调了工具就结束了）—— 于是接出 0 段回复。
 * 那不是索引的问题，是「这一轮本来就没有可以拿来比对的回复」。
 */
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 两个候选文件名，磁盘上的压缩那份更新更全。 */
const CANDIDATES = ['session.v4.jsonl.zstd', 'session.v4.jsonl'];

/** 某个目录下有没有会话日志，有就返回路径。 */
function logIn(dir) {
  for (const name of CANDIDATES) {
    const file = join(dir, name);
    try {
      if (statSync(file).isFile()) return file;
    } catch {
      /* 没有就是没有 */
    }
  }
  return null;
}

/**
 * 扫出所有会话日志。
 *
 * @param {string} [home] - `$DSH_HOME`；默认按环境变量 → `~/.dsh` 的顺序取。
 * @returns {{id: string, workspace: string, file: string}[]} 索引。
 *   `id` 是会话 id（目录名），也是留痕里 `session` 字段的值。
 */
export function findSessionLogs(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  const root = join(home, 'sessions');
  const found = [];
  let workspaces = [];
  try {
    workspaces = readdirSync(root);
  } catch {
    return found;
  }
  for (const workspace of workspaces) {
    const wsDir = join(root, workspace);
    // ① 日志直接躺在工作区目录下
    const loose = logIn(wsDir);
    if (loose !== null) found.push({ id: workspace, workspace, file: loose });

    // ② 一个会话一个子目录
    let entries = [];
    try { entries = readdirSync(wsDir); } catch { continue; }
    for (const name of entries) {
      const dir = join(wsDir, name);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      const file = logIn(dir);
      if (file !== null) found.push({ id: name, workspace, file });
    }
  }
  return found;
}
