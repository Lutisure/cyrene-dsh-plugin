/**
 * 按「播放顺序」重建翁法罗斯主线剧情。
 *
 * 旧的抽取法（枚举 Story/Discussion/*.json 里的句子 ID）丢了两样东西：
 *   1. 分支之间的先后关系——那些文件存的是场景图，不是脚本；
 *   2. 玩家选项和旁白的区别——两者都没有说话人。
 *
 * 正确的顺序在 `OnStartSequece[i].TaskList[j]` 里，逐层走就是播放顺序。
 * 选项单独存在 `RPG.GameCore.PlayOptionTalk.OptionList[].TalkSentenceID`。
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

// 数据目录：默认在仓库的 .data/hsr（不进 git），可用 HSR_DATA 覆盖。
// 早先放在 %TEMP% 里，那会被系统清理掉。
const DIR = (process.env.HSR_DATA ?? `${REPO_ROOT}/.data/hsr`).replace(/\\\\/g, '/');
const OUT = `${REPO_ROOT}/cyrene-agent/corpus-src`;

// ── 载入文本 ────────────────────────────────────────────────────────────
const tm = JSON.parse(readFileSync(join(DIR, 'TextMapCHS.json'), 'utf8'));

const cfg = new Map();
for (const b of readFileSync(join(DIR, 'TalkSentenceConfig.json'), 'utf8').split(/\n  \},?\n  \{|\n  \}\n\]/)) {
  const id = /"TalkSentenceID":\s*(\d+)/.exec(b)?.[1];
  const th = /"TalkSentenceText":\s*\{\s*"Hash":\s*(\d+)/.exec(b)?.[1];
  if (!id || !th) continue;
  cfg.set(id, { textH: th, nameH: /"TextmapTalkSentenceName":\s*\{\s*"Hash":\s*(\d+)/.exec(b)?.[1] ?? null });
}

const clean = (s) => String(s)
  .replace(/\{RUBY_B#[^}]*\}([^{]*)\{RUBY_E#\}/g, '$1')
  .replace(/\{RUBY_B#[^}]*\}/g, '').replace(/\{RUBY_E#\}/g, '')
  .replace(/\{NICKNAME\}/g, '开拓者')
  .replace(/\{F#([^}]*)\}\{M#([^}]*)\}/g, '$2')
  .replace(/<[^>]{0,60}>/g, '')
  .replace(/\\n/g, ' ')
  .replace(/\{[A-Z]\d?#[^}]{0,30}\}/g, '')
  .trim();

/** 查一句台词。 */
function line(id) {
  const e = cfg.get(String(id));
  if (!e) return null;
  const t = tm[e.textH];
  if (t === undefined) return null;
  return { spk: e.nameH ? (tm[e.nameH] ?? null) : null, text: clean(t) };
}

// ── 章节与任务 ──────────────────────────────────────────────────────────
const chapName = new Map();
for (const b of readFileSync(join(DIR, 'MissionChapterConfig.json'), 'utf8').split(/\n  \},?\n  \{|\n  \}\n\]/)) {
  const id = /"ID":\s*(\d+)/.exec(b)?.[1];
  if (!id) continue;
  const sh = /"StageName":\s*\{\s*"Hash":\s*(\d+)/.exec(b)?.[1];
  const nh = /"ChapterName":\s*\{\s*"Hash":\s*(\d+)/.exec(b)?.[1];
  chapName.set(id, { stage: sh ? tm[sh] : null, name: nh ? tm[nh] : null });
}

const missions = new Map();
for (const b of readFileSync(join(DIR, 'MainMission.json'), 'utf8').split(/\n  \},?\n  \{|\n  \}\n\]/)) {
  const id = /"MainMissionID":\s*(\d+)/.exec(b)?.[1];
  if (!id) continue;
  const nh = /"Name":\s*\{\s*"Hash":\s*(\d+)/.exec(b)?.[1];
  missions.set(id, {
    type: /"Type":\s*"([^"]+)"/.exec(b)?.[1],
    chap: /"ChapterID":\s*(\d+)/.exec(b)?.[1] ?? null,
    name: nh ? tm[nh] : null,
  });
}

// 翁法罗斯章节，按剧情顺序
const CHAPTERS = ['104001', '104002', '104003', '104004', '104005', '104007', '104008', '104010'];
const ROOTS = [join(DIR, 'TurnBasedGameData/Story/Discussion/Mission'), join(DIR, 'TurnBasedGameData/Story/Mission')];

// ── 走一个场景图 ────────────────────────────────────────────────────────
/**
 * 按顺序展开一拍的 TaskList。
 * 返回 [{kind:'line'|'option', id}]，顺序即播放顺序。
 */
function walkBeat(beat) {
  const out = [];
  const visit = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) visit(x); return; }

    // 选项表：这是玩家做选择的时刻，TalkSentenceID 是选项文本。
    // TriggerCustomString 是这个选项触发的回应——之前丢掉了，于是选项和回应
    // 只能并排列出，读者要自己猜哪句应哪个选项。现在带上，渲染时标出来。
    if (node.$type === 'RPG.GameCore.PlayOptionTalk' && Array.isArray(node.OptionList)) {
      for (const o of node.OptionList) {
        if (o?.TalkSentenceID === undefined) continue;
        const trig = /^TalkSentence_(\d+)$/.exec(o.TriggerCustomString ?? '')?.[1] ?? null;
        out.push({ kind: 'option', id: String(o.TalkSentenceID), trigger: trig });
      }
    }

    for (const [k, v] of Object.entries(node)) {
      // 台词引用有两种写法，都要认
      if (typeof v === 'string') {
        const m = /^TalkSentence_(\d+)$/.exec(v);
        if (m) { out.push({ kind: 'line', id: m[1] }); continue; }
      }
      if (k === 'TalkSentenceID' && typeof v === 'number' && node.$type !== 'RPG.GameCore.OptionTalkInfo') {
        out.push({ kind: 'line', id: String(v) });
        continue;
      }
      visit(v);
    }
  };
  visit(beat);
  return out;
}

/** 展开一个文件的全部节拍。 */
function walkFile(json) {
  const seq = [];
  for (const key of ['OnInitSequece', 'OnStartSequece']) {
    const arr = json?.[key];
    if (!Array.isArray(arr)) continue;
    for (const beat of arr) seq.push(...walkBeat(beat));
  }
  return seq;
}

// ── 后缀索引与前缀归属 ──────────────────────────────────────────────────
//
// 只用 9 位 ID。1043665 引用过一个 7 位的 1466500，那是别的编号混进来了，
// 留着会让补全循环从 146 万跑到 1.46 亿。
const idsByPrefix = new Map();
for (const k of cfg.keys()) {
  if (k.length !== 9) continue;
  const p = k.slice(0, 6);
  if (!idsByPrefix.has(p)) idsByPrefix.set(p, []);
  idsByPrefix.get(p).push(Number(k));
}

// 预扫一遍：每个任务显式引用了哪些 ID。
const refdByMission = new Map();
for (const [mid, meta] of missions) {
  if (meta.type !== 'Main' || !CHAPTERS.includes(meta.chap)) continue;
  const s = new Set();
  for (const root of ROOTS) {
    const d = join(root, mid);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith('.json'))) {
      const t = readFileSync(join(d, f), 'utf8');
      for (const m of t.matchAll(/TalkSentence_(\d+)/g)) s.add(m[1]);
      for (const m of t.matchAll(/"TalkSentenceID":\s*(\d+)/g)) s.add(m[1]);
    }
  }
  refdByMission.set(mid, s);
}

// 每个前缀归给引用它最多的任务
const prefixOwner = new Map();
for (const [mid, refd] of refdByMission) {
  const cnt = new Map();
  for (const id of refd) {
    const p = String(id).slice(0, 6);
    cnt.set(p, (cnt.get(p) ?? 0) + 1);
  }
  for (const [p, n] of cnt) {
    const cur = prefixOwner.get(p);
    if (cur === undefined || cur.n < n) prefixOwner.set(p, { mid, n });
  }
}

// ── 生成 ────────────────────────────────────────────────────────────────
const byChapter = new Map();
let stat = { missions: 0, lines: 0, options: 0, chars: 0, optChars: 0, missing: 0, filled: 0, lowConf: 0 };

for (const chap of CHAPTERS) {
  const mine = [...missions.entries()]
    .filter(([, m]) => m.chap === chap && m.type === 'Main')
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  if (!mine.length) continue;

  const out = [];
  for (const [mid, meta] of mine) {
    const script = [];
    const seen = new Set();

    for (const root of ROOTS) {
      const d = join(root, mid);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d).filter((x) => x.endsWith('.json')).sort()) {
        let json;
        try { json = JSON.parse(readFileSync(join(d, f), 'utf8')); } catch { continue; }
        for (const item of walkFile(json)) {
          const key = item.kind + ':' + item.id;
          if (seen.has(key)) continue;      // 分支回放，只留首次
          seen.add(key);
          const l = line(item.id);
          if (!l) { stat.missing++; continue; }
          if (item.kind === 'option') { stat.options++; stat.optChars += l.text.length; script.push({ kind: 'option', id: item.id, spk: null, text: l.text, trigger: item.trigger ?? null }); }
          else { stat.lines++; stat.chars += l.text.length; script.push({ kind: 'line', id: item.id, spk: l.spk, text: l.text }); }
        }
      }
    }

    // ── 补 ID 空号 ──────────────────────────────────────────────────────
    //
    // 游戏里有些台词不在这些 JSON 里：它们由 .playable 时间轴资源播放，
    // 而那是二进制，数据包不含。表现是某句台词只出现半截，例如
    //   「别担心，在这里…『时间』是静止的。」
    // 后面其实还接着「群星陷入了沉默……」，但那句没有任何 JSON 引用它。
    //
    // miHoYo 按场景顺序分配 TalkSentenceID，所以未被引用却落在已引用区间内的
    // ID，就是这些丢失的台词。空号补回来，按 ID 插到相邻位置。
    const refd = refdByMission.get(mid) ?? new Set();
    const nums = [...refd].map(Number).filter((n) => Number.isFinite(n) && String(n).length === 9).sort((a, b) => a - b);
    if (nums.length > 1) {
      // 按「六位前缀」整块补。
      //
      // 走过的三步：
      //   1. 固定上限（连空 ≤20）——漏了 146786301，因为和上一句隔了 68 个空号；
      //   2. 百位块内补 [最小, 最大]——还是漏，因为 301-303 落在该块最小值之下；
      //   3. 现在按六位前缀整块补。实测同前缀下还有 5,150 条在 [最小, 最大]
      //      之外够不到（38 个任务有这种整段，最严重的 1043710 下方压着 289 条）。
      //
      // 前缀可能被两个任务共用（1040205 和 1040206 都用 104027），所以先做归属：
      // 每个前缀归给**引用它最多的那个任务**，其他任务只保留自己显式引用到的行。
      // 否则同一段台词会在两章里各出现一次。
      const owned = new Set();
      for (const p of new Set(nums.map((n) => String(n).slice(0, 6)))) {
        if (prefixOwner.get(p)?.mid === mid) owned.add(p);
      }
      const candidates = new Set(nums);
      for (const p of owned) for (const n of idsByPrefix.get(p) ?? []) candidates.add(n);

      for (const n of [...candidates].sort((a, b) => a - b)) {
        if (refd.has(String(n))) continue;
        const l = line(String(n));
        if (!l || !l.text) continue;
        stat.filled++;
        stat.lines++;
        stat.chars += l.text.length;
        if (!owned.has(String(n).slice(0, 6))) stat.lowConf++;
        script.push({ kind: 'line', id: String(n), spk: l.spk, text: l.text, filled: true });
      }
      // 按 ID 排回播放顺序
      script.sort((a, b) => {
        const x = Number(a.id ?? 0), y = Number(b.id ?? 0);
        if (x === 0 || y === 0) return 0;
        return x - y;
      });
    }

    if (!script.length) continue;
    stat.missions++;
    out.push({ mid, name: meta.name, script });
  }
  if (!out.length) continue;
  const info = chapName.get(chap);
  byChapter.set(chap, { info, missions: out });
}

// ── 排版 ────────────────────────────────────────────────────────────────
const md = [];
md.push('# 翁法罗斯 · 主线剧情全文', '');
md.push('> 崩坏：星穹铁道 游戏内文本（本地提取）。只在本地自用，不分发。', '>');
md.push('> **顺序**：按 `OnStartSequece[i].TaskList[j]` 逐层展开，即播放顺序。', '>');
md.push('> **分支**：同一句只在首次出现时保留。玩家的选项以 `〔选项〕` 标出，', '>');
md.push('> **选项与回应已配对**：每个选项下面用 ↳ 标出它触发的那句。多个选项通向同一句时', '>');
md.push('> 合并成一条「以上都通向」。被标出的那句不再在正文里重复出现。', '>');
md.push('> **范围**：只含 `Type: Main` 的主线任务，不含支线（翁法罗斯纪事）与活动章节。', '');

for (const [chap, { info, missions: ms }] of byChapter) {
  const cl = ms.reduce((s, m) => s + m.script.filter((x) => x.kind === 'line').reduce((a, x) => a + x.text.length, 0), 0);
  md.push('', `# ${info.name}`, '', `> ${ms.length} 个任务 · ${cl.toLocaleString()} 字`, '');
  for (const m of ms) {
    md.push('', `## ${m.name ?? m.mid}　\`${m.mid}\``, '');
    let optBuf = [];
    // 已经作为选项的回应展示过的行，正文里不再重复一次。
    const consumed = new Set();
    const flush = () => {
      if (!optBuf.length) return;
      md.push('〔选项〕', '');
      // 各选项通向不同回应时，逐个标；全部通向同一句时，只标一次，免得重复。
      const trigs = optBuf.map((o) => o.trigger).filter(Boolean);
      const shared = trigs.length === optBuf.length && new Set(trigs).size === 1 ? trigs[0] : null;
      for (const o of optBuf) {
        md.push(`　· ${o.text}`);
        if (shared !== null || o.trigger === null) continue;
        const r = line(o.trigger);
        if (r) {
          consumed.add(String(o.trigger));
          md.push(`　　↳ ${r.spk ? `**【${r.spk}】** ` : ''}${r.text}`);
        }
      }
      if (shared !== null) {
        const r = line(shared);
        if (r) {
          consumed.add(String(shared));
          md.push(`　　↳ 以上都通向：${r.spk ? `**【${r.spk}】** ` : ''}${r.text}`);
        }
      }
      md.push('');
      optBuf = [];
    };
    for (const x of m.script) {
      if (x.kind === 'option') { optBuf.push(x); continue; }
      flush();
      if (x.id !== undefined && consumed.has(String(x.id))) continue;
      md.push(x.spk ? `**【${x.spk}】** ${x.text}` : `　　${x.text}`);
    }
    flush();
  }
}

writeFileSync(join(OUT, 'amphoreus-main-story.md'), md.join('\n'));
console.log('任务 ' + stat.missions + ' 个');
console.log('台词 ' + stat.lines.toLocaleString() + ' 句  ' + stat.chars.toLocaleString() + ' 字');
console.log('选项 ' + stat.options.toLocaleString() + ' 条  ' + stat.optChars.toLocaleString() + ' 字');
console.log('对不上文本的 ' + stat.missing + ' 条');
console.log('按 ID 空号补回的 ' + stat.filled.toLocaleString() + ' 句（其中低置信 ' + stat.lowConf.toLocaleString() + ' 句）');
console.log('');
for (const [, v] of byChapter) {
  const L = v.missions.reduce((s, m) => s + m.script.filter((x) => x.kind === 'line').length, 0);
  const O = v.missions.reduce((s, m) => s + m.script.filter((x) => x.kind === 'option').length, 0);
  const C = v.missions.reduce((s, m) => s + m.script.filter((x) => x.kind === 'line').reduce((a, x) => a + x.text.length, 0), 0);
  console.log('  ' + v.info.name.padEnd(12) + ' ' + String(v.missions.length).padStart(2) + ' 任务  ' +
    String(L).padStart(4) + ' 句  ' + String(C).padStart(6) + ' 字  ' + String(O).padStart(4) + ' 选项');
}
console.log('');
console.log('已写 amphoreus-main-story.md  ' + Math.round(md.join('\n').length / 1024) + ' KB');
