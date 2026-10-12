#!/usr/bin/env node
/**
 * Merge distilled corpus output into `dialogues.yaml`.
 *
 * This is the last step of the pipeline and it exists because doing it by hand
 * is both tedious and easy to get wrong:
 *
 *  - the real game pairs go **first**, so the model reads ground truth before
 *    any hand-written example;
 *  - a reply that several choice options share is kept **once**. In the real
 *    data three menu options converge on one eight-bubble reply, and copying it
 *    three times spends prompt budget on nothing;
 *  - the hand-written examples are preserved, because they cover registers the
 *    real corpus does not have (technical answers, correcting the user, saying
 *    no).
 *
 * Usage:
 *   node tools/merge-corpus.mjs \
 *     --turns corpus-raw/turns.yaml \
 *     --samples corpus/line-samples.yaml \
 *     --target dialogues.yaml [--max-dialogues 16] [--check]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';

/** Read a valued CLI flag. */
function flag(argv, name, fallback) {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
}

/**
 * Drop pairs whose reply is already represented.
 *
 * Two examples that differ only in the prompt but share an identical long reply
 * teach nothing extra; keeping both just makes the prompt longer.
 *
 * @param {Array<{user: string, assistant: string}>} pairs - candidate pairs.
 * @returns {Array<object>} the pairs with duplicate replies removed.
 */
export function dedupeByReply(pairs) {
  const seen = new Set();
  const out = [];
  for (const pair of pairs) {
    const key = String(pair?.assistant ?? '').replace(/\s+/gu, '');
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(pair);
  }
  return out;
}

/**
 * Merge real pairs and distilled samples over the existing documents.
 *
 * The generated file is kept separate from the hand-written `dialogues.yaml`
 * and combined at build time. Rewriting the user's file in place was the first
 * design and it was wrong twice over: re-running it duplicated the real pairs,
 * and it put generated content in the one file a person is meant to edit.
 *
 * @param {object} options - the merge inputs.
 * @returns {{dialogues: object[], voiceSamples: object[], droppedReplies: number}} the generated documents.
 */
export function merge({ real, samples, maxDialogues = 16 }) {
  // The turn that survives a duplicate reply is the one with the shortest user
  // line, which reads as the most natural prompt for that answer.
  const ordered = [...(real?.dialogues ?? [])].sort(
    (left, right) => String(left.user ?? '').length - String(right.user ?? '').length
  );
  const unique = dedupeByReply(ordered);
  const droppedReplies = (real?.dialogues ?? []).length - unique.length;

  return {
    dialogues: unique.slice(0, maxDialogues).map((pair) => ({
      user: pair.user,
      assistant: pair.assistant,
      why: `${pair.why ?? ''}（**真实游戏数据**，优先照这个）`.trim()
    })),
    voiceSamples: (samples?.voiceSamples ?? []).map((sample) => ({
      text: typeof sample === 'string' ? sample : sample.text,
      why: (typeof sample === 'string' ? '' : sample.why) || '游戏内原话（tools/ingest.mjs 挑选，请按需增删）'
    })),
    droppedReplies
  };
}

function main() {
  const argv = process.argv.slice(2);
  const turnsPath = flag(argv, 'turns', 'corpus-raw/turns.yaml');
  const samplesPath = flag(argv, 'samples', 'corpus/line-samples.yaml');
  const outPath = resolve(flag(argv, 'out', 'dialogues-corpus.yaml'));
  const maxDialogues = Number(flag(argv, 'max-dialogues', '16'));
  const check = argv.includes('--check');

  const read = (path, label) => {
    if (!existsSync(path)) {
      process.stderr.write(`missing ${label}: ${path}\n`);
      return undefined;
    }
    return yaml.load(readFileSync(path, 'utf8'));
  };

  const real = read(turnsPath, 'turns');
  const samples = read(samplesPath, 'samples');
  if (real === undefined || samples === undefined) {
    process.exitCode = 1;
    return;
  }

  const merged = merge({ real, samples, maxDialogues });
  const header = [
    '# 昔涟 · 从语料生成的少样本示例',
    '#',
    '# **这个文件由 tools/merge-corpus.mjs 生成，不要手改**——重跑会覆盖。',
    '# 手写示例请放 dialogues.yaml，build 时会把两边合并（语料在前，手写在后）。',
    '#',
    '# 来源：游戏内短信数据，经 tools/adapters/starrail-messages.mjs 提取后去重。',
    '# 只代表短信语体；换任务语料后应重新蒸馏，见 README-text-sources.md。',
    '',
    ''
  ].join('\n');
  const text = header + yaml.dump(
    { dialogues: merged.dialogues, voiceSamples: merged.voiceSamples },
    { lineWidth: 200, noRefs: true }
  );

  process.stdout.write(`\n真实对话对：${real.dialogues?.length ?? 0} 组` +
    `${merged.droppedReplies === 0 ? '' : `，去掉 ${merged.droppedReplies} 组同一回复`}\n`);
  process.stdout.write(`dialogues 保留：${merged.dialogues.length} 组\n`);
  process.stdout.write(`voiceSamples：${merged.voiceSamples.length} 条\n`);

  if (check) {
    process.stdout.write('\n--check：未写入\n');
    return;
  }
  writeFileSync(outPath, text);
  process.stdout.write(`\n已写入 ${outPath}\n下一步：node build.mjs\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
