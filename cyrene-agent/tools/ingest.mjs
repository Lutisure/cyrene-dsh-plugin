#!/usr/bin/env node
/**
 * Distil a raw dialogue dump into persona data.
 *
 * The problem this solves is not "find the text" but "the text is far too big
 * to put in a prompt". A character's full dialogue run is hundreds of
 * thousands of characters; pasting that into a system prompt is expensive on
 * every single turn and makes the model *worse*, not better, because the
 * signal drowns. So this tool does three separate jobs:
 *
 *   1. clean and filter — strip the game's inline markup, keep only the
 *      character's own lines, drop duplicates and noise;
 *   2. measure — descriptive statistics that tell you what her voice actually
 *      is (median line length, punctuation habits, ending particles, recurring
 *      phrases), so the persona rules are read off the data instead of guessed;
 *   3. select — a small, deliberately *diverse* set of her own lines to use as
 *      voice reference, because 12 varied lines calibrate better than 500
 *      near-identical ones.
 *
 * What it deliberately does not do: invent two-sided examples. Game dialogue
 * is one-sided — you see her line, not the prompt that produced it — so the
 * output goes into `dialogues.yaml`'s `voiceSamples`, not into `dialogues`.
 *
 * Usage:
 *   node tools/ingest.mjs --in <file...> [options]
 *
 * Options:
 *   --in <file...>        one or more raw dumps
 *   --format <f>          auto | pairs | textmap | text      (default auto)
 *   --aliases <list>      comma-separated speaker names to keep (default 昔涟,昔漣,Cyrene)
 *   --out <dir>           output directory                   (default corpus)
 *   --samples <n>         how many voice samples to select   (default 24)
 *   --min-length <n>      drop lines shorter than this       (default 3)
 *   --max-length <n>      drop lines longer than this        (default 220)
 *   --keep-noise          keep UI/system-looking lines
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';

/**
 * Defaults for the filtering pass.
 *
 * Kept as a plain object rather than module-level CLI state so the units below
 * stay importable — argument parsing happens only when this file is executed.
 */
const DEFAULTS = Object.freeze({
  aliases: ['昔涟', '昔漣', 'Cyrene'],
  samples: 24,
  minLength: 3,
  maxLength: 220,
  keepNoise: false
});

/** Read a repeatable/valued CLI flag. */
function flag(argv, name, fallback) {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
}

/** Read a repeatable CLI flag. */
function flagAll(argv, name) {
  const out = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === `--${name}` && argv[index + 1] !== undefined) out.push(argv[index + 1]);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Cleaning
 * ------------------------------------------------------------------ */

/**
 * Inline markup removal, in order.
 *
 * `count` is tracked per rule so the report can show what actually fired —
 * a cleaner you cannot audit is a cleaner you cannot trust with a corpus.
 * Deliberately no catch-all "strip every brace" rule: an over-eager rule
 * silently eats real dialogue, so leftover braces are *reported* instead.
 */
const RULES = [
  // {RUBY_B#reading}surface{RUBY_E#} — keep the surface form, drop the reading.
  { name: 'ruby', pattern: /\{RUBY_B#[^}]*\}([^{}]*)\{RUBY_E#\}/gu, replace: '$1' },
  { name: 'ruby-orphan', pattern: /\{RUBY_[A-Z]+#[^}]*\}/gu, replace: '' },
  // Address placeholders become 「你」 rather than vanishing. Deleting them left
  // sentences like 「嘻，那就期待的精彩表现啦」 — the addressee was gone and the
  // line was no longer grammatical, which then went into the persona as an
  // example of how she talks.
  { name: 'name-placeholder', pattern: /\{(?:NICKNAME|PLAYERNAME|PLAYER_NAME|昵称)\}/gu, replace: '你' },
  // Emote / sticker markers the message system stores inline: [求摸摸].
  // Restricted to CJK-only content so a real bracketed word is not eaten.
  { name: 'emote-marker', pattern: /\[[\u3040-\u30ff\u4e00-\u9fff]{2,8}\]/gu, replace: '' },
  // Formatting tags: drop the tag, keep the text inside.
  { name: 'color-tag', pattern: /<\/?color(?:=[^>]*)?>/giu, replace: '' },
  { name: 'format-tag', pattern: /<\/?(?:b|i|u|s|size|align|unbreak|material|space|line-height)(?:=[^>]*)?>/giu, replace: '' },
  // Engine variables: {TEXTJOIN#12}, {#12}, {MISSION_NAME}.
  { name: 'engine-var', pattern: /\{[A-Z_]*#\d+(?:#[^}]*)?\}/gu, replace: '' },
  { name: 'named-var', pattern: /\{[A-Z][A-Z_]{2,}\}/gu, replace: '' },
  // Escapes and control characters.
  { name: 'newline-escape', pattern: /\\n/gu, replace: '\n' },
  // eslint-disable-next-line no-control-regex
  { name: 'control', pattern: /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, replace: '' },
  // A bare "#1" line-break marker used by some dumps.
  { name: 'hash-marker', pattern: /(?<=\s)#\d+(?=\s|$)/gu, replace: '' },
  { name: 'whitespace', pattern: /[ \t\u00a0\u3000]+/gu, replace: ' ' }
];

/**
 * Clean one line, recording which rules fired.
 * @param {string} raw - the raw line.
 * @param {Record<string, number>} tally - mutated per-rule counters.
 * @returns {string} the cleaned line.
 */
export function clean(raw, tally) {
  let text = String(raw ?? '');
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      tally[rule.name] = (tally[rule.name] ?? 0) + 1;
      rule.pattern.lastIndex = 0;
      text = text.replace(rule.pattern, rule.replace);
    } else {
      rule.pattern.lastIndex = 0;
    }
  }
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
    .trim();
}

/* ------------------------------------------------------------------ *
 * Input parsing
 * ------------------------------------------------------------------ */

/** Whether a line looks like engine or UI text rather than dialogue. */
export function looksLikeNoise(text) {
  if (text === '') return true;
  // Pure punctuation, pure digits, or a bare id.
  if (/^[\s\p{P}\p{S}\d]+$/u.test(text)) return true;
  // Placeholder that survived cleaning.
  if (/^[{}<>[\]]+$/u.test(text)) return true;
  // A wiki/dump artefact: a lone character name.
  if (text.length <= 2) return true;
  return false;
}

/**
 * Whether a line is the tail of a message the game split across bubbles.
 *
 * Two shapes, and they need different rules.
 *
 * **Punctuation.** The message system delivers long lines in segments, so a stored
 * line can begin with a continuation mark — `，在长长的前路上，你要永远闪耀着，好吗？`
 * is a fragment, and as a voice sample it teaches her to start sentences with a
 * comma.
 *
 * **Conjunctions — but only the ones that genuinely need an antecedent.** The quest
 * transcripts split one speech across several lines, so `而是要把「未来」的重量，也压在天平上。`
 * arrives with its subject and its first clause left behind on the previous line.
 * As a sample it teaches a sentence shape she never produces.
 *
 * ⚠️ The list is deliberately narrow. A blanket ban on leading conjunctions is
 * wrong: `因为人家一时半会儿还回不来哦，怕你孤单寂寞嘛` opens with 因为 and is a
 * complete, load-bearing line — it is one of the best samples in the corpus.
 * So are `但有一件事，我记得特别清楚。` and `而且，这也是所有神谕牌里唯一一张…`.
 * Only `而是 / 然后 / 于是 / 因此 / 接着 / 所以` presuppose text that is not there.
 *
 * @param {string} text - the cleaned line.
 * @returns {boolean} true when the line cannot stand on its own.
 */
export function isFragment(text) {
  if (/^[，、；：,;:）)】」』…—]/u.test(text)) return true;
  return /^(?:而是|然后|于是|因此|接着|所以)/u.test(text);
}

/**
 * Parse a `<speaker, text>` pair list.
 * @param {string} text - file contents.
 * @returns {Array<{speaker: string, text: string}>} pairs.
 */
export function parsePairs(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    return parsed.map((entry) => ({ speaker: String(entry.speaker ?? entry.name ?? ''), text: String(entry.text ?? entry.line ?? '') }));
  }
  // JSONL
  const out = [];
  for (const line of trimmed.split(/\r?\n/u)) {
    const candidate = line.trim();
    if (candidate === '') continue;
    try {
      const entry = JSON.parse(candidate);
      out.push({ speaker: String(entry.speaker ?? entry.name ?? ''), text: String(entry.text ?? entry.line ?? '') });
    } catch {
      // A plain sentence in a `.jsonl` file is still usable as unattributed text.
      out.push({ speaker: '', text: candidate });
    }
  }
  return out;
}

/**
 * Parse a game text-map: `{"<hash>": "string"}`.
 *
 * Text maps carry **no speaker**, so this cannot answer "only her lines". The
 * pairs are emitted with an empty speaker and the caller is told to join them
 * against the speaker table instead of guessing.
 * @param {string} text - file contents.
 * @returns {Array<{speaker: string, text: string}>} pairs.
 */
export function parseTextMap(text) {
  const parsed = JSON.parse(text);
  const out = [];
  for (const [hash, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') continue;
    out.push({ speaker: '', text: value, id: hash });
  }
  return out;
}

/** Speaker prefixes that a plain-text dump might use. */
const TEXT_LINE_PATTERNS = [
  /^【(?<speaker>[^】]{1,20})】\s*(?<text>.+)$/u,
  /^\[(?<speaker>[^\]]{1,20})\]\s*(?<text>.+)$/u,
  /^(?<speaker>[\p{Script=Han}A-Za-z·\s]{1,20})[：:]\s*(?<text>.+)$/u,
  /^(?<speaker>[\p{Script=Han}A-Za-z·\s]{1,20})「(?<text>.+)」$/u
];

/**
 * Parse plain text, splitting `speaker：line` style rows.
 * @param {string} text - file contents.
 * @returns {Array<{speaker: string, text: string}>} pairs.
 */
export function parseText(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === '') continue;
    let matched = false;
    for (const pattern of TEXT_LINE_PATTERNS) {
      const match = pattern.exec(line);
      if (match?.groups !== undefined) {
        out.push({ speaker: match.groups.speaker.trim(), text: match.groups.text.trim() });
        matched = true;
        break;
      }
    }
    if (!matched) out.push({ speaker: '', text: line });
  }
  return out;
}

/** Guess the format from the content. */
export function detectFormat(text) {
  const trimmed = text.trim();
  // An array of pairs starts with `[`, which is a top-level check — nesting it
  // inside the object branch made array input fall through to plain text.
  if (trimmed.startsWith('[')) return 'pairs';
  if (trimmed.startsWith('{')) {
    // A text map is one flat object of hash → string and carries no speaker.
    if (/"speaker"|"name"|"line"/u.test(trimmed.slice(0, 400))) return 'pairs';
    return 'textmap';
  }
  return 'text';
}

/* ------------------------------------------------------------------ *
 * Style analysis
 * ------------------------------------------------------------------ */

/** Normalise a speaker label for comparison. */
function normaliseSpeaker(value) {
  return String(value).replace(/[\s【】\[\]「」·._-]/gu, '').toLowerCase();
}

/** Whether a speaker matches one of the configured aliases. */
export function isTargetSpeaker(speaker, aliases = DEFAULTS.aliases) {
  const key = normaliseSpeaker(speaker);
  if (key === '') return false;
  return aliases.some((alias) => {
    const target = normaliseSpeaker(alias);
    return key === target || key.includes(target);
  });
}

/** Code points of a string. */
const chars = (text) => [...text];

/** Percentile of a numeric array (already sorted ascending). */
function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[at];
}

/**
 * Punctuation worth counting, longest first.
 *
 * Order matters: `……` must be consumed before `…`, or one ellipsis is counted
 * three times (`……` plus two lone `…`) and the statistics lie.
 */
const MARKS = ['……', '…', '——', '—', '！', '!', '？', '?', '♪', '～', '、', '，', ',', '。', '「', '」', '（', '）', '·'];

/** Sentence-final particles worth counting. */
const PARTICLES = ['呀', '呢', '哦', '喔', '吧', '啊', '啦', '嘛', '咯', '诶', '嗯', '呜', '喵'];

/** Trailing punctuation that can follow a sentence-final particle. */
const TRAILING = /[\s。，、！!？?…♪～—·」』）)】\]]+$/u;

/** A string with its trailing punctuation removed. */
const withoutTrailingPunctuation = (line) => line.replace(TRAILING, '');

/**
 * Suffixes that make a line a question, or at least a request for an answer.
 *
 * Chinese forms questions without a question mark constantly — `你在做什么`
 * has neither `？` nor a sentence-final particle, so a detector that only looks
 * for those reports a confident, wrong number. Matching the *end* of the line
 * is what keeps `我什么都不知道` out of the count.
 *
 * `呢` and `吧` are genuinely ambiguous (declarative vs. asking), so the
 * reported figure is deliberately labelled as "question or seeking a response"
 * rather than "question".
 */
const INTERROGATIVE_SUFFIXES = [
  '吗', '呢', '吧',
  '什么', '为什么', '怎么', '怎么样', '怎么办', '如何',
  '哪里', '哪儿', '哪个', '谁', '多少', '几个', '多久',
  '是不是', '对不对', '好不好', '行不行', '有没有', '能不能', '可不可以'
];

/** Whether a line reads as a question or a request for an answer. */
function isQuestion(line) {
  if (/[？?]/u.test(line)) return true;
  const trimmed = withoutTrailingPunctuation(line);
  return INTERROGATIVE_SUFFIXES.some((suffix) => trimmed.endsWith(suffix));
}

/** Whether a character is a CJK ideograph or kana. */
const isCjk = (character) => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(character);

/**
 * Count punctuation by consuming the longest mark first, so overlapping marks
 * are not double counted.
 * @param {string[]} lines - the lines.
 * @returns {Array<{mark: string, linesWith: number, occurrences: number, share: number}>} the table.
 */
export function countMarks(lines) {
  const table = new Map();
  lines.forEach((line, index) => {
    let rest = line;
    for (const mark of MARKS) {
      let at = rest.indexOf(mark);
      while (at !== -1) {
        const entry = table.get(mark) ?? { lines: new Set(), occurrences: 0 };
        entry.occurrences += 1;
        entry.lines.add(index);
        table.set(mark, entry);
        rest = rest.slice(0, at) + rest.slice(at + mark.length);
        at = rest.indexOf(mark);
      }
    }
  });
  return [...table.entries()]
    .map(([mark, entry]) => ({
      mark,
      linesWith: entry.lines.size,
      occurrences: entry.occurrences,
      share: entry.lines.size / lines.length
    }))
    .sort((left, right) => right.linesWith - left.linesWith || right.occurrences - left.occurrences);
}

/**
 * Compute a descriptive profile of a line set.
 * @param {string[]} lines - the cleaned lines.
 * @returns {object} the profile.
 */
export function profile(lines) {
  const lengths = lines.map((line) => chars(line).length).sort((left, right) => left - right);
  const total = lengths.reduce((sum, value) => sum + value, 0);

  const marks = countMarks(lines).filter((entry) => entry.occurrences > 0);

  // The particle is checked against the line *without* its trailing punctuation:
  // `你来了呀……` ends in an ellipsis on the page but the particle is 呀.
  const endings = PARTICLES.map((particle) => ({
    particle,
    count: lines.filter((line) => [...withoutTrailingPunctuation(line)].slice(-1)[0] === particle).length
  })).filter((entry) => entry.count > 0).sort((left, right) => right.count - left.count);

  // First two characters: reveals how she opens a line.
  const openings = new Map();
  for (const line of lines) {
    const head = chars(line).slice(0, 2).join('');
    if (head.length < 2 || ![...head].some(isCjk)) continue;
    openings.set(head, (openings.get(head) ?? 0) + 1);
  }
  const topOpenings = [...openings.entries()].sort((left, right) => right[1] - left[1]).slice(0, 12);

  // Recurring n-grams, which is where catchphrases show up. Restricted to CJK
  // grams: Latin fragments from a stray English line otherwise dominate the
  // list with things like "li" and tell you nothing.
  const grams = new Map();
  for (const line of lines) {
    const points = chars(line);
    for (let size = 2; size <= 4; size += 1) {
      for (let at = 0; at + size <= points.length; at += 1) {
        const slice = points.slice(at, at + size);
        if (!slice.some(isCjk)) continue;
        if (slice.some((character) => /[A-Za-z]/u.test(character))) continue;
        const gram = slice.join('');
        if (/^[\s\p{P}\p{S}]+$/u.test(gram)) continue;
        grams.set(gram, (grams.get(gram) ?? 0) + 1);
      }
    }
  }
  const topGrams = [...grams.entries()]
    .filter(([, count]) => count >= 3)
    .sort((left, right) => right[1] - left[1] || right[0].length - left[0].length)
    .slice(0, 24);

  const shortShare = lines.filter((line) => chars(line).length <= 12).length / lines.length;
  const questionShare = lines.filter(isQuestion).length / lines.length;

  return {
    count: lines.length,
    totalChars: total,
    mean: total / lines.length,
    median: percentile(lengths, 0.5),
    p90: percentile(lengths, 0.9),
    max: lengths[lengths.length - 1],
    shortShare,
    questionShare,
    marks,
    endings,
    topOpenings,
    topGrams
  };
}

/**
 * Pick a small, diverse set of lines.
 *
 * Not a semantic clustering — no embeddings here — but a cheap and explainable
 * proxy: score each line by how unusual its n-grams are, then greedily take
 * the best line that does not overlap much with what is already chosen. The
 * point is to avoid twelve paraphrases of the same sentence.
 *
 * @param {string[]} lines - candidate lines, unique.
 * @param {number} want - how many to pick.
 * @returns {string[]} the picked lines.
 */
/**
 * How much a line sounds like her *talking to someone*.
 *
 * The diversity score alone optimises for lexical rarity, which is the wrong
 * target for a voice sample: a line about what the tarot cards symbolise is full
 * of unusual words and teaches the wrong register — hers is a person talking, not
 * a person explaining. On the story corpus it picked up lines like
 * 「它象征着新生和希望，却也容易让人联想到挫折、悲伤和空虚。」, unmistakably her
 * vocabulary and unmistakably not her voice.
 *
 * Every marker below is something she actually does in the corpus, not a guess:
 * the particles, ♪, ~, 人家 and 嘻 are all over her lines, and the penalised verbs
 * are the ones that appear in exposition and nowhere else.
 *
 * Returned as a multiplier so it composes with the length bonus instead of
 * replacing the diversity ranking — the sample set still wants to be varied, it
 * just wants to be varied *within* her register.
 *
 * @param {string} text - the cleaned line.
 * @returns {{weight: number, hits: string[]}} the multiplier, and what fired.
 */
export function registerWeight(text) {
  const line = String(text ?? '');
  const hits = [];
  let weight = 1;

  // The single most reliable sign that a line is speech rather than narration:
  // she ends sentences with a particle far more often than not.
  if (/[呀啦呢哦嘛哟吧啊咯嘞](?:[。！？…~♪])*$/u.test(line)) {
    weight += 0.45;
    hits.push('particle');
  }
  if (/[♪~]/u.test(line)) {
    weight += 0.35;
    hits.push('musical');
  }
  if (/人家/u.test(line)) {
    weight += 0.3;
    hits.push('self-ref');
  }
  if (/嘻/u.test(line)) {
    weight += 0.3;
    hits.push('laugh');
  }
  // She asks, invites and hands the turn back constantly — but a question mark is
  // weak evidence on its own, so it stays small.
  if (/[？?]/u.test(line)) {
    weight += 0.1;
    hits.push('question');
  }
  if (/你/u.test(line)) {
    weight += 0.15;
    hits.push('second-person');
  }

  // Exposition: the verbs that only show up when she is explaining a system, a
  // card, a rule or a piece of lore.
  if (/象征|意味|代表|通常|往往|所谓|属于|包括|分为|指的|堪称|可谓是/u.test(line)) {
    weight -= 0.55;
    hits.push('exposition');
  }
  // A very long sample costs prompt budget and reads as a set piece, not a line.
  if (chars(line).length > 45) {
    weight -= 0.25;
    hits.push('long');
  }

  return { weight: Math.max(0.2, weight), hits };
}

export function selectDiverse(lines, want) {
  const pointsOf = (line) => {
    const points = chars(line);
    const grams = new Set();
    for (let size = 2; size <= 3; size += 1) {
      for (let at = 0; at + size <= points.length; at += 1) {
        grams.add(points.slice(at, at + size).join(''));
      }
    }
    return grams;
  };

  const documentFrequency = new Map();
  const sets = lines.map((line) => {
    const grams = pointsOf(line);
    for (const gram of grams) documentFrequency.set(gram, (documentFrequency.get(gram) ?? 0) + 1);
    return grams;
  });

  const scored = lines.map((line, index) => {
    const grams = sets[index];
    let score = 0;
    for (const gram of grams) score += 1 / (documentFrequency.get(gram) ?? 1);
    score /= Math.max(1, grams.size);
    // Mild preference for a mid-length line: too short carries no voice, too
    // long will not fit a prompt sample block comfortably.
    const length = chars(line).length;
    const lengthBonus = length >= 6 && length <= 40 ? 1.25 : 1;
    const register = registerWeight(line);
    return { line, index, score: score * lengthBonus * register.weight, register };
  }).sort((left, right) => right.score - left.score);

  const picked = [];
  const pickedSets = [];
  for (const candidate of scored) {
    if (picked.length >= want) break;
    const grams = sets[candidate.index];
    const overlaps = pickedSets.some((other) => {
      let shared = 0;
      for (const gram of grams) if (other.has(gram)) shared += 1;
      const union = grams.size + other.size - shared;
      return union > 0 && shared / union > 0.7;
    });
    if (overlaps) continue;
    picked.push(candidate.line);
    pickedSets.push(grams);
  }

  // If the overlap filter was too strict, top up with the best of the rest.
  if (picked.length < want) {
    for (const candidate of scored) {
      if (picked.length >= want) break;
      if (!picked.includes(candidate.line)) picked.push(candidate.line);
    }
  }
  return picked;
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

/**
 * Describe the measured line length in words.
 *
 * Derived rather than hardcoded: an earlier version always emitted "以短句为主",
 * which produced a snippet that contradicted its own numbers (a median of 19
 * characters and a 21 % short-line share is not "mostly short sentences").
 *
 * @param {object} measure - the profile.
 * @returns {string} a phrase for the persona snippet.
 */
export function describeLength(measure) {
  const median = measure.median;
  if (median <= 10) return '以短句为主';
  if (median <= 14) return '短句为主，偶尔中长句';
  if (median <= 20) return '句长中等，短句与中句混用';
  if (median <= 28) return '中长句为主，较少短句';
  return '长句为主，句中常有多层逗号连接';
}

/** Render the measured profile as pasteable persona guidance. */
function renderProfile(measure, stats) {
  const pct = (value) => `${Math.round(value * 100)}%`;
  const lines = [];
  lines.push('# 语感统计');
  lines.push('');
  lines.push(`> 由 tools/ingest.mjs 从 ${measure.count} 条她的台词统计得出（共 ${stats.dropped} 条被丢弃）。`);
  lines.push('> 这是**描述性统计**，不是理解。请据此改 persona.yaml，不要直接当成事实。');
  lines.push('');
  lines.push('## 句长');
  lines.push('');
  lines.push(`- 中位数 **${measure.median}** 字，平均 ${measure.mean.toFixed(1)} 字`);
  lines.push(`- 90 分位 ${measure.p90} 字，最长 ${measure.max} 字`);
  lines.push(`- **${pct(measure.shortShare)}** 的台词不超过 12 字`);
  lines.push('');
  lines.push('→ 对应 persona.yaml：');
  lines.push('');
  lines.push('```yaml');
  lines.push('voice:');
  lines.push('  sentence:');
  lines.push(`    length: ${describeLength(measure)}（中位数 ${measure.median} 字，${pct(measure.shortShare)} 不超过 12 字）`);
  lines.push(`    paragraph: 一段 1～3 句`);
  lines.push('```');
  lines.push('');
  lines.push('## 标点习惯');
  lines.push('');
  lines.push('| 符号 | 出现的台词 | 占比 | 总次数 |');
  lines.push('|---|---|---|---|');
  for (const entry of measure.marks.slice(0, 12)) {
    lines.push(`| \`${entry.mark}\` | ${entry.linesWith} | ${pct(entry.share)} | ${entry.occurrences} |`);
  }
  lines.push('');
  lines.push(`疑问或征询语气占比 **${pct(measure.questionShare)}**。`);
  lines.push('');
  lines.push('> 这个数字统计的是「含问号，或句尾是疑问/征询结构」的台词。中文常常不带问号，');
  lines.push('> 而「呢」「吧」既可用于提问也可用于陈述，所以它是**上界**，不是精确值。');
  lines.push('');
  lines.push('## 句尾语气词');
  lines.push('');
  if (measure.endings.length === 0) {
    lines.push('- （没有统计到句尾语气词）');
  } else {
    lines.push('| 语气词 | 次数 |');
    lines.push('|---|---|');
    for (const entry of measure.endings.slice(0, 10)) lines.push(`| ${entry.particle} | ${entry.count} |`);
    lines.push('');
    lines.push('```yaml');
    lines.push('voice:');
    lines.push(`  particles: [${measure.endings.slice(0, 5).map((entry) => entry.particle).join(', ')}]`);
    lines.push('```');
  }
  lines.push('');
  lines.push('## 她怎么起句（前两字）');
  lines.push('');
  lines.push(measure.topOpenings.map(([gram, count]) => `\`${gram}\`×${count}`).join('、'));
  lines.push('');
  lines.push('## 反复出现的说法（2～4 字）');
  lines.push('');
  if (measure.topGrams.length === 0) lines.push('- （没有重复 3 次以上的片段）');
  else lines.push(measure.topGrams.map(([gram, count]) => `\`${gram}\`×${count}`).join('、'));
  lines.push('');
  lines.push('> 这一节最容易看出她的口癖。重复次数高的，可以考虑写进 `voice.particles`');
  lines.push('> 或 `voice.punctuation.rules`；但注意有些高频片段来自同一段剧情的重复演出，不是口癖。');
  lines.push('');
  lines.push('## 清理规则命中情况');
  lines.push('');
  lines.push('| 规则 | 命中行数 |');
  lines.push('|---|---|');
  for (const [name, count] of Object.entries(stats.tally).sort((left, right) => right[1] - left[1])) {
    lines.push(`| ${name} | ${count} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/**
 * Clean, attribute, de-duplicate and filter a pair list.
 *
 * Split out from `main` so the rules are testable without going through the
 * filesystem — the filtering is where a silent mistake (dropping her lines, or
 * keeping another character's) would quietly poison the whole corpus.
 *
 * @param {Array<{speaker: string, text: string}>} pairs - raw pairs.
 * @param {object} [options] - overrides for {@link DEFAULTS}.
 * @returns {{kept: object[], rejects: object[], dropped: number, tally: object, attributed: boolean}} the result.
 */
export function processPairs(pairs, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const tally = {};
  const rejects = [];
  const kept = [];
  const seen = new Set();
  let dropped = 0;
  const attributed = pairs.some((pair) => pair.speaker !== '');

  for (const pair of pairs) {
    const text = clean(pair.text, tally);

    if (attributed && !isTargetSpeaker(pair.speaker, settings.aliases)) {
      // Not a reject — it simply belongs to someone else. Counting these as
      // rejects would make the reject file useless for spotting real problems.
      dropped += 1;
      continue;
    }
    if (text.length < settings.minLength) {
      rejects.push({ reason: 'too-short', text });
      dropped += 1;
      continue;
    }
    if (text.length > settings.maxLength) {
      rejects.push({ reason: 'too-long', text: text.slice(0, 60) });
      dropped += 1;
      continue;
    }
    // `keepNoise` is the audit switch: it turns off both quality filters, so
    // `--keep-noise` really does give you everything rather than everything
    // minus one rule you did not know about.
    if (settings.keepNoise !== true) {
      if (looksLikeNoise(text)) {
        rejects.push({ reason: 'looks-like-ui-text', text });
        dropped += 1;
        continue;
      }
      if (isFragment(text)) {
        rejects.push({ reason: 'continuation-fragment', text });
        dropped += 1;
        continue;
      }
    }
    // A surviving brace or angle bracket means a markup form this tool does not
    // know. Kept, but flagged, rather than silently mangled.
    const suspicious = /[{}<>]/u.test(text);
    const key = text.replace(/[\s\p{P}\p{S}]/gu, '');
    if (seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    kept.push({ speaker: pair.speaker, text, suspicious });
  }

  return { kept, rejects, dropped, tally, attributed };
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

function main() {
  const argv = process.argv.slice(2);
  const inputs = flagAll(argv, 'in');
  const format = flag(argv, 'format', 'auto');
  const outDir = resolve(flag(argv, 'out', 'corpus'));
  const settings = {
    aliases: flag(argv, 'aliases', DEFAULTS.aliases.join(',')).split(',').map((name) => name.trim()).filter(Boolean),
    samples: Number(flag(argv, 'samples', String(DEFAULTS.samples))),
    minLength: Number(flag(argv, 'min-length', String(DEFAULTS.minLength))),
    maxLength: Number(flag(argv, 'max-length', String(DEFAULTS.maxLength))),
    keepNoise: argv.includes('--keep-noise')
  };

  if (inputs.length === 0) {
    process.stderr.write('usage: node tools/ingest.mjs --in <file...> [--format pairs|textmap|text] [--out corpus]\n');
    process.exitCode = 1;
    return;
  }

  const pairs = [];
  const sources = [];
  for (const input of inputs) {
    if (!existsSync(input)) {
      process.stderr.write(`skipping missing input: ${input}\n`);
      continue;
    }
    const text = readFileSync(input, 'utf8');
    const detected = format === 'auto' ? detectFormat(text) : format;
    sources.push({ file: basename(input), format: detected, bytes: Buffer.byteLength(text) });

    if (detected === 'pairs') pairs.push(...parsePairs(text));
    else if (detected === 'textmap') pairs.push(...parseTextMap(text));
    else pairs.push(...parseText(text));
  }

  const result = processPairs(pairs, settings);
  if (!result.attributed) {
    process.stderr.write(
      '\nwarning: none of the inputs carried a speaker, so nothing can be attributed to her.\n' +
      '         A game text map is `hash -> string` only. Join it against the dialogue/speaker\n' +
      '         table first, or use a source that already publishes speaker + line pairs.\n' +
      '         Everything is still written to corpus/all-lines.jsonl so you can join it yourself.\n\n'
    );
  }

  const texts = result.kept.map((entry) => entry.text);
  const measure = texts.length === 0 ? null : profile(texts);
  const samples = texts.length === 0 ? [] : selectDiverse(texts, settings.samples);

  mkdirSync(outDir, { recursive: true });
  const writeJsonl = (name, rows) => {
    writeFileSync(join(outDir, name), `${rows.map((row) => JSON.stringify(row)).join('\n')}${rows.length === 0 ? '' : '\n'}`);
  };
  writeJsonl('all-lines.jsonl', pairs.map((pair) => ({ speaker: pair.speaker, text: clean(pair.text, {}) })));
  writeJsonl('corpus.jsonl', result.kept);
  writeJsonl('rejects.jsonl', result.rejects);
  writeFileSync(join(outDir, 'line-samples.yaml'), yaml.dump({
    voiceSamples: samples.map((text) => ({ text, why: '待你补充：这组在教什么' }))
  }, { lineWidth: 200, noRefs: true }));
  if (measure !== null) {
    writeFileSync(join(outDir, 'style-profile.md'), renderProfile(measure, {
      tally: result.tally,
      dropped: result.dropped,
      sources
    }));
  }

  process.stdout.write(`\n输入 ${inputs.length} 个文件\n`);
  for (const source of sources) process.stdout.write(`  ${source.file}  [${source.format}]  ${(source.bytes / 1024).toFixed(0)} KB\n`);
  process.stdout.write(`\n保留 ${result.kept.length} 条，丢弃 ${result.dropped} 条`);
  const suspicious = result.kept.filter((entry) => entry.suspicious).length;
  if (suspicious > 0) process.stdout.write(`（其中 ${suspicious} 条仍含未识别的标记，已保留待你检查）`);
  process.stdout.write('\n');
  if (measure !== null) {
    process.stdout.write(`  句长中位数 ${measure.median} 字，${Math.round(measure.shortShare * 100)}% 不超过 12 字\n`);
    process.stdout.write(`  选出 ${samples.length} 条语感样本\n`);
  }
  process.stdout.write(`\n产物 ${outDir}\\\n`);
  process.stdout.write('  all-lines.jsonl       清理后的全部行（未按说话人过滤）\n');
  process.stdout.write('  corpus.jsonl          只保留她的台词\n');
  process.stdout.write('  rejects.jsonl         被丢弃的行与原因\n');
  process.stdout.write('  style-profile.md      统计结果 + 可直接粘贴的 persona.yaml 片段\n');
  process.stdout.write('  line-samples.yaml     语感样本，粘进 dialogues.yaml 的 voiceSamples\n');
  process.stdout.write('\n下一步：看 style-profile.md 改 persona.yaml，再跑 node build.mjs\n');
}

// Only run when invoked directly, so the units above stay importable.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
