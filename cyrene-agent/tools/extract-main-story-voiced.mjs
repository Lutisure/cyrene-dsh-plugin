/**
 * 翁法罗斯主线剧情 —— 用「语音路径」重建。
 *
 * 前四版都在猜 ID 的规律（区间、百位块、六位前缀），全部失败。真正的钥匙在
 * VoiceConfig 的 VoicePath 里：
 *
 *   VoiceID 146786233 → chapter4_75_cyrene_121
 *   VoiceID 146787401 → chapter4_75_cyrene_122     ← 接在 121 后面，但 ID 隔了一个块
 *
 * 连字符后面是场景名（chapter4_75）、角色、序号。这条信息给出两件之前拿不到的东西：
 *
 *   1. 归属——哪些 ID 属于同一个场景，不用再猜前缀；
 *   2. 顺序——序号就是播放顺序，而 ID 顺序不是。
 *      实证：cyrene_186 是 TS 146787528，cyrene_191 是 TS 146787417，ID 反而变小。
 *
 * 覆盖不到的部分：没配音的旁白不在 VoiceConfig 里（cyrene 的序号 101~192 里有
 * 16 个断号），那些仍然靠 ID 补，按「ID 最近的上一句」插进去。
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

// ── 文本 ────────────────────────────────────────────────────────────────
const tm = JSON.parse(readFileSync(join(DIR, 'TextMapCHS.json'), 'utf8'));

const cfg = new Map();
for (const b of readFileSync(join(DIR, 'TalkSentenceConfig.json'), 'utf8').split(/\n  \},?\n  \{|\n  \}\n\]/)) {
  const id = /"TalkSentenceID":\s*(\d+)/.exec(b)?.[1];
  const th = /"TalkSentenceText":\s*\{\s*"Hash":\s*(\d+)/.exec(b)?.[1];
  if (!id || !th) continue;
  cfg.set(id, {
    textH: th,
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
  .replace(/\\n/g, ' ')
  .replace(/\{[A-Z]\d?#[^}]{0,30}\}/g, '')
  .trim();

function line(id) {
  const e = cfg.get(String(id));
  if (!e) return null;
  const t = tm[e.textH];
  if (t === undefined) return null;
  return { spk: e.nameH ? (tm[e.nameH] ?? null) : null, text: clean(t) };
}

// ── 语音路径 ────────────────────────────────────────────────────────────
const voicePath = new Map();
for (const b of readFileSync(join(DIR, 'VoiceConfig.json'), 'utf8').split(/\n  \},?\n  \{|\n  \}\n\]/)) {
  const id = /"VoiceID":\s*(\d+)/.exec(b)?.[1];
  const p = /"VoicePath":\s*"([^"]*)"/.exec(b)?.[1];
  if (id && p) voicePath.set(id, p);
}

// VoiceID → TalkSentenceID（反向索引）
const tsByVoice = new Map();
for (const [id, e] of cfg) if (e.voice && voicePath.has(e.voice)) tsByVoice.set(e.voice, id);

// 场景 → [{id, who, seq}]，按序号排好
const scenes = new Map();
for (const [vid, p] of voicePath) {
  const m = /^(.+?)_([A-Za-z0-9]+)_(\d+)$/.exec(p);
  if (!m) continue;
  const id = tsByVoice.get(vid);
  if (id === undefined) continue;
  const scene = m[1];
  if (!scenes.has(scene)) scenes.set(scene, []);
  scenes.get(scene).push({ id, who: m[2], seq: Number(m[3]) });
}
for (const arr of scenes.values()) arr.sort((a, b) => a.seq - b.seq);

// 每个场景的 ID 跨度（用来捞没配音的旁白）
const sceneSpan = new Map();
for (const [scene, arr] of scenes) {
  const ids = arr.map((x) => Number(x.id));
  sceneSpan.set(scene, [Math.min(...ids), Math.max(...ids)]);
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

const CHAPTERS = ['104001', '104002', '104003', '104004', '104005', '104007', '104008', '104010'];
const ROOTS = [join(DIR, 'TurnBasedGameData/Story/Discussion/Mission'), join(DIR, 'TurnBasedGameData/Story/Mission')];

// 每个任务引用了哪些 ID
const refdByMission = new Map();
const optionByMission = new Map();
const optGroup = new Map();
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
  // 选项也要单独认出来：它们存在 PlayOptionTalk.OptionList[].TalkSentenceID
  const opts = new Set();
  let group = 0;
  for (const root of ROOTS) {
    const d = join(root, mid);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith('.json'))) {
      const t = readFileSync(join(d, f), 'utf8');
      let j;
      try { j = JSON.parse(t); } catch { continue; }
      const walk = (o) => {
        if (o === null || typeof o !== 'object') return;
        if (Array.isArray(o)) { for (const x of o) walk(x); return; }
        if (o.$type === 'RPG.GameCore.PlayOptionTalk' && Array.isArray(o.OptionList)) {
          group += 1;
          for (const op of o.OptionList) if (op?.TalkSentenceID !== undefined) { opts.add(String(op.TalkSentenceID)); optGroup.set(String(op.TalkSentenceID), mid + '#' + group); }
        }
        for (const v of Object.values(o)) walk(v);
      };
      walk(j);
    }
  }
  optionByMission.set(mid, opts);
  refdByMission.set(mid, s);
}

// 场景归属：每个场景归给引用它最多的任务
const sceneOwner = new Map();
for (const [mid, refd] of refdByMission) {
  const cnt = new Map();
  for (const id of refd) {
    const e = cfg.get(String(id));
    if (!e?.voice) continue;
    const p = voicePath.get(e.voice);
    if (!p) continue;
    const m = /^(.+?)_[A-Za-z0-9]+_\d+$/.exec(p);
    if (!m) continue;
    cnt.set(m[1], (cnt.get(m[1]) ?? 0) + 1);
  }
  for (const [scene, n] of cnt) {
    const cur = sceneOwner.get(scene);
    if (cur === undefined || cur.n < n) sceneOwner.set(scene, { mid, n });
  }
}

// ── 生成 ────────────────────────────────────────────────────────────────
const byChapter = new Map();
let stat = { missions: 0, lines: 0, options: 0, chars: 0, filled: 0 };

for (const chap of CHAPTERS) {
  const mine = [...missions.entries()]
    .filter(([, m]) => m.chap === chap && m.type === 'Main')
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  if (!mine.length) continue;

  const out = [];
  for (const [mid, meta] of mine) {
    const refd = refdByMission.get(mid) ?? new Set();
    const script = [];
    const seen = new Set();

    // 本任务拥有的场景
    const myScenes = new Set();
    for (const id of refd) {
      const e = cfg.get(String(id));
      if (!e?.voice) continue;
      const p = voicePath.get(e.voice);
      if (!p) continue;
      const m = /^(.+?)_[A-Za-z0-9]+_\d+$/.exec(p);
      if (m && sceneOwner.get(m[1])?.mid === mid) myScenes.add(m[1]);
    }

    // 1) 本任务显式引用到的行，带上它在场景里的序号
    const placed = [];               // {id, kind, spk, text, scene, seq}
    for (const id of refd) {
      const l = line(id);
      if (!l) continue;
      const e = cfg.get(String(id));
      let scene = null, seq = null;
      if (e?.voice) {
        const p = voicePath.get(e.voice);
        const m = p ? /^(.+?)_[A-Za-z0-9]+_(\d+)$/.exec(p) : null;
        if (m) { scene = m[1]; seq = Number(m[2]); }
      }
      const isOpt = (optionByMission.get(mid) ?? new Set()).has(String(id));
      placed.push({ id: String(id), kind: isOpt ? 'option' : 'line', spk: isOpt ? null : l.spk, text: l.text, scene, seq, grp: isOpt ? (optGroup.get(String(id)) ?? null) : null });
    }

    // 2) 本任务拥有的场景里的全部台词
    for (const scene of myScenes) {
      for (const { id, seq } of scenes.get(scene) ?? []) {
        if (refd.has(String(id))) continue;
        const l = line(id);
        if (!l) continue;
        const isOpt = (optionByMission.get(mid) ?? new Set()).has(String(id));
      placed.push({ id: String(id), kind: isOpt ? 'option' : 'line', spk: isOpt ? null : l.spk, text: l.text, scene, seq, grp: isOpt ? (optGroup.get(String(id)) ?? null) : null });
      }
      // 3) 场景跨度里没配音的旁白：按 ID 最近的上一句插进去。
      //
      // 必须给跨度设上限：场景的 ID 跨度可能极大（实测有跨到上亿的），
      // 逐个 ID 扫会跑不完——第一版就是这么卡死的。这里限制在两个条件内：
      // 跨度不超过 3000，且逐个 ID 只做一次二分查找，不线性扫 placed。
      const [lo, hi] = sceneSpan.get(scene) ?? [0, -1];
      if (hi - lo <= 3000) {
        const sortedIds = placed.map((p) => Number(p.id)).sort((a, b) => a - b);
        const anchorOf = (target) => {
          let a = null, l = 0, r = sortedIds.length - 1;
          while (l <= r) {
            const m = (l + r) >> 1;
            if (sortedIds[m] < target) { a = sortedIds[m]; l = m + 1; } else r = m - 1;
          }
          return a;
        };
        for (let i = lo; i <= hi; i++) {
          const e = cfg.get(String(i));
          if (!e) continue;
          if (e.voice && voicePath.has(e.voice)) continue;   // 有配音的已经收过
          if (refd.has(String(i))) continue;
          const l2 = line(String(i));
          if (!l2) continue;
          const aId = anchorOf(i);
          const anchor = aId === null ? null : placed.find((p) => Number(p.id) === aId);
          placed.push({ id: String(i), kind: 'line', spk: l2.spk, text: l2.text, scene, seq: anchor ? anchor.seq : 0 });
          stat.filled++;
        }
      }
    }

    // 排序：先按场景（按场景内最小序号定先后），场景内按序号；同序号按 ID
    const sceneOrder = new Map();
    for (const p of placed) {
      if (p.scene === null) continue;
      const cur = sceneOrder.get(p.scene);
      const min = Math.min(...(scenes.get(p.scene) ?? [{ seq: 0 }]).map((x) => x.seq));
      if (cur === undefined || min < cur) sceneOrder.set(p.scene, min);
    }
    placed.sort((a, b) => {
      const sa = a.scene === null ? 1e9 : (sceneOrder.get(a.scene) ?? 1e9);
      const sb = b.scene === null ? 1e9 : (sceneOrder.get(b.scene) ?? 1e9);
      if (sa !== sb) return sa - sb;
      if ((a.seq ?? 0) !== (b.seq ?? 0)) return (a.seq ?? 0) - (b.seq ?? 0);
      return Number(a.id) - Number(b.id);
    });
    for (const p of placed) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      stat.lines++;
      stat.chars += p.text.length;
      script.push({ kind: p.kind ?? 'line', id: p.id, spk: p.spk, text: p.text, grp: p.grp ?? null });
    }

    if (!script.length) continue;
    stat.missions++;
    out.push({ mid, name: meta.name, script });
  }

  if (!out.length) continue;
  byChapter.set(chap, { info: chapName.get(chap), missions: out });
}

// ── 排版 ────────────────────────────────────────────────────────────────
const md = [];
md.push('# 翁法罗斯 · 主线剧情全文', '');
md.push('> 崩坏：星穹铁道 游戏内文本（本地提取）。只在本地自用，不分发。', '>');
md.push('> **顺序**取自语音文件路径里的序号（`chapter4_75_cyrene_122` 里的 122），', '>');
md.push('> 那才是播放顺序。ID 顺序不是——实证：cyrene_186 是 TS 146787528，', '>');
md.push('> cyrene_191 是 TS 146787417，ID 反而变小。', '>');
md.push('> **归属**同样取自路径里的场景名，不再靠猜 ID 前缀。', '>');
md.push('> **没配音的旁白**不在语音表里，仍靠 ID 补，插在 ID 最近的上一句之后。', '>');
md.push('> **范围**：只含 `Type: Main` 的主线任务，不含支线与活动章节。', '');

for (const [, { info, missions: ms }] of byChapter) {
  const cl = ms.reduce((s, m) => s + m.script.reduce((a, x) => a + x.text.length, 0), 0);
  md.push('', `# ${info.name}`, '', `> ${ms.length} 个任务 · ${cl.toLocaleString()} 字`, '');
  for (const m of ms) {
    md.push('', `## ${m.name ?? m.mid}　\`${m.mid}\``, '');
    let optBuf = [];
    const flush = () => {
      if (!optBuf.length) return;
      md.push('〔选项〕', '');
      for (const o of optBuf) md.push(`　· ${o.text}`);
      md.push('');
      optBuf = [];
    };
    for (const x of m.script) {
      if (x.kind === 'option') {
        if (optBuf.length && optBuf[optBuf.length - 1].grp !== x.grp) flush();
        optBuf.push(x); continue;
      }
      flush();
      md.push(x.spk ? `**【${x.spk}】** ${x.text}` : `　　${x.text}`);
    }
    flush();
  }
}

writeFileSync(join(OUT, 'amphoreus-main-story-voiced.md'), md.join('\n'));
console.log('任务 ' + stat.missions + ' 个');
console.log('台词 ' + stat.lines.toLocaleString() + ' 句  ' + stat.chars.toLocaleString() + ' 字');
console.log('按 ID 补的旁白 ' + stat.filled.toLocaleString() + ' 句');
console.log('已写 amphoreus-main-story-voiced.md  ' + Math.round(md.join('\n').length / 1024) + ' KB');
