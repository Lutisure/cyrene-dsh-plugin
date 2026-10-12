/**
 * The skill artifact.
 *
 * There are two ways to talk to her, and they fail differently:
 *
 *   - the **preset** replaces the system prompt and gets the worldbook through a
 *     trigger-word hook;
 *   - the **skill** is a plain markdown file, loaded on demand inside a normal
 *     session, with **no plugin machinery behind it at all**.
 *
 * So the skill has to carry the lore inline or she cannot answer questions about
 * her own world. The version that shipped before this did exactly that — zero
 * mentions of 翁法罗斯, the place she is from — and nothing failed loudly, because
 * a skill missing a paragraph looks identical to a skill that never needed it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assemble, renderSkill } from '../build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The compiled worldbook, as `build.mjs` writes it. */
function compiledBook() {
  return JSON.parse(readFileSync(join(ROOT, 'dist', 'worldbook.json'), 'utf8'));
}

test('the skill carries the whole worldbook, because it has no hook to inject one', () => {
  const { persona, prompt } = assemble(ROOT);
  const book = compiledBook();
  const skill = renderSkill(persona, prompt, book);

  assert.ok(skill.startsWith('---\n'), 'the front matter must still open the file');
  assert.ok(skill.includes('name: cyrene'), 'the front matter must still name the skill');
  assert.ok(skill.includes('user-invocable: true'), 'and stay user-invocable');

  // Every entry's first trigger word is used as the heading for its paragraph, so
  // a missing entry shows up as a missing word.
  for (const entry of book.entries) {
    assert.ok(
      skill.includes(entry.triggers[0]),
      `the skill is missing the "${entry.triggers[0]}" entry — she would not know it`
    );
    assert.ok(skill.includes(entry.text.trim().slice(0, 20)), `the text behind "${entry.id}" must come along`);
  }
  for (const entry of book.always) {
    assert.ok(skill.includes(entry.text.trim().slice(0, 12)), 'the always-on block must be inlined too');
  }
});

test('the skill tells her to admit what is not written down', () => {
  // Without this the inlined lore becomes a floor rather than a ceiling, and she
  // invents the rest — which is the one thing the persona explicitly forbids.
  const { persona, prompt } = assemble(ROOT);
  const skill = renderSkill(persona, prompt, compiledBook());
  assert.ok(skill.includes('没写在这里的设定'), 'the skill must bound her knowledge to what is written');
  assert.ok(skill.includes('不要编'), 'and say what to do instead of guessing');
});

test('rendering without a worldbook still produces a usable skill', () => {
  // The parameter is optional so the renderer stays callable on its own.
  const { persona, prompt } = assemble(ROOT);
  const bare = renderSkill(persona, prompt);
  assert.ok(bare.startsWith('---\n'));
  assert.ok(bare.includes('# 昔涟 · Soul'), 'the soul is the body now, so it must be there with or without a book');
  assert.ok(!bare.includes('你的世界'), 'no empty section when there is no book');
});
