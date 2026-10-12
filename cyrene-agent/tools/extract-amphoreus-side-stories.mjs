/**
 * 翁法罗斯纪事（支线）剧情抽取。
 *
 * 用法：
 *   node tools/extract-amphoreus-side-stories.mjs
 *   HSR_DATA=D:/path/to/hsr node tools/extract-amphoreus-side-stories.mjs
 *
 * 数据目录默认 <本仓库>/.data/hsr（不进 git），可用环境变量 HSR_DATA 覆盖。
 * 产物：cyrene-agent/corpus-src/amphoreus-side-stories.md（可重复跑，覆盖写）。
 *
 * ── 和主线脚本（extract-main-story-voiced.mjs）的区别 ────────────────────
 *
 * 主线靠 VoiceConfig 的 VoicePath 定顺序，因为语音序号才是播放顺序。
 * 「翁法罗斯纪事」**整章没有配音**（实测：本章引用的台词，VoiceID 字段一个都没有），
 * 语音那条路在这里完全走不通，所以顺序改用剧情脚本自己的结构定：
 *
 *   1. 任务：MainMission.json 里 ChapterID=500401 且 Type=Branch 的条目，按 MainMissionID 升序
 *   2. 任务内：Discussion 目录下的文件名升序（DS<任务号><两位序号>.json）
 *   3. 文件内：台词块升序，块内按 TalkSentenceID 升序
 *
 * 「台词块」是什么：本章的 ID 是 9 位，前 6 位 + 第 7 位构成一个块，
 * 例如 500041007 属于块 500041|0，范围 500041000~500041099。
 * 一个 DS 文件通常覆盖一到两个块。（实测全章各任务认领的块互不重叠，可以这样切。）
 *
 * 为什么文件内按 ID 排就够：块内 ID 升序读下来是一段连贯的对话，实证——
 *
 *   【刻牢刻】吉奥里亚是哪位神明，大家不会不知道吧？      500041006
 *   【旁白】  吉奥里亚，何方神圣啊？                        500041007
 *   【刻牢刻】磐岩之脊，吉奥里亚，背负一切生灵的泰坦…      500041009
 *
 * 为什么「任务内按文件名排」而不是干脆全按 ID 排：任务是 5000411 时两者不一致，
 * 而以内容判断，**文件名才是对的**——
 *
 *   按文件名：DS500041101（风堇委托送信）→ DS500041102（去老费贝尔家）→ …
 *   按 ID：    500051|1（老费贝尔）… → 500052|3（风堇委托）  ← 委托跑到了最后
 *
 * 其余任务两者恰好同序，所以统一按文件名排。
 *
 * ── 没被 JSON 引用的行怎么补 ─────────────────────────────────────────────
 *
 * 剧情 JSON 只显式引用「分支点」和「时间轴触发点」，一段对话里大多数行是由
 * DS*.playable 时间轴播放的，那些二进制不在数据包里。所以和主线脚本一个办法：
 * 把该文件覆盖的**整个块**里凡是 TalkSentenceConfig 里有正文的条目全部收进来，
 * 按 ID 排。实例：DS500040101 只引用了 18 个 ID，块里实际有 28 句。
 * 没被收的只有「块里有 ID、但表中无正文」的条目。
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---- 仓库根，从本文件的位置推（由 tools/derive-roots.mjs 加的头）----
//
// 以前这里写的是作者机器上的绝对路径。那只在那台机器上成立，
// 而且清洗脚本会把绝对路径换成占位符，于是代码里出现 <本仓库> 这种目录名，直接崩。
import { fileURLToPath as __f } from 'node:url';
import { dirname as __d, join as __j } from 'node:path';
const REPO_ROOT = __j(__d(__f(import.meta.url)), '../..');

const DIR = (process.env.HSR_DATA ?? `${REPO_ROOT}/.data/hsr`).replace(/\\\\/g, '/');
const OUT = new URL('../corpus-src/amphoreus-side-stories.md', import.meta.url).pathname.replace(/^\//, '');

/**
 * 翁法罗斯的支线章节（MainMission.json 的 ChapterID）。
 *
 * ⚠️ 第一版只有一个 `CHAPTER = '500401'`，于是「其余几章没抽」这件事
 * **在脚本里看不见** —— 它的产物看着像「翁法罗斯支线都在这儿了」。
 * 换成一张表之后，抽了哪几章、哪几章没抽，都写在明面上。
 * 每章的 Type 和任务数由脚本自己从 MainMission.json 数出来，不手写。
 */
const CHAPTERS = [
  '500401',   // 翁法罗斯纪事
  '803101',   // 嗷呜嗷呜事务所
  '803201',   // 豹豹碰碰大作战
  '803501',   // 黄金迷境大饭店
  '803601',   // 天气真好，养它！
  '803801',   // 黄金嗷呜大师赛
  '104010',   // 成为昨日的明天（主线章，属于它的是那条 Branch：4340400 帷后，酬酢与秘密）
];
const WANT = new Set(CHAPTERS);

// ── 文本 ────────────────────────────────────────────────────────────────
// TextMapCHS.json 的键是 64 位整数，JSON.parse 会丢精度（16945042163627111568 →
// 16945042163627112000），必须当字符串取。
const tm = new Map();
{
  const t = readFileSync(join(DIR, 'TextMapCHS.json'), 'utf8');
  const re = /^\s*"(\d+)":\s*"((?:[^"\\]|\\.)*)",?\s*$/gm;
  let m;
  while ((m = re.exec(t)) !== null) tm.set(m[1], m[2]);
}

// 值是从原文里切出来的 JSON 字符串体，取的时候再解转义（\u00A0、\n、\" 等）
const unesc = (s) => {
  if (s === undefined) return null;
  try { return JSON.parse('"' + s + '"'); } catch { return s; }
};
const textOf = (h) => (h ? unesc(tm.get(h)) : null);

const cfg = new Map();
for (const b of readFileSync(join(DIR, 'TalkSentenceConfig.json'), 'utf8').split(/\n  \},?\n  \{|\n  \}\n\]/)) {
  const id = /"TalkSentenceID":\s*(\d+)/.exec(b)?.[1];
  if (!id) continue;
  cfg.set(id, {
    textH: /"TalkSentenceText":\s*\{\s*"Hash":\s*(\d+)/.exec(b)?.[1] ?? null,
    nameH: /"TextmapTalkSentenceName":\s*\{\s*"Hash":\s*(\d+)/.exec(b)?.[1] ?? null,
    voice: /"VoiceID":\s*(\d+)/.exec(b)?.[1] ?? null,
  });
}

const clean = (s) => String(s)
  .replace(/\{RUBY_B#[^}]*\}([^{]*)\{RUBY_E#\}/g, '$1')
  .replace(/\{RUBY_B#[^}]*\}/g, '').replace(/\{RUBY_E#\}/g, '')
  .replace(/\{NICKNAME\}/g, '开拓者')
  .replace(/\{F#([^}]*)\}\{M#([^}]*)\}/g, '$2')
  .replace(/<[^>]{0,60}>/g, '')
  .replace(/\s*\n\s*/g, ' ')
  .replace(/\{[A-Z]\d?#[^}]{0,30}\}/g, '')
  .trim();

function line(id) {
  const e = cfg.get(String(id));
  if (!e) return null;
  const t = textOf(e.textH);
  if (t === null) return null;
  return { spk: e.nameH ? (textOf(e.nameH) ?? null) : null, text: clean(t), voice: e.voice ?? null };
}

// ── 任务与章节 ──────────────────────────────────────────────────────────
const blocksOf = (file) => readFileSync(join(DIR, file), 'utf8')
  .split(/\n  \},?\n  \{|\n  \}\n\]|\n\[\n  \{/);
const hashOf = (b, field) => new RegExp(`"${field}":\\s*\\{\\s*"Hash":\\s*(\\d+)`).exec(b)?.[1] ?? null;

const chapName = new Map();
for (const b of blocksOf('MissionChapterConfig.json')) {
  const id = /"ID":\s*(\d+)/.exec(b)?.[1];
  if (!id) continue;
  chapName.set(id, {
    name: textOf(hashOf(b, 'ChapterName')),
    stage: textOf(hashOf(b, 'StageName')),
  });
}

const missions = [];
for (const b of blocksOf('MainMission.json')) {
  const id = /"MainMissionID":\s*(\d+)/.exec(b)?.[1];
  if (!id) continue;
  const chap = /"ChapterID":\s*(\d+)/.exec(b)?.[1] ?? null;
  if (chap === null || !WANT.has(chap)) continue;
  // 104010 是主线章，只收它下面那条 Branch（「帷后，酬酢与秘密」），
  // 主线本身在 extract-main-story-voiced.mjs 里，别在这儿重复抽。
  if ((/"Type":\s*"([^"]+)"/.exec(b)?.[1] ?? null) !== 'Branch') continue;
  missions.push({ id, chap, name: textOf(hashOf(b, 'Name')) });
}
missions.sort((a, b) => Number(a.id) - Number(b.id));

const ROOTS = [join(DIR, 'TurnBasedGameData/Story/Discussion/Mission'), join(DIR, 'TurnBasedGameData/Story/Mission')];

// ── 生成 ────────────────────────────────────────────────────────────────
const FOOT = ['　· ', '　　'];           // 选项行 / 旁白行的前缀
const out = [];
let stat = { missions: 0, files: 0, lines: 0, named: 0, unnamed: 0, options: 0, voiced: 0, chars: 0, ids: 0 };

for (const [mid, name, chap] of missions.map((m) => [m.id, m.name, m.chap])) {
  const dirs = ROOTS.map((r) => join(r, mid)).filter((d) => existsSync(d));
  if (!dirs.length) continue;                       // 空壳任务（无剧情文件）

  const seen = new Set();                           // 本任务已输出的 ID
  const script = [];

  for (const d of dirs) {
    for (const f of readdirSync(d).filter((x) => x.endsWith('.json')).sort()) {
      const t = readFileSync(join(d, f), 'utf8');
      stat.files++;

      // 本文件引用到的 ID，以及它们落在哪些块里
      const refd = new Set();
      for (const m of t.matchAll(/TalkSentence_(\d+)/g)) refd.add(m[1]);
      for (const m of t.matchAll(/"TalkSentenceID":\s*(\d+)/g)) refd.add(m[1]);
      const blocks = new Set();
      for (const id of refd) {
        if (String(id).length !== 9) continue;
        blocks.add(String(id).slice(0, 6) + '|' + String(id)[6]);
      }
      if (!blocks.size) continue;

      // 选项组：PlayOptionTalk.OptionList[].TalkSentenceID
      let grp = 0;
      const optGrp = new Map();
      try {
        const walk = (o) => {
          if (o === null || typeof o !== 'object') return;
          if (Array.isArray(o)) { for (const x of o) walk(x); return; }
          if (o.$type === 'RPG.GameCore.PlayOptionTalk' && Array.isArray(o.OptionList)) {
            grp += 1;
            for (const op of o.OptionList) if (op?.TalkSentenceID !== undefined) optGrp.set(String(op.TalkSentenceID), mid + '#' + grp);
          }
          for (const v of Object.values(o)) walk(v);
        };
        walk(JSON.parse(t));
      } catch { /* 不是合法 JSON 就当作没有选项 */ }

      // 块内全量：块里凡是有正文的条目都收
      const ids = [];
      for (const b of [...blocks].sort()) {
        const head = b.slice(0, 6) + b.slice(7);
        for (let i = Number(head + '00'); i <= Number(head + '99'); i++) {
          if (seen.has(String(i))) continue;
          const e = cfg.get(String(i));
          if (!e?.textH) continue;
          if (textOf(e.textH) === null) continue;
          ids.push(String(i));
        }
      }
      ids.sort((a, b) => Number(a) - Number(b));
      for (const id of ids) script.push({ id, opt: optGrp.get(id) ?? null, file: f });
    }
  }

  if (!script.length) continue;

  // ── 排版（照 amphoreus-main-story-voiced.md 的写法） ──
  const body = [];
  let optBuf = [];
  const flush = () => {
    if (!optBuf.length) return;
    body.push('〔选项〕', '');
    for (const o of optBuf) body.push(`${FOOT[0]}${o.text}`);
    body.push('');
    optBuf = [];
  };
  for (const x of script) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    const l = line(x.id);
    if (!l) continue;
    stat.lines++;
    stat.chars += l.text.length;
    if (l.voice) stat.voiced++;
    if (x.opt) {
      stat.options++;
      if (optBuf.length && optBuf[optBuf.length - 1].grp !== x.opt) flush();
      optBuf.push({ grp: x.opt, text: l.text });
      continue;
    }
    flush();
    if (l.spk) { stat.named++; body.push(`**【${l.spk}】** ${l.text}`); }
    else { stat.unnamed++; body.push(`${FOOT[1]}${l.text}`); }
  }
  flush();

  if (!body.length) continue;
  stat.missions++;
  out.push({ mid, name, chap, body });
}

// ── 写文件 ──────────────────────────────────────────────────────────────
const md = [];
md.push('# 翁法罗斯 · 支线全文（多章节）', '');
md.push('> 崩坏：星穹铁道 游戏内文本（本地提取）。只在本地自用，不分发。', '>');
md.push('> **范围**：`MainMission.json` 里下列 `ChapterID` 且 `Type=Branch` 的任务。',
        '> 每章的任务数由脚本从 `MainMission.json` 自己数出来，不手写：', '>');
for (const c of CHAPTERS) {
  const info = chapName.get(c) ?? {};
  const all = missions.filter((m) => m.chap === c);
  const got = out.filter((m) => m.chap === c);
  md.push(`> - \`${c}\`　**${info.name ?? '(无章节名)'}**　${info.stage ?? ''}　` +
    `${got.length}/${all.length} 个任务有正文`);
}
md.push('>');
md.push('> ⚠️ **这份文件只覆盖上面列出的章节。** 其余支线章节（仙舟、匹诺康尼、二相乐园…）',
        '> 与 `Type` 为 `Main` / `Gap` / `Daily` / `Companion` 的内容都不在里面。',
        '> 「抽了哪几章」写在脚本的 `CHAPTERS` 表里 —— **要看是否漏了东西，去看那张表**。', '>');
md.push('> **顺序**：章节按 `CHAPTERS` 表的顺序；章内任务按 `MainMissionID` 升序；',
        '> 任务内按 `Story/Discussion/Mission/<任务号>/` 下的文件名升序（`DS<任务号><两位序号>.json`）；',
        '> 文件内按台词块升序（ID 前 6 位 + 第 7 位，如 `500041007` 属于块 `500041|0`），',
        '> 块内按 `TalkSentenceID` 升序。', '>');
md.push('> **为什么不用语音序号**：这几章实测几乎没有配音，`TalkSentenceConfig` 里 `VoiceID` 稀少，',
        '> 主线那套 `VoicePath` 定序的办法在这里不适用。', '>');
md.push('> **没被剧情 JSON 显式引用的行**：剧情文件只标注分支点和时间轴触发点，其余行由',
        '> `DS*.playable` 时间轴播放，那些二进制不在数据包里。因此把该文件覆盖的整个台词块里',
        '> 凡是在 `TalkSentenceConfig` 中有正文的条目全部收进来，按 ID 排。', '>');
md.push('> **说话人**：取自 `TextmapTalkSentenceName`。没有该字段的行（旁白、玩家选项）',
        '> 按主线语料的写法缩进排在下面；选项行归入 `〔选项〕` 段。', '');
md.push('');

let lastChap = null;
for (const { mid, name, chap, body } of out) {
  if (chap !== lastChap) {
    const info = chapName.get(chap) ?? {};
    md.push('', `# 章节 ${chap}　${info.name ?? '(无章节名)'}`, '');
    lastChap = chap;
  }
  md.push('', `## ${name ?? '(无任务名)'}　\`${mid}\``, '');
  md.push(...body);
}

const file = OUT;
writeFileSync(file, md.join('\n'), 'utf8');
for (const c of CHAPTERS) {
  const info = chapName.get(c) ?? {};
  const all = missions.filter((m) => m.chap === c);
  const got = out.filter((m) => m.chap === c);
  console.log(`  ${c}  ${(info.name ?? '(无章节名)').padEnd(16)} ${got.length}/${all.length} 个任务有正文`);
}
console.log('任务 ' + stat.missions + '/' + missions.length + ' 个有正文');
console.log('DS 文件 ' + stat.files + ' 个');
console.log('台词 ' + stat.lines.toLocaleString() + ' 句  ' + stat.chars.toLocaleString() + ' 字');
console.log('　有说话人 ' + stat.named.toLocaleString() + ' 句 / 无人名 ' + stat.unnamed.toLocaleString() + ' 句 / 选项 ' + stat.options.toLocaleString() + ' 句');
console.log('　其中有配音的 ' + stat.voiced + ' 句');
console.log('已写 ' + file + '  ' + Math.round(md.join('\n').length / 1024) + ' KB');
