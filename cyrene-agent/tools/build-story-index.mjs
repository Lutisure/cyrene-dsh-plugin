/**
 * 把剧情原文切成可检索的小块。
 *
 * ## 边界从哪来
 *
 * 那两个 `.md` 是**有结构的**：`#` 是章节、`##` 是任务节点（带 ID，如 `` `1040101` ``）。
 * 所以第一刀用现成的 `##`，不自己猜。
 *
 * 但 67 个节点、平均一万字符，**还太大** —— 世界书一轮的预算是 1400 字符，
 * 检索出来的一条要能塞进去，最好 600~1000。所以节点内部再按行累加到上限。
 *
 * ## 为什么按行切，不按字数切
 *
 * 正文一行是一条发言（`**【遐蝶】** …`）或一段旁白。**切在行中间会把一句话劈开，
 * 而检索到半句比检索不到更坏** —— 它看起来像有依据。
 *
 * ## 哪些文件进索引
 *
 * 只收**剧情原文**。`corpus-src/` 里另有 cyrene-* 那几份（她说过的话、语音、档案），
 * 那些已经以别的形式在 persona 里了，再索引一遍等于给同一个东西两条来源。
 *
 * ⚠️ 主线有三份（main-story 1739 KB / main-story-voiced 1690 KB / story 542 KB）。
 * 这里只收最全的那份 main-story —— **另外两份是不是它的子集，还没核**，
 * 写在 TODO 里了。收重了会让检索结果互相挤。
 *
 * 用法：
 *   node tools/build-story-index.mjs            # 切块并落盘
 *   node tools/build-story-index.mjs --stats    # 只看统计，不写
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// ---- 仓库根，从本文件的位置推（由 tools/derive-roots.mjs 加的头）----
//
// 以前这里写的是作者机器上的绝对路径。那只在那台机器上成立，
// 而且清洗脚本会把绝对路径换成占位符，于是代码里出现 <本仓库> 这种目录名，直接崩。
import { fileURLToPath as __f } from 'node:url';
import { dirname as __d, join as __j } from 'node:path';
const REPO_ROOT = __j(__d(__f(import.meta.url)), '../..');

/**
 * 根目录。
 *
 * ⚠️ `DSH_STORY_ROOT=<临时目录>` 可以把它引开 —— **测试靠这个跑端到端**：
 * 造一份 `corpus-src/` 夹具，跑一遍工具，看 `dist/story-chunks.jsonl` 对不对。
 *
 * 这个函数里真的写错过一次（去重放在「块」那一层，983 块掉成 123 块），
 * 而输出看起来「正常」。**那种错只有真跑一遍才看得见。**
 */
const ROOT = process.env.DSH_STORY_ROOT ?? `${REPO_ROOT}/cyrene-agent`;

/** 一块最多多少字符。世界书预算 1400，留出一次给两块的余地。 */
const CHUNK_TARGET = 900;

/** 一块最少多少字符 —— 太短的块（比如一个标题）没有检索价值。 */
const CHUNK_MIN = 120;

/**
 * 要切的文件 —— **顺序有意义，不要重排。**
 *
 * ## 三份的关系（2026-10-11 按节点 ID 核过）
 *
 * | 文件 | 节点 | 与其他两份的关系 |
 * |---|---:|---|
 * | amphoreus-main-story.md | 67 | 与 -voiced **完全相同**（只留这一份） |
 * | amphoreus-side-stories.md | 29 | 与 main 零重合；**29 个全在 amphoreus-story 里** |
 * | amphoreus-story.md | 126 | **是那两份的并集**（∩main 66、∩side 29） |
 *
 * ## `-voiced` 为什么不收（2026-10-11 按正文行核过）
 *
 * 它和 main-story **节点完全相同**，但字符少 18K，所以查了一遍它有没有不同的行：
 *
 *   正文行    main 22,360   voiced 21,594   **重合 19,192**
 *   main 独有  `↳ 以上都通向：**【姬子】** 她说自己只是个搭车客…`
 *   voiced 独有       `**【姬子】** 她说自己只是个搭车客…`
 *
 * **差别是 `↳ 以上都通向：` 这个前缀** —— main 标出了合并的选项分支，voiced 没标。
 * 两者确实按不同的顺序展开（main 按 ID，voiced 按语音文件路径里的序号），
 * **但对话本身是同一批。** 所以不收它不会漏内容，收它会白白多一份重复。
 *
 * ⚠️ 这一条是**查过才敢写的**。同一轮我先查了 amphoreus-story，结论是「漏了 83 块」；
 * 同一个查法用在这里，结论是「不用收」。**同一种怀疑，两个相反的答案 —— 所以要查，不要推。**
 *
 * ⚠️ **并集那份的文字反而更薄。** 支线 29 个节点，单独那份有 195 块 / 164,968 字，
 * 而 amphoreus-story 里同样的节点只有约三分之一。**收并集那份会把支线收瘦。**
 *
 * 所以顺序是：**先收文字最全的，再用并集去补剩下的节点。** 去重按节点 ID，
 * 先到先得 —— 重排这个数组会让支线那 29 个节点换成薄的那一版。
 *
 * ⚠️ 原来这里只有两份，注释写着「只收最全的那份」。**那句话是错的**：
 * 按字符算最全的是 main-story，按节点算最全的是 amphoreus-story，**两个都不是全集。**
 * 漏掉的是 amphoreus-story 独有的那 31 个节点。
 */
const SOURCES = [
  { file: 'amphoreus-main-story.md', kind: '主线' },
  { file: 'amphoreus-side-stories.md', kind: '支线' },
  { file: 'amphoreus-story.md', kind: '主线' }
];

/**
 * 清掉游戏界面的痕迹。
 *
 * ## 为什么
 *
 * 那两个 `.md` 是从游戏里提的**播放顺序原文**，所以带着播放器的记号：
 *
 *     〔选项〕
 *     　· 轻轻触碰。
 *     　　↳ **【不知名的死囚】** 不、不……
 *
 * **实测：这几类占 12.5% 的字符，65% 的块里有它。**
 *
 * 而代价不只是体积。对方在 2026-10-11 说：问「遐蝶的死亡之触」时**思考时间明显变长**。
 * 查下来两个原因，这是其中一个 —— **要读懂一段剧情，模型得先把这些记号过滤掉。**
 *
 * ## 怎么清
 *
 * `〔选项〕` 和 `· 选项` 是**界面**（玩家能选什么），去掉。
 * `↳ ` 开头的是**那些选择的结果**，那是剧情，**留内容、去记号**：
 *
 *     ↳ 以上都通向：**【不知名的死囚】** 不、不……
 *     →
 *     **【不知名的死囚】** 不、不……
 *
 * ⚠️ 去掉选项行会让分支的因果变淡（哪句回应哪个选项看不出来了）。**这是有意的取舍** ——
 * 她要的是那一幕发生了什么，不是当时能按哪几个键。
 *
 * @param {string} line - 原文一行。
 * @returns {string|null} 清好的一行；整行是界面时返回 null。
 */
function cleanLine(line) {
  const t = line.trim();
  if (t === '') return line;
  if (t.startsWith('〔选项〕')) return null;
  if (/^[·・]/.test(t)) return null;
  if (t.startsWith('↳')) {
    const body = t
      .replace(/^↳\s*/, '')
      .replace(/^以上都通向：\s*/, '')
      .replace(/^[·・]\s*/, '')
      .trim();
    return body === '' ? null : body;
  }
  return line;
}

/**
 * 切一个文件。
 *
 * 导出是为了能测 —— **这个函数里真的写错过一次**：第一版把去重放在「块」这一层，
 * 而一个节点会切出十几块，于是 983 块掉成 123 块，**而输出看起来「正常」**
 * （每个文件都有块数、分位数也合理）。是看到「支线 1 块」才起疑的。
 *
 * @param {string} raw - 全文。
 * @param {string} kind - 主线 / 支线，进 metadata。
 * @param {Set<string>} skipNodes - 已经收过的节点 ID。**从这里开始跳过整个节点。**
 * @returns {Array<{id: string, text: string, chapter: string, node: string, nodeId: string, kind: string}>} 块。
 */
export function chunkFile(raw, kind, skipNodes = new Set()) {
  const lines = raw.split('\n');
  const chunks = [];
  let chapter = '';
  let node = '';
  let nodeId = '';
  let skip = false;
  let buffer = [];
  let size = 0;
  let seq = 0;

  const flush = () => {
    // skip 时不产出 —— 但缓冲照样要清，否则下一次 flush 会带上别人的行。
    const text = buffer.join('\n').trim();
    if (!skip && text.length >= CHUNK_MIN) {
      seq += 1;
      chunks.push({
        id: `${kind}-${nodeId || 'x'}-${seq}`,
        text,
        chapter,
        node,
        nodeId,
        kind
      });
    }
    buffer = [];
    size = 0;
  };

  for (const line of lines) {
    // 一级标题：章节名。二级标题：任务节点，末尾带 `ID`。
    if (/^# /.test(line)) {
      flush();
      chapter = line.replace(/^#\s*/, '').trim();
      node = '';
      nodeId = '';
      skip = false;
      continue;
    }
    if (/^## /.test(line)) {
      flush();
      const m = line.match(/^##\s*(.*?)\s*[`'"]?(\d{6,})[`'"]?\s*$/);
      node = m ? m[1].trim() : line.replace(/^##\s*/, '').trim();
      nodeId = m ? m[2] : '';
      // ⚠️ **去重必须在节点这一层，不能在块这一层。**
      // 一个节点会切出十几块 —— 按块去重会让每个节点只有第一块活下来
      // （2026-10-11 实测：983 块掉成 123 块，而输出看起来「正常」）。
      if (nodeId !== '') {
        skip = skipNodes.has(nodeId);
        skipNodes.add(nodeId);
      } else {
        skip = false;
      }
      continue;
    }
    // 引用块的说明行（「崩坏：星穹铁道 游戏内文本…」）不进索引。
    if (/^>/.test(line)) continue;
    if (skip) continue;

    // 清掉播放器界面（〔选项〕/·/↳）—— 留着会让模型先过滤一遍才读得懂剧情。
    const cleaned = cleanLine(line);
    if (cleaned === null) continue;

    if (cleaned.trim() === '') {
      // 空行不占额度，但保留它 —— 段落在正文里是有意义的。
      if (buffer.length > 0) buffer.push(cleaned);
      continue;
    }
    if (size + cleaned.length > CHUNK_TARGET && size > 0) flush();
    buffer.push(cleaned);
    size += cleaned.length + 1;
  }
  flush();
  return chunks;
}

const statsOnly = process.argv.includes('--stats');
const all = [];
const perFile = [];
/**
 * 已经收过的节点 ID。
 *
 * ⚠️ **去重按节点，不按文件。** 三份主线覆盖的节点不互相包含 ——
 * main-story 有 67 个，amphoreus-story 有 126 个而其中 60 个不在前者里。
 * 不去重的话，那 66 个共同的节点会各收两遍，检索时互相挤。
 */
const seenNodes = new Set();
for (const src of SOURCES) {
  const path = `${ROOT}/corpus-src/${src.file}`;
  if (!existsSync(path)) {
    console.log(`  ⚠️ 读不到 ${src.file}`);
    continue;
  }
  const raw = readFileSync(path, 'utf8');
  // 去重交给 chunkFile —— 它在**节点**那一层跳，不在块那一层。
  const chunks = chunkFile(raw, src.kind, seenNodes);
  const chars = chunks.reduce((n, c) => n + c.text.length, 0);
  perFile.push({ file: src.file, chunks: chunks.length, chars });
  all.push(...chunks);
}

console.log('\n  切块结果\n');
console.log('    ' + '文件'.padEnd(30) + '块数'.padStart(7) + '总字符'.padStart(10) + '平均'.padStart(8));
for (const p of perFile) {
  console.log('    ' + p.file.padEnd(30) + String(p.chunks).padStart(7) + String(p.chars).padStart(10) + Math.round(p.chars / p.chunks).toString().padStart(8));
}
const totalChars = all.reduce((n, c) => n + c.text.length, 0);
console.log('    ' + '合计'.padEnd(30) + String(all.length).padStart(7) + String(totalChars).padStart(10) + Math.round(totalChars / all.length).toString().padStart(8));

// 块长分布 —— 只看平均会漏掉「一半是小的、一半是大的」。
const lens = all.map((c) => c.text.length).sort((a, b) => a - b);
const q = (p) => lens[Math.floor(lens.length * p)] ?? 0;
console.log(`\n    块长 25/50/75/90 分位: ${q(0.25)} / ${q(0.5)} / ${q(0.75)} / ${q(0.9)}`);
console.log(`    最长的三块: ${lens.slice(-3).reverse().join('  ')}`);
console.log(`    带节点 ID 的: ${all.filter((c) => c.nodeId !== '').length} / ${all.length}\n`);

if (statsOnly) process.exit(0);
mkdirSync(`${ROOT}/dist`, { recursive: true });
const out = `${ROOT}/dist/story-chunks.jsonl`;
writeFileSync(out, all.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8');
console.log(`    写到 ${out}\n`);
