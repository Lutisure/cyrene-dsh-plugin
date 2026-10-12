/**
 * Tests for the persona builder.
 *
 * The validation rules are the point: a silently-accepted typo in the data
 * file produces a persona that quietly behaves wrong, which is far worse than
 * a build that refuses to run.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assemble,
  createReport,
  parseYaml,
  render,
  PLACEHOLDER,
  renderPatch,
  renderSkill,
  slugOf,
  validateDialogues,
  validatePatchYaml,
  validatePersona
} from '../build.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A minimal persona that should validate cleanly. */
const MINIMAL_PERSONA = {
  meta: { name: '测试', essence: '一个用于测试的角色。' },
  identity: { selfReference: ['我'], address: ['你'] },
  voice: { tone: ['平静'], avoid: ['官腔'] },
  behaviour: ['不作假']
};

/** A minimal, valid dialogue set. */
const MINIMAL_DIALOGUES = {
  dialogues: [{ user: '在吗', assistant: '在的。', why: '开场' }]
};

test('the shipped prompt carries no leftover game markup', () => {
  // An end-to-end guard. The earlier verification of this was done with a
  // PowerShell read that defaulted to the ANSI code page, so Chinese was
  // mangled and the search silently found nothing — the defect shipped.
  // Asserting it in a test, in-process, removes that whole failure mode.
  const { prompt } = assemble(ROOT);
  assert.notEqual(prompt, null);

  const leftovers = [
    [/\{[A-Z][A-Z_]{2,}\}/gu, 'engine variable'],
    [/\{RUBY_[A-Z]+#/gu, 'ruby annotation'],
    [/<\/?(?:color|unbreak|size|align)/giu, 'formatting tag'],
    [/\[[\u3040-\u30ff\u4e00-\u9fff]{2,8}\]/gu, 'emote marker'],
    [/\\n/gu, 'escaped newline']
  ];
  for (const [pattern, label] of leftovers) {
    const found = prompt.match(pattern);
    assert.equal(found, null, `${label} leaked into the prompt: ${JSON.stringify(found)}`);
  }

  // And the address placeholder must have become a word, not a hole.
  const broken = prompt.match(/嘻，那就期待的[^你]/u);
  assert.equal(broken, null, `an address placeholder was deleted rather than substituted: ${broken}`);
});

test('the shipped persona data assembles into a prompt', async () => {
  const { prompt, report, persona, dialogues } = assemble(ROOT);
  assert.deepEqual(report.problems, [], 'the shipped data must be valid');
  assert.notEqual(prompt, null);
  assert.equal(persona.meta.name, '昔涟');
  assert.ok(dialogues.dialogues.length >= 8);

  // The template's unfilled slots are flagged, not fatal.
  assert.ok(report.warnings.some((line) => line.includes('placeholder')), 'unfinished placeholders must be reported');

  // The narrative headings only exist when there is no soul. With one, the soul
  // supplies them (and says the opposite about reply length), so the markers to
  // look for are the soul's own.
  for (const heading of ['# 昔涟 · Soul', '### 明亮而不轻浮', '## 禁止行为', '## 语感示例']) {
    assert.ok(prompt.includes(heading), `the prompt must contain ${heading}`);
  }
  // Every example reaches the prompt, labelled with the character's name.
  assert.ok(prompt.includes('用户：在吗'));
  assert.ok(prompt.includes('昔涟：在的呀'));
  // The examples come after the soul, so they read as the worked form of it.
  assert.ok(prompt.indexOf('## 语感示例') > prompt.indexOf('# 昔涟 · Soul'));
  // The address rule survives either way, and it is the one piece of the old
  // narrative that is kept alongside a soul — the soul delegates the name to a
  // template variable and never says that 伙伴 is a vocative.
  assert.ok(prompt.includes('呼语'), 'the vocative rule must reach the prompt');

  // The configured form of address must actually reach the prompt. Asserting
  // the *rendering*, not a particular name, so changing the preference later
  // does not require editing the test — but a broken render still fails.
  const configuredAddress = persona.identity.address[0];
  // Asserting the *fact* rather than one rendering of it: with a soul present the
  // narrative line that spelled out 「称呼对方：…」 is skipped, and the address
  // arrives through the soul instead. What must not break is that the chosen form
  // of address reaches the model at all, alongside the rule that it is a vocative.
  assert.ok(
    prompt.includes(configuredAddress),
    `the configured address ${JSON.stringify(configuredAddress)} must appear in the prompt`
  );
  assert.ok(prompt.includes('呼语'), 'and the rule about how to use it must come with it');
});

test('a valid minimal persona renders every required section', () => {
  const prompt = render(MINIMAL_PERSONA, MINIMAL_DIALOGUES);
  assert.ok(prompt.startsWith('# 你是「测试」'));
  assert.ok(prompt.includes('## 你是谁'));
  assert.ok(prompt.includes('## 你怎么说话'));
  assert.ok(prompt.includes('## 硬规则'));
  assert.ok(prompt.includes('用户：在吗'));
  assert.ok(prompt.includes('测试：在的。'));
  // Sections with no data are omitted rather than rendered empty.
  assert.ok(!prompt.includes('## 情绪怎么表现'));
  assert.ok(!prompt.includes('## 你和对方的关系'));
});

test('missing required fields are rejected, and all of them are reported at once', () => {
  const report = createReport();
  const ok = validatePersona({
    meta: { name: 'x' }, // essence missing
    identity: { selfReference: [], address: 'you' }, // empty list + wrong type
    voice: { tone: 'calm' }, // wrong type
    behaviour: []
  }, report);

  assert.equal(ok, false);
  const joined = report.problems.join('\n');
  assert.ok(joined.includes('meta.essence'), joined);
  assert.ok(joined.includes('identity.selfReference'), joined);
  assert.ok(joined.includes('identity.address'), joined);
  assert.ok(joined.includes('voice.tone'), joined);
  assert.ok(joined.includes('voice.avoid'), joined);
  assert.ok(joined.includes('behaviour'), joined);
  // Fail-fast would have stopped at the first one.
  assert.ok(report.problems.length >= 6, `expected several problems, got ${report.problems.length}`);
});

test('placeholder text warns without blocking the build', () => {
  const report = createReport();
  const ok = validatePersona({
    ...MINIMAL_PERSONA,
    meta: { name: '测试', essence: '（待你填写）她的来历。' },
    identity: { selfReference: ['我'], address: ['你'], origin: '待填写' }
  }, report);

  assert.equal(ok, true, 'a placeholder must not fail the build');
  assert.ok(report.warnings.some((line) => line.includes('meta.essence')));
  assert.ok(report.warnings.some((line) => line.includes('identity.origin')));
});

test('a placeholder section is left out of the prompt instead of shipped', () => {
  const prompt = render({
    ...MINIMAL_PERSONA,
    identity: { selfReference: ['我'], address: ['你'], origin: '（待你填写）她的来历。' }
  }, MINIMAL_DIALOGUES);
  assert.ok(!prompt.includes('待你填写'), 'unfinished prose must not reach the model');
});

test('dialogue problems are caught with their index', () => {
  const report = createReport();
  const ok = validateDialogues({
    dialogues: [
      { user: 'a', assistant: 'b' },
      { user: 'missing assistant' },
      'not a mapping'
    ]
  }, report);

  assert.equal(ok, false);
  const joined = report.problems.join('\n');
  assert.ok(joined.includes('dialogues.dialogues[1].assistant'), joined);
  assert.ok(joined.includes('dialogues.dialogues[2]'), joined);
  // The two well-formed-enough entries lack `why`, which is a warning only.
  assert.ok(report.warnings.some((line) => line.includes('why')));
});

test('too few examples warns, an empty list fails', () => {
  const thin = createReport();
  assert.equal(validateDialogues({ dialogues: [{ user: 'a', assistant: 'b', why: 'x' }] }, thin), true);
  assert.ok(thin.warnings.some((line) => line.includes('pins the voice down')));

  const empty = createReport();
  assert.equal(validateDialogues({ dialogues: [] }, empty), false);
  assert.ok(empty.problems.some((line) => line.includes('at least one')));
});

test('a YAML parse error names the file and the line', () => {
  const report = createReport();
  const parsed = parseYaml('meta:\n  name: "unterminated\n', 'persona.yaml', report);
  assert.equal(parsed, undefined);
  assert.equal(report.problems.length, 1);
  assert.ok(report.problems[0].startsWith('persona.yaml:'), report.problems[0]);
});

test('a missing data file is a clear failure, not a crash', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'cyrene-agent-'));
  try {
    writeFileSync(join(scratch, 'persona.yaml'), 'meta:\n  name: x\n');
    const { prompt, report } = assemble(scratch);
    assert.equal(prompt, null);
    const joined = report.problems.join('\n');
    assert.ok(joined.includes('dialogues.yaml'), joined);
    assert.ok(joined.includes('missing'), joined);
    // persona.yaml itself parsed, so its own missing essence is reported too.
    assert.ok(joined.includes('meta.essence'), joined);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('an empty document is rejected rather than silently accepted', () => {
  const report = createReport();
  assert.equal(parseYaml('# only a comment\n', 'persona.yaml', report), undefined);
  assert.ok(report.problems[0].includes('empty'));
});

/* ------------------------------------------------------------------ *
 * Emitted artifacts
 * ------------------------------------------------------------------ */

test('the slug is derived from the romanised name, and validated when explicit', () => {
  assert.equal(slugOf({ meta: { name: 'x', romanized: 'Cyrene' } }), 'cyrene');
  assert.equal(slugOf({ meta: { name: 'x', romanized: 'A B/C' } }), 'a-b-c');
  assert.equal(slugOf({ meta: { name: 'x' } }), 'character');
  assert.equal(slugOf({ meta: { name: 'x', romanized: '昔涟' } }), 'character', 'non-latin falls back');

  // The harness enforces this pattern and silently drops a skill that breaks
  // it, so a bad slug must be a build error here.
  const bad = createReport();
  assert.equal(validatePersona({ ...MINIMAL_PERSONA, meta: { name: 'x', essence: 'y', slug: 'Cyrene_01' } }, bad), false);
  assert.ok(bad.problems.some((line) => line.includes('meta.slug')));

  const good = createReport();
  assert.equal(validatePersona({ ...MINIMAL_PERSONA, meta: { name: 'x', essence: 'y', slug: 'cyrene-2' } }, good), true);
});

test('the emitted skill carries front matter the harness will accept', () => {
  const skill = renderSkill(MINIMAL_PERSONA, '正文内容');
  assert.ok(skill.startsWith('---\n'), 'front matter must open the file');
  const end = skill.indexOf('\n---\n', 4);
  assert.ok(end > 0, 'front matter must be closed');

  const front = skill.slice(4, end);
  const nameMatch = /^name:\s*(.+)$/mu.exec(front);
  assert.notEqual(nameMatch, null, 'name is required');
  const name = nameMatch[1].trim().replace(/^"|"$/gu, '');
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, `name "${name}" must match the harness pattern`);

  assert.match(front, /^description:\s*".+"$/mu, 'description is required and must be quoted');
  assert.match(front, /^user-invocable:\s*true$/mu);
  // Legacy camelCase aliases are hard-rejected by the harness.
  assert.ok(!/userInvocable|disableModelInvocation|modelInvocable/u.test(front), 'camelCase aliases must not appear');

  assert.ok(skill.includes('正文内容'), 'the prompt is the skill body');
});

test('a quote inside the description cannot break the front matter', () => {
  const skill = renderSkill({
    ...MINIMAL_PERSONA,
    meta: { name: '测试', essence: '带 "引号" 与: 冒号的内核' }
  }, 'body');
  const end = skill.indexOf('\n---\n', 4);
  const front = skill.slice(4, end);
  // Parsing the front matter as YAML is the real assertion.
  const parsed = parseYaml(front, 'front', createReport());
  assert.notEqual(parsed, undefined);
  assert.ok(parsed.description.includes('引号'));
});

test('every template variable in the preset is backed by a plugin row', () => {
  // ⚠️ This guards a hard failure, not a cosmetic one. A `{{...}}` that is
  // referenced but never registered makes dsh-system-prompt **throw**, which
  // fails the whole assembly — the preset stops working, not just its own
  // paragraph. So the placeholders and the rows that provide them are emitted by
  // the same file and are asserted together here.
  const { prompt } = assemble(ROOT);
  assert.notEqual(prompt, null);
  const patch = renderPatch({ ...MINIMAL_PERSONA, meta: { name: '昔涟', essence: '一句话', slug: 'cyrene' } });

  const owner = { cyrene_persona: 'cyrene-agent/persona' };
  const referenced = [
    ...prompt.matchAll(/\{\{([a-z_][a-z0-9_]*)\}\}/gu),
    ...patch.matchAll(/\{\{([a-z_][a-z0-9_]*)\}\}/gu)
  ].map((match) => match[1]);

  assert.ok(referenced.includes('cyrene_persona'), 'the patch must carry the persona placeholder');

  // ⚠️ The persona body must contain NO placeholders of its own.
  //
  // Interpolation scans a section's text once and never re-scans a value it
  // substituted in. Since this body arrives as the value of `{{cyrene_persona}}`,
  // anything nested inside it survives verbatim into the finished prompt — a
  // `{{cyrene_memory}}` there put the literal string in front of the model. This
  // was found by assembling against the real `dsh-system-prompt`, not by reading.
  const nested = [...prompt.matchAll(/\{\{([a-z_][a-z0-9_]*)\}\}/gu)].map((match) => match[1]);
  assert.deepEqual(
    nested,
    [],
    `the persona body must not reference template variables; found ${nested.join(', ')}. ` +
      'Use a context() block instead — nesting does not interpolate.'
  );

  for (const name of new Set(referenced)) {
    const provider = owner[name];
    assert.ok(provider !== undefined, `{{${name}}} is referenced but no provider is declared for it`);
    assert.ok(patch.includes(provider), `{{${name}}} is referenced but the patch has no ${provider} row`);
  }

  // Every variable-registering row must mount before the persona that uses them.
  const personaAt = patch.indexOf("name: '@deepseek-ai/dsh-persona'");
  for (const provider of Object.values(owner)) {
    const at = patch.indexOf(provider);
    assert.ok(at !== -1 && at < personaAt, `${provider} must be mounted before the persona references its variable`);
  }
});

test('the emitted patch carries the persona by reference, not by value', () => {
  const report = createReport();
  const patch = renderPatch({ ...MINIMAL_PERSONA, meta: { name: '昔涟', essence: '一句话', slug: 'cyrene' } });
  assert.equal(validatePatchYaml(patch, report), true, report.problems.join('\n'));
  assert.ok(patch.includes('preset-cyrene'));
  assert.ok(patch.includes('@deepseek-ai/dsh-agent-preset'));
  assert.ok(patch.includes('@deepseek-ai/dsh-persona'));

  // The body is not inlined. Inlining it meant several kilobytes of Chinese had
  // to survive YAML escaping and block-scalar indentation, where a single wrong
  // character is a DSH that will not boot — and it meant every persona edit cost
  // a rebuild, a patch rewrite and a restart. It now arrives through a variable
  // that is interpolated on each assembly, so the file behind it is hot.
  assert.ok(patch.includes(PLACEHOLDER), 'the prefix must be the placeholder');
  assert.ok(!patch.includes('# 你是'), 'no prose may be inlined');
  assert.ok(patch.length < 6000, `the patch should be small now, got ${patch.length} bytes`);

  // A provider row missing from the preset would make the placeholder throw at
  // assembly time, so it is part of the same contract. The indentation is
  // captured rather than matched with `\s*`: `\s` includes newlines, so a greedy
  // run would swallow the preceding line break and break the YAML instead of
  // exercising the check.
  const withoutProvider = patch.replace(
    /^(\s*)name: 'cyrene-agent\/persona'$/mu,
    "$1name: 'cyrene-agent/not-the-provider'"
  );
  assert.notEqual(withoutProvider, patch, 'the provider row must have been found and renamed');
  const orphaned = createReport();
  assert.equal(validatePatchYaml(withoutProvider, orphaned), false);
  assert.ok(
    orphaned.problems.some((line) => line.includes('no provider')),
    `expected a missing-provider complaint, got ${JSON.stringify(orphaned.problems)}`
  );
});

test('malformed patches are caught before they can break boot', () => {
  const cases = [
    ['empty file', '', 'non-empty'],
    ['not a list', 'foo: bar\n', 'non-empty'],
    ['no insert', '- id: x\n', 'insert'],
    ['wrong plugin', '- insert:\n    - id: p\n      name: nope\n      config:\n        plugins: []\n', 'dsh-agent-preset'],
    ['no plugins', "- insert:\n    - id: p\n      name: '@deepseek-ai/dsh-agent-preset'\n      config: {}\n", 'plugins'],
    ['no persona row', "- insert:\n    - id: p\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        plugins:\n          - id: x\n            name: 'y'\n", 'dsh-persona'],
    // A preset that declares a persona but not the four plugins feeding it is a
    // likeness rather than her, and nothing in the UI says so. The persona and
    // its provider are already present in this fixture, so a complaint here can
    // only come from the core-plugin check.
    [
      'missing core plugins',
      "- insert:\n    - id: p\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        id: cyrene\n        plugins:\n          - id: persona\n            name: '@deepseek-ai/dsh-persona'\n            config:\n              prefix: '{{cyrene_persona}}'\n          - id: provider\n            name: 'cyrene-agent/persona'\n",
      'worldbook'
    ],
    ['unparsed yaml', '- insert: [\n', 'cordis.patch.yml']
  ];
  for (const [label, text, expected] of cases) {
    const report = createReport();
    assert.equal(validatePatchYaml(text, report), false, `${label} must be rejected`);
    assert.ok(
      report.problems.some((line) => line.includes(expected)),
      `${label}: expected a problem mentioning "${expected}", got ${JSON.stringify(report.problems)}`
    );
  }
});
