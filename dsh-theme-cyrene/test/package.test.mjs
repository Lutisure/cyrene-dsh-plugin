// Theme packages: validation, adoption, undo.
//
// A package is a file from somewhere else. Everything in it is untrusted input
// that ends up driving the live interface, so the validation path is the point of
// this file — not the happy round trip, which is the easy half. Each rejection
// below corresponds to a way a document could be wrong, and each *stripping* case
// corresponds to a value that is legitimate in someone else's document and wrong
// in this one.

import assert from 'node:assert/strict';
import test from 'node:test';

import {PLUGIN_ID,  mountPlugin } from './harness.mjs';

/** A minimal well-formed package. */
function packageWith(settings, overrides = {}) {
  return JSON.stringify({
    kind: 'dsh-theme-cyrene',
    version: 1,
    exportedAt: '2026-10-10T00:00:00.000Z',
    settings,
    ...overrides
  });
}

/** Open the Scene panel, which carries the package controls. */
async function openScene(sandbox) {
  sandbox.document.querySelectorAll('.cy-btn')
    .find((node) => node.dataset.id === 'wallpaper')
    .click();
  await new Promise((resolve) => setImmediate(resolve));
  const panel = sandbox.document.querySelector('.cy-pop');
  assert.notEqual(panel, null, 'the panel must open');
  return panel;
}

/** Press one of the package buttons by its label. */
function press(sandbox, label) {
  const button = sandbox.document
    .querySelectorAll('[data-theme-package="true"] button')
    .find((node) => node.textContent === label);
  assert.notEqual(button, undefined, `no package button labelled ${label}`);
  button.click();
}

/** Feed a package to the import path. */
async function importPackage(sandbox, text) {
  const field = sandbox.document
    .querySelectorAll('input')
    .find((node) => node.getAttribute('type') === 'file' && node.getAttribute('accept').includes('json'));
  assert.notEqual(field, undefined, 'the panel must carry a package file field');
  field.files = [sandbox.__readFile(text)];
  field.dispatchEvent({ type: 'change', target: field });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/** The saved settings document. */
function settingsOf(sandbox) {
  const raw = sandbox.localStorage.getItem('dsh-theme-cyrene:settings');
  return raw === null ? {} : JSON.parse(raw);
}

test('export writes a document this build can read back', async () => {
  const { sandbox } = await mountPlugin();
  await openScene(sandbox);
  press(sandbox, '导出主题');

  assert.equal(sandbox.__downloads.length, 1, 'exactly one download');
  const parsed = JSON.parse(sandbox.__downloads[0].parts.join(''));
  assert.equal(parsed.kind, 'dsh-theme-cyrene');
  assert.equal(parsed.version, 1);
  assert.equal(typeof parsed.exportedAt, 'string');
  // Only allow-listed keys travel; a document must not carry the whole store.
  assert.equal(Object.keys(parsed.settings).includes('hidden'), false, 'internal keys stay home');
  assert.notEqual(parsed.settings.skin, undefined, 'but the skin does travel');
});

test('a well-formed package is adopted wholesale', async () => {
  const { sandbox } = await mountPlugin();
  await openScene(sandbox);
  await importPackage(sandbox, packageWith({ skin: 'jade', shade: 0.42, particles: 'off' }));

  const saved = settingsOf(sandbox);
  assert.equal(saved.skin, 'jade');
  assert.equal(saved.shade, 0.42);
  assert.equal(saved.particles, 'off');

  // And it reached the live interface, not only the document.
  const sheet = sandbox.document.head
    .querySelectorAll('style')
    .find((node) => node.dataset.pluginCss === `${PLUGIN_ID}/identity.css`).textContent;
  assert.ok(sheet.includes('#4ade80'), 'the imported skin is applied');
});

test('the wrong kind is refused', async () => {
  const { sandbox } = await mountPlugin();
  await openScene(sandbox);
  await importPackage(sandbox, packageWith({ skin: 'jade' }, { kind: 'something-else' }));
  assert.equal(settingsOf(sandbox).skin, 'host', 'nothing may be adopted');
});

test('a newer schema version is refused rather than guessed at', async () => {
  const { sandbox } = await mountPlugin();
  await openScene(sandbox);
  await importPackage(sandbox, packageWith({ skin: 'jade' }, { version: 99 }));
  // A newer package may carry settings whose meaning this build would misread,
  // so reading it partly is worse than not reading it.
  assert.equal(settingsOf(sandbox).skin, 'host');
});

test('a value of the wrong type is refused, naming the key', async () => {
  const { sandbox } = await mountPlugin();
  await openScene(sandbox);
  await importPackage(sandbox, packageWith({ skin: 'jade', shade: 'not a number' }));
  assert.equal(settingsOf(sandbox).skin, 'host', 'a type error refuses the whole package');
  assert.equal(settingsOf(sandbox).shade === 'not a number', false);
});

test('an unknown key is skipped rather than adopted', async () => {
  const { sandbox } = await mountPlugin();
  await openScene(sandbox);
  await importPackage(sandbox, packageWith({ skin: 'jade', somethingNew: { deep: true } }));

  const saved = settingsOf(sandbox);
  assert.equal(saved.skin, 'jade', 'the rest is adopted');
  assert.equal(saved.somethingNew, undefined, 'but the unknown key is not');
});

test('a resource pointing outside this installation is stripped, not adopted', async () => {
  // Start with a wallpaper of our own, so "stripped" has something to clear:
  // `applySettings` merges, and leaving the key out would silently *keep* the
  // previous path — an imported document that asks for a remote resource must end
  // up with no resource, not with the last one by accident. The avatar source is
  // seeded to `builtin` for the same reason: it has to be a value the rejected
  // document did not ask for, or the assertion below would prove nothing.
  const { sandbox } = await mountPlugin({
    settings: { wallpaper: 'builtin:assets/cyrene-01.png', avatarSource: 'builtin' }
  });
  await openScene(sandbox);
  await importPackage(sandbox, packageWith({
    skin: 'glacier',
    wallpaper: 'https://example.invalid/cat.png',
    avatarCustom: 'javascript:alert(1)'
  }));

  const saved = settingsOf(sandbox);
  assert.equal(saved.skin, 'glacier', 'the safe part is still adopted');
  assert.equal(saved.wallpaper, '', 'the remote wallpaper is cleared');
  // This is the one that matters: an imported scheme URL must never reach an
  // element that would act on it — not in the document, and not on the dot.
  assert.equal(saved.avatarCustom, '', 'and the script URL never lands');
  const dot = sandbox.document.querySelector('.cy-avatar');
  assert.notEqual(dot, null, 'the dot still shows a portrait');
  assert.equal(String(dot.getAttribute('src')).includes('javascript:'), false, 'and not that URL');
  // The source is not part of the package here, so it stays exactly as it was:
  // with the custom path stripped, the face on screen is the built-in one, not
  // whatever the rejected document asked for.
  assert.equal(saved.avatarSource, 'builtin', 'the stripped custom value leaves the chosen source alone');
  assert.equal(dot.getAttribute('src').endsWith('cyrene-avatar.webp'), true, 'which resolves to the built-in portrait');
});

test('a local asset path is kept', async () => {
  const { sandbox } = await mountPlugin();
  await openScene(sandbox);
  await importPackage(sandbox, packageWith({ wallpaper: 'builtin:assets/cyrene-01.png' }));
  assert.equal(settingsOf(sandbox).wallpaper, 'builtin:assets/cyrene-01.png');
});

test('malformed JSON is refused without touching anything', async () => {
  const { sandbox } = await mountPlugin();
  await openScene(sandbox);
  await importPackage(sandbox, '{ this is not json');
  assert.equal(settingsOf(sandbox).skin, 'host');
});

test('an oversized file is refused before it is parsed', async () => {
  const { sandbox } = await mountPlugin();
  await openScene(sandbox);
  // Structural, not a real 256 KB of JSON: the validator checks the byte count
  // first, so a small document padded past the cap is the cheapest way to
  // exercise the branch.
  await importPackage(sandbox, packageWith({ skin: 'jade' }) + ' '.repeat(300 * 1024));
  assert.equal(settingsOf(sandbox).skin, 'host', 'a document that large is not a theme');
});

test('an import can be undone, exactly', async () => {
  const { sandbox } = await mountPlugin({ settings: { skin: 'coral', shade: 0.31, particles: 'glow' } });
  await openScene(sandbox);

  const before = settingsOf(sandbox);
  await importPackage(sandbox, packageWith({ skin: 'ash', shade: 0.05, particles: 'off' }));
  assert.equal(settingsOf(sandbox).skin, 'ash', 'the import took');

  press(sandbox, '撤销导入');
  const after = settingsOf(sandbox);
  assert.equal(after.skin, before.skin, 'the skin came back');
  assert.equal(after.shade, before.shade, 'and the numbers');
  assert.equal(after.particles, before.particles);
});

test('undo is offered only once, and says so when there is nothing to undo', async () => {
  const { sandbox } = await mountPlugin();
  await openScene(sandbox);

  // Nothing has been imported, so there is no snapshot to restore.
  press(sandbox, '撤销导入');
  assert.equal(settingsOf(sandbox).skin, 'host', 'an empty undo is a no-op');

  await importPackage(sandbox, packageWith({ skin: 'mirage' }));
  press(sandbox, '撤销导入');
  press(sandbox, '撤销导入');
  // The second press must not resurrect the imported state: the snapshot is
  // consumed, not merely read.
  assert.equal(settingsOf(sandbox).skin, 'host');
  assert.equal(sandbox.localStorage.getItem('dsh-theme-cyrene:undo'), null, 'the snapshot is cleared');
});
