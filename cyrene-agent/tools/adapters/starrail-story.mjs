#!/usr/bin/env node
/**
 * Adapter: Fandom quest transcripts → the speaker/text stream `ingest.mjs` reads.
 *
 * The shape it emits is the same one `starrail-messages.mjs` emits, so the
 * cleaning, rejection and profiling stages are shared rather than reimplemented:
 *
 *   {"speaker":"HER","text":"我们是为了回应世界的愿望而启程的，对吧？","conversationId":"chapter:英雄啊，点燃那最初的骄阳"}
 *
 * ## Why the voice filename, not the display name
 *
 * A line looks like this:
 *
 *   :{{A|VO chapter4 44 cyrene 103.ogg}} '''昔涟:''' 我们是为了回应世界的愿望而启程的，对吧？
 *   :{{A|VO chapter4 44 phainon 101.ogg}} '''白厄:''' 每一位黄金裔都是如此，从未改变。
 *
 * The display name is unreliable: before her identity is revealed she is `???`, and
 * 「往昔的涟漪」and「迷迷」are the same character at other stages. The **voice
 * filename** is stable — `cyrene` — and one token covers all three display names,
 * which was verified against the data rather than assumed.
 *
 * The filename itself comes in four shapes, all of which occur:
 *
 *   VO chapter4 44 cyrene 103.ogg      latin speaker, plain take number
 *   VO chapter4 41 cyrene 139 f.ogg    ...with an `f` suffix
 *   VO chapter3 40 姬子 101.ogg        Chinese speaker
 *   VO 第4章 5 丹恒 101.ogg            Chinese chapter marker too
 *
 * Matching only the first shape is what produced a wrong character count once.
 *
 * Usage:
 *   node tools/adapters/starrail-story.mjs --in corpus-raw/starrail-story --out corpus-raw
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { looksLikeNoise } from '../ingest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Voice tokens that are all her. Kept explicit: a wrong entry misattributes lines. */
export const HER_TOKENS = new Set(['cyrene']);

/** Display names that are her, used only when the voice filename is unparseable. */
export const HER_NAMES = ['昔涟', '昔漣', '往昔的涟漪', '迷迷'];

/** The player's label on the wiki. */
const PLAYER_NAMES = ['开拓者', '玩家'];

/**
 * Pull the speaker out of a voice filename.
 *
 * Drop the `VO` prefix, the chapter marker (latin or Chinese), the leading scene
 * number, the trailing take number, and a lone `f`; whatever is left is the
 * speaker, latin or Chinese alike.
 *
 * @param {string} front - the part inside `{{A|…}}`.
 * @returns {string} a lower-cased speaker token, or an empty string.
 */
export function speakerToken(front) {
  return front
    .replace(/\.ogg$/iu, '')
    .trim()
    .split(/\s+/u)
    .filter((part, index) => {
      if (index === 0 && /^vo$/iu.test(part)) return false;
      if (/^(chapter\d+|第\d+章)$/iu.test(part)) return false;
      if (/^\d+$/u.test(part)) return false;
      if (/^f$/iu.test(part)) return false;
      return true;
    })
    .join(' ')
    .toLowerCase();
}

/**
 * Strip the wiki markup a reader never sees.
 *
 * Templates have to go innermost-first: `{{Color|keyword|nobold=1|「汝将肩负骄阳」}}`
 * wraps a quoted line, and a single non-recursive pass leaves `Color|keyword|…`
 * sitting in the middle of her dialogue — which happened, and reached the samples.
 *
 * @param {string} raw - the text after the speaker label.
 * @returns {string} plain text.
 */
export function stripMarkup(raw) {
  let text = String(raw ?? '');
  // Repeat until stable: nested templates need more than one pass.
  for (let pass = 0; pass < 6; pass += 1) {
    const before = text;
    text = text.replace(/\{\{[^{}]*\}\}/gu, (match) => {
      const parts = match.slice(2, -2).split('|');
      // The rendered value of a template like {{Color|keyword|nobold=1|text}} is its
      // last non-keyword argument; of a reference-style template it is usually the
      // first. Take the last non-`key=value` part, which covers both.
      const visible = parts.filter((part) => part !== '' && !/^[a-z_]+=/iu.test(part));
      if (visible.length === 0) return '';
      const last = visible[visible.length - 1];
      return /^[a-z_ ]+$/iu.test(last) && visible.length > 1 ? '' : last;
    });
    if (text === before) break;
  }
  return text
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/gu, '$1')
    .replace(/\[https?:\/\/\S+\s+([^\]]*)\]/gu, '$1')
    .replace(/'''?/gu, '')
    .replace(/<[^>]+>/gu, '')
    .replace(/^[:\s]+/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Turn one chapter's wikitext into an ordered stream of speaker/text records.
 *
 * The order matters: `ingest.mjs` builds pairs from who follows whom, so a line
 * only means something next to the line it answers.
 *
 * @param {string} text - the chapter's wikitext.
 * @param {string} chapter - the chapter title, used as the conversation id.
 * @returns {object[]} records.
 */
export function parseChapter(text, chapter) {
  const records = [];
  const pattern = /\{\{A\|([^}]*?)\}\}\s*'''([^:']+):'''\s*([^\n]*)/gu;
  for (const match of text.matchAll(pattern)) {
    const token = speakerToken(match[1]);
    const display = match[2].trim();
    const body = stripMarkup(match[3]);
    if (body === '') continue;

    let speaker;
    if (HER_TOKENS.has(token) || HER_NAMES.some((name) => display.includes(name))) speaker = 'HER';
    else if (PLAYER_NAMES.some((name) => display.includes(name))) speaker = 'Player';
    else speaker = display;

    records.push({
      speaker,
      text: body,
      conversationId: `chapter:${chapter}`,
      // Kept for the report and for spotting a mis-tokenised speaker later.
      token,
      display,
      chapter
    });
  }
  return records;
}

function main() {
  const args = process.argv.slice(2);
  const inIndex = args.indexOf('--in');
  const outIndex = args.indexOf('--out');
  const inDir = resolve(inIndex === -1 ? join(ROOT, 'corpus-raw', 'starrail-story') : args[inIndex + 1]);
  const outDir = resolve(outIndex === -1 ? join(ROOT, 'corpus-raw') : args[outIndex + 1]);

  if (!existsSync(inDir)) {
    process.stderr.write(`  no such source directory: ${inDir}\n  run tools/fetch-story.mjs first\n`);
    process.exit(1);
  }

  const files = readdirSync(inDir).filter((name) => name.endsWith('.wiki'));
  if (files.length === 0) {
    process.stderr.write(`  ${inDir} holds no .wiki files\n`);
    process.exit(1);
  }

  const all = [];
  const perChapter = [];
  const tokens = new Map();
  for (const name of files) {
    const chapter = name.replace(/\.wiki$/u, '');
    const records = parseChapter(readFileSync(join(inDir, name), 'utf8'), chapter);
    for (const record of records) {
      const entry = tokens.get(record.token) ?? { lines: 0, sample: record.display };
      entry.lines += 1;
      tokens.set(record.token, entry);
    }
    const hers = records.filter((r) => r.speaker === 'HER').length;
    perChapter.push({ chapter, lines: records.length, hers });
    all.push(...records);
  }

  // The emitted stream is only the fields the pipeline knows about; the extras
  // would otherwise ride into `corpus.jsonl` and from there into the samples.
  const stream = all.map(({ speaker, text, conversationId }) => ({ speaker, text, conversationId }));
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, 'starrail-story.jsonl');
  writeFileSync(out, `${stream.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');

  process.stdout.write(`  chapters read : ${files.length}\n`);
  process.stdout.write(`  lines parsed  : ${stream.length}\n`);
  process.stdout.write(`  attributed HER: ${stream.filter((r) => r.speaker === 'HER').length}\n`);
  process.stdout.write(`  wrote           ${join('corpus-raw', 'starrail-story.jsonl')}\n`);

  const withHer = perChapter.filter((c) => c.hers > 0).sort((a, b) => b.hers - a.hers);
  if (withHer.length > 0) {
    process.stdout.write('\n  chapters where she speaks:\n');
    for (const c of withHer) process.stdout.write(`    ${String(c.hers).padStart(4)} / ${String(c.lines).padStart(4)}   ${c.chapter}\n`);
  }

  // Anything that looks like a speaker but was never mapped to HER is worth seeing:
  // it is either another character, or her under a token this adapter does not know.
  const suspicious = [...tokens]
    .filter(([token]) => /cyrene|mimi|迷迷|涟漪|^$/u.test(token))
    .sort((a, b) => b[1].lines - a[1].lines);
  if (suspicious.length > 0) {
    process.stdout.write('\n  tokens that look like her:\n');
    for (const [token, entry] of suspicious) {
      process.stdout.write(`    ${(token || '(empty)').padEnd(18)} ${String(entry.lines).padStart(4)} lines   e.g. ${entry.sample}\n`);
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
