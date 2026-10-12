/**
 * 行尾。
 *
 * ## 为什么单独一个模块
 *
 * 2026-10-09 第 4 轮，一个「改九个条目的触发词」的小脚本调试了**三轮**，
 * 三次都栽在行尾上，而且每次的症状都指向别处：
 *
 *   ① `indexOf("\n  - id: x\n")` —— 文件是 CRLF，一条也找不到
 *   ② 加了 `\r?$` —— 于是**它把 `\r` 吃掉了**，写回去的行尾变成 LF
 *   ③ `slice(start + 1)` 找下一条 —— `\r?` 可选，匹配到了自己那个 `\n`
 *
 * ②最值得记，因为它是**反向**的：加 `\r?` 本意是「让 CRLF 也能匹配」，
 * 结果它成了「把 CRLF 改成 LF」的凶手。原因是 JavaScript 多行模式里
 * **`\r` 也是 LineTerminator**：
 *
 *     ^  可以匹配在 `\r` 和 `\n` **之间**
 *     $  可以匹配在 `\r` **之前**
 *     \s 匹配 `\n`，所以 `(\s+...)` 会把上一行的换行一起吃掉
 *
 * 于是 `^(\s+triggers: )\[.*\]\r?$` 匹配到的是 `"\n    triggers: [...]\r"`
 * —— 两头的换行字符各被吃掉一半，替换文本里没有，写回去就少了个 `\r`。
 *
 * ## 用哪个行尾
 *
 * **跟随文件现有的**，不强行统一。理由：这个仓库是**备份**，工作区就是正在运行的
 * 那份插件（`.gitattributes` 里写着 `* -text`，git 一个字节都不许改）。
 * 工具没有立场去改一个文件的整体风格，它只该**不要在编辑的时候顺手改掉**。
 *
 * 大方向仍然统一到 LF（`normalize` 那一步做），但那是**一次性的决定**，
 * 不是每个工具各自决定的。
 */

/** 判断一份文本主体用哪种行尾。混着的时候看哪个多。 */
export function detectEol(text) {
  const crlf = (String(text).match(/\r\n/g) ?? []).length;
  const lf = (String(text).match(/(?<!\r)\n/g) ?? []).length;
  if (crlf === 0 && lf === 0) return '\n';
  return crlf > lf ? '\r\n' : '\n';
}

/** 一份文本是不是混着两种行尾。 */
export function isMixed(text) {
  const s = String(text);
  return /\r\n/.test(s) && /(?<!\r)\n/.test(s);
}

/** 数一份文本里的两种行尾。 */
export function countEol(text) {
  const s = String(text);
  return {
    crlf: (s.match(/\r\n/g) ?? []).length,
    lf: (s.match(/(?<!\r)\n/g) ?? []).length,
    mixed: isMixed(s)
  };
}

/**
 * 把一份文本整体换成同一种行尾。
 *
 * ⚠️ 它会重写**整个文件**。只在明确要统一风格的时候用（比如仓库级的一次性整理），
 * 不要在「编辑某几行」的工具里用 —— 那会把无关的行也写进 diff。
 */
export function normalizeEol(text, eol = '\n') {
  return String(text).replace(/\r\n/g, '\n').split('\n').join(eol);
}

/**
 * 按指定行尾拼一组行。
 *
 * 给「渲染一段新内容然后追加到文件里」用 —— 那种地方最常顺手写 `\n`，
 * 于是给一个 CRLF 文件添了几行 LF。
 */
export function joinLines(lines, eol = '\n') {
  return lines.join(eol);
}

/**
 * 在 CRLF 文件里安全地替换一整行。
 *
 * 上面那段注释里的 bug 就出在这件事上，所以把它固定下来：
 *
 *   · 行首用 `[ \t]+` 而不是 `\s+` —— `\s` 会吃掉上一行的换行
 *   · 行尾把 `\r?` **捕获**下来，替换文本里照原样写回去
 *   · 不用 `$` —— 它在 `\r` 之前就能成立，位置很容易想错
 *
 * @param {string} text - 整份文本。
 * @param {RegExp} key - 用来定位那一行的模式，须含一个行首锚定的捕获组。
 * @param {(line: string) => string} render - 拿到旧行，返回新行（不含行尾）。
 * @returns {string} 新的整份文本。
 */
export function replaceLine(text, key, render) {
  const match = key.exec(text);
  if (match === null) return text;
  const old = match[0];
  const trailing = old.endsWith('\r') ? '\r' : '';
  const bare = trailing === '' ? old : old.slice(0, -1);
  return text.slice(0, match.index) + render(bare) + trailing + text.slice(match.index + old.length);
}
