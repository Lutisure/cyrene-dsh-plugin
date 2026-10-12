/**
 * 「本机那份私人记忆」的匹配模式 —— **一处实现，两处使用**。
 *
 * ## 为什么单独一个文件
 *
 * 这条规则搬过一次家，而两次的形态是同一个：
 *
 *   1. 2026-10-10：它写在 `audit-shareable.mjs` 里，是一条**写死的正则，
 *      里面抄着那两行记忆的原文**。于是「防止记忆外泄的脚本」自己带着那两行 ——
 *      **补漏的动作本身成了漏**。改成现读本机 `memory.md`。
 *   2. 2026-10-12：**同一处漏被抄了第二遍** —— `check-npm-publish.mjs` 里
 *      又出现一条写死的正则，装的是同样的两句话。而那个文件的注释里，
 *      还写着「一个字都不要写全」。
 *
 * 规矩写在被违反的地方旁边是不够的。所以它现在只有一份实现：
 * 复制粘贴在这个仓库里已经出过三次，每一次都是**把要防的东西写进了防它的地方**。
 *
 * ## 规矩本身
 *
 * 说「在哪、什么类型、多少条」就够了，**一个字都不要复述**。
 * 这个文件的注释就是那条规矩的写法示范：它描述了那两行的**来历**，
 * 没有一个字是那两行的**内容**。
 *
 * ## 没有 memory.md 时
 *
 * 返回一个**永不匹配**的模式，而不是抛。收件人那台本来就没有这份记忆，
 * 规则在那里的意义是「本机发出去会漏什么」，不是「任何机器都会漏这两句」。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 按本机那份 `memory.md` 现生成「私人记忆内容」的匹配模式。
 *
 * @returns {RegExp} 匹配本机任何一条记忆内容的模式；没有可漏的就永不匹配。
 */
export function memoryContentPattern() {
  const never = /(?!)/u;
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    const file = join(home, 'cyrene-agent', 'memory.md');
    if (!existsSync(file)) return never;
    const escaped = readFileSync(file, 'utf8')
      .replace(/\r\n?/gu, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim())
      // 太短的片段会在任何文档里误伤，只拿真正有信息量的。
      .filter((entry) => entry.length >= 8)
      .map((entry) => entry.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
    if (escaped.length === 0) return never;
    return new RegExp(escaped.join('|'), 'u');
  } catch {
    return never;
  }
}
