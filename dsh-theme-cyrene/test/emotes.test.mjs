/**
 * The emote filename contract.
 *
 * The client maps emote files to reactions through no registry at all: it reads
 * the transcript for a trigger word, then looks for an entry whose **label**
 * matches the rule — and the label is the filename with its extension stripped
 * (`build.mjs`: `labelOf`).
 *
 * So the filenames *are* the wiring. Rename 开心.webp and the word 「谢谢」 stops
 * reacting, with no error anywhere: no exception, no console warning, no failed
 * request — the easter egg simply never fires. That is exactly the kind of
 * silent breakage worth a test.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The label -> trigger-words table, read out of the client source. */
function emoteTriggers() {
  const source = readFileSync(join(PROJECT_ROOT, 'lib', 'client', '80-emotes.js'), 'utf8');
  const block = /var EMOTE_TRIGGERS = \[([\s\S]*?)\n\];/u.exec(source);
  assert.notEqual(block, null, 'EMOTE_TRIGGERS must still be declared literally');
  const rules = [...block[1].matchAll(/label: "([^"]+)",\s*words: \[([^\]]+)\]/gu)].map((match) => ({
    label: match[1],
    words: [...match[2].matchAll(/"([^"]+)"/gu)].map((word) => word[1])
  }));
  assert.ok(rules.length > 0, 'expected at least one emote rule');
  return rules;
}

/** The emote filenames actually shipped, excluding placeholders. */
function shipped() {
  return readdirSync(join(PROJECT_ROOT, 'GIF', 'emotes')).filter((name) => !name.startsWith('.'));
}

test('every shipped emote can actually be reached', () => {
  const labels = new Set(emoteTriggers().map((rule) => rule.label));
  const files = shipped();
  assert.ok(files.length > 0, 'the emote set ships with the theme, so it must not be empty');
  for (const name of files) {
    const label = name.replace(/\.[^.]+$/u, '');
    assert.ok(labels.has(label), `GIF/emotes/${name} has no EMOTE_TRIGGERS rule, so it can never appear`);
  }
});

test('every trigger rule has an emote behind it', () => {
  const files = shipped().map((name) => name.replace(/\.[^.]+$/u, ''));
  for (const rule of emoteTriggers()) {
    assert.ok(rule.words.length > 0, `rule "${rule.label}" has no trigger words`);
    assert.ok(
      files.includes(rule.label),
      `rule "${rule.label}" has no file in GIF/emotes, so its ${rule.words.length} words do nothing`
    );
  }
});

test('every emote uses an extension the build actually scans', () => {
  // A file with an unscanned extension is invisible to the manifest: it would sit
  // in the directory looking correct and never load.
  const source = readFileSync(join(PROJECT_ROOT, 'build.mjs'), 'utf8');
  const declared = /ANIM_EXT = new Set\(\[([^\]]+)\]\)/u.exec(source);
  assert.notEqual(declared, null, 'ANIM_EXT must stay declared literally');
  const allowed = new Set([...declared[1].matchAll(/'([^']+)'/gu)].map((match) => match[1]));

  for (const name of shipped()) {
    const ext = name.slice(name.lastIndexOf('.'));
    assert.ok(allowed.has(ext), `${name} would be skipped: ${ext} is not in ANIM_EXT`);
  }
});

test('the client renders an emote in a format the overlay can show', () => {
  // The overlay is a bare <img src>. Anything the browser animates works, which
  // is why the animated emote is WebP rather than GIF: GIF cannot carry partial
  // alpha, so it forces every frame opaque and cost 460 KB for this same loop.
  const files = shipped();
  const animated = files.filter((name) => /\.(webp|gif|png)$/iu.test(name));
  assert.equal(animated.length, files.length);
  assert.ok(
    files.some((name) => name.endsWith('.webp')),
    'at least one emote should exist at all'
  );
});
