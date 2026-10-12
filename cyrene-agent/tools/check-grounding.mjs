/**
 * 设定核查：世界书里引用的原话，能不能在语料里找到。
 *
 * ## 为什么需要它
 *
 * CharacterEval 的「人格反测」用了一个**第三方**的 MBTI 数据库当标准答案 ——
 * 那个数字因此有说服力。而我们的断言全是**自己写的**：说「问白厄应当注入这三条」，
 * 然而凭什么？这是我们定的。
 *
 * 这个脚本把一条纪律变成检查：**「只写原文支持的」**。
 * 世界书上写着这条规矩，但一直没有东西守着它 ——
 * 而「守着一句没人查的规矩」和「没有规矩」在实践中差别很小。
 *
 * ## 基准是什么
 *
 * **游戏原文**。不是我们写的，是米哈游写的：
 *
 *   corpus-src/amphoreus-main-story-voiced.md   主线全文 66 万字
 *   corpus-raw/cyrene-speaks-v3.txt             她的 2,054 句
 *   corpus-raw/cyrene-voice.txt                 语音台词
 *
 * ## ⚠️ 它只能报告，不能判对错
 *
 * 条目里的引号有两种用法：**逐字引用**原话，和**转述**某个意思。
 * 文本本身分不出这两者 —— 所以找不到出处的引文**不一定是编的**，
 * 可能只是用引号括了个概括。这个脚本把查不到的列出来供人核对，
 * **不设通过/失败线**。
 *
 * 用法：
 *   node tools/check-grounding.mjs             # 列出语料里找不到的引文
 *   node tools/check-grounding.mjs --json
 *   node tools/check-grounding.mjs --min 8     # 只查 8 字以上的引文（默认 6）
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

// ---- 仓库根，从本文件的位置推（由 tools/derive-roots.mjs 加的头）----
//
// 以前这里写的是作者机器上的绝对路径。那只在那台机器上成立，
// 而且清洗脚本会把绝对路径换成占位符，于是代码里出现 <本仓库> 这种目录名，直接崩。
import { fileURLToPath as __f } from 'node:url';
import { dirname as __d, join as __j } from 'node:path';
const REPO_ROOT = __j(__d(__f(import.meta.url)), '../..');

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const ROOT = `${REPO_ROOT}/cyrene-agent`;
const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const at = argv.indexOf('--min');
const MIN = at === -1 ? 6 : Number(argv[at + 1]);

/** 语料：几份合起来当基准。缺哪份就跳过哪份。 */
const SOURCES = [
  // ⚠️ **两份都要**。
  //
  // 2026-10-09：丹恒（经由使用者）指出主线文本「缺少了部分语句文本」。量下来是真的 ——
  // 有配音那份比完整那份少 1,150 行正文（6.2%），全是**没配音**的东西：
  // 旁白、玩家动作指令、以及没有配音演员的龙套（【慌张的难民】那类）。
  // 它自己文件头就写着「没配音的旁白不在语音表里，仍靠 ID 补」—— 补漏了一些。
  //
  // 只拿有配音那份当基准，会把「原文里有、但语音表里没有」的引用误判成查不到。
  ['主线（完整）', `${ROOT}/corpus-src/amphoreus-main-story.md`],
  ['主线（有配音）', `${ROOT}/corpus-src/amphoreus-main-story-voiced.md`],
  ['她的台词', `${ROOT}/corpus-raw/cyrene-speaks-v3.txt`],
  ['语音', `${ROOT}/corpus-raw/cyrene-voice.txt`],
  ['角色故事', `${ROOT}/corpus-src/cyrene-profile.md`],
  // 短信。第一版漏了它，于是 ripples / fairy-magic / partner / letters /
  // star-motif / farewell-tone 全被报成「查不到」—— 那几句**都是短信里的**。
  // 基准不全的时候，工具会一本正经地报出一堆假问题。
  ['短信往来', `${ROOT}/corpus-src/messageconversations.json`],
  ['短信联系人', `${ROOT}/corpus-src/messagecontacts.json`],
  // ⚠️ **这两份是抽好的语料，不是原始数据**（2026-10-10 加）。
  //
  // 上面那条「基准不全 → 假问题」的原话又应验了一次：`cipher-people` 里
  // 「帮我照顾下小窝那群孩子」出自短信，原始 `messageconversations.json`
  // 里有它，所以能查到；但 `hyacine-people` 里「只允许悲伤一会儿」也是短信里的，
  // 按同一份原始数据本该查到 —— 之所以先报成「查不到」，
  // 是**归一化把 `{NICKNAME}` 删掉**而语料里那处写着开拓者的真名（见下面 normalise）。
  //
  // 这两份语料是把原始数据摊平后的版本，行号稳定、`{NICKNAME}` 原样保留，
  // 因此既补上支线（原始 `MainMission` 不在上面任何一份里），也让复核时能直接定位到行。
  ['支线剧情', `${ROOT}/corpus-src/amphoreus-side-stories.md`],
  ['短信（抽好的语料）', `${ROOT}/corpus-src/message-conversations.md`]
];

/**
 * 归一化：把「同一句话的两种写法」抹平。
 *
 * 只做**确定**的替换 —— 占位符、markdown 标记、标点、空白。
 * 不做同义改写，那会让核查变成模糊匹配，而模糊匹配查不出编造。
 *
 * ⚠️ 星号必须去掉。语料里是 `*明天见*…是世上最伟大的预言。` ——
 * 那是 markdown 的斜体标记，而第一版没管它，于是带斜体的那几句
 * 全被判成「查不到」，包括缇宝那句最要紧的话。
 */
function normalise(text) {
  return String(text)
    .replace(/\{NICKNAME\}/g, '')
    .replace(/<[^>]{0,60}>/g, '')
    .replace(/[*_`]/g, '')
    .replace(/[，。！？；：、…—―～~·「」『』（）()《》〈〉“”‘’"'!?,.;:]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

const corpus = [];
for (const [label, file] of SOURCES) {
  if (!existsSync(file)) { corpus.push({ label, text: '', missing: true }); continue; }
  corpus.push({ label, text: normalise(readFileSync(file, 'utf8')), missing: false });
}
const haystack = corpus.map((s) => s.text).join('\n');

const book = yaml.load(readFileSync(`${ROOT}/worldbook/entries.yaml`, 'utf8'));
const entries = [...(book.always ?? []), ...(book.entries ?? [])];

/** 抽出条目里所有长度够的引号内容。 */
function quotesOf(text) {
  const out = [];
  for (const match of String(text).matchAll(/「([^」]{2,120})」/g)) out.push(match[1]);
  for (const match of String(text).matchAll(/『([^』]{2,120})』/g)) out.push(match[1]);
  return out.map((q) => q.trim()).filter((q) => normalise(q).length >= MIN);
}

const rows = [];
for (const entry of entries) {
  const quotes = quotesOf(entry.text);
  if (quotes.length === 0) continue;
  const missing = quotes.filter((quote) => {
    const needle = normalise(quote);
    if (needle.length === 0) return false;
    if (haystack.includes(needle)) return false;
    // 长引文常常是拼接的（两句话中间省略了），退一步查它的前半段。
    if (needle.length > 16 && haystack.includes(needle.slice(0, 16))) return false;
    return true;
  });
  if (missing.length > 0) rows.push({ id: entry.id, quotes: quotes.length, missing });
}

if (AS_JSON) {
  console.log(JSON.stringify({ sources: corpus.map((s) => ({ label: s.label, missing: s.missing, chars: s.text.length })), rows }, null, 1));
} else {
  console.log('\n  基准语料：');
  for (const source of corpus) {
    console.log(`    ${source.missing ? '缺失' : '    '} ${source.label.padEnd(6)} ${source.text.length.toLocaleString()} 字`);
  }
  const total = entries.reduce((sum, entry) => sum + quotesOf(entry.text).length, 0);
  const bad = rows.reduce((sum, row) => sum + row.missing.length, 0);
  console.log(`\n  条目 ${entries.length} 条，抽出引文 ${total} 处（≥${MIN} 字），查不到出处的 ${bad} 处`);
  if (bad === 0) {
    console.log('  全部能在语料里找到。');
  } else {
    console.log('\n  ⚠️ 下面这些引文在语料里搜不到。**不一定是编的** ——');
    console.log('     条目里也会用引号括一个概括，文本分不出「逐字引用」和「转述」。');
    console.log('     逐条核对：是引用就补出处，是转述就把引号去掉。\n');
    for (const row of rows) {
      console.log(`    ${row.id}  （${row.missing.length}/${row.quotes} 处查不到）`);
      for (const quote of row.missing) console.log(`        「${quote.slice(0, 56)}${quote.length > 56 ? '…' : ''}」`);
    }
  }
  console.log('');
}
