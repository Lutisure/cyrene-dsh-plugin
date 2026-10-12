// The avatar.
//
// The theme owns one avatar surface — the collapsed dock dot — and the interesting
// part is not that an image renders. It is that the three sources resolve the way
// they say they do, and that every failure lands on the plain circle rather than
// on an empty button the user cannot click.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { BUNDLE, mountPlugin } from './harness.mjs';

/** The collapsed dot. */
function dot(sandbox) {
  return sandbox.document.querySelector('.cy-dot');
}

/**
 * The face the build ships as the factory default.
 *
 * Read out of the built bundle rather than pasted here: since 2026-10-11 a fresh
 * install starts on the author's own portrait, stored as a data URL, and pasting
 * 7515 characters into a test would fail to say anything about the bundle that
 * actually mounted. Reading it keeps this a statement about the shipped default,
 * and it keeps this file honest when `CYRENE_BUNDLE` points at someone else's
 * build — the default in *that* bundle is the one being asserted.
 *
 * @returns {string} the `avatarCustom` default, a `data:image/…` URL.
 */
function shippedCustomAvatar() {
  const found = [...readFileSync(BUNDLE, 'utf8').matchAll(/avatarSource:\s*"([^"]*)",\s*avatarCustom:\s*"([^"]*)"/gu)];
  assert.equal(found.length, 1, `expected one avatarSource/avatarCustom default pair in the bundle, saw ${found.length}`);
  return found[0][2];
}

/** The mirrored settings document. */
function settingsOf(sandbox) {
  const raw = sandbox.localStorage.getItem('dsh-theme-cyrene:settings');
  return raw === null ? {} : JSON.parse(raw);
}

/** Its portrait, or null. */
function portrait(sandbox) {
  return dot(sandbox).querySelector('.cy-avatar');
}

/** Open the Scene panel, which carries the avatar controls. */
async function openScene(sandbox) {
  sandbox.document.querySelectorAll('.cy-btn')
    .find((node) => node.textContent === 'Scene')
    .click();
  await new Promise((resolve) => setImmediate(resolve));
  return sandbox.document.querySelector('.cy-pop');
}

/** Press one of the avatar buttons by its label. */
function press(panel, label) {
  const button = panel.querySelectorAll('button').find((node) => node.textContent === label);
  assert.notEqual(button, undefined, `no button labelled ${label}`);
  button.click();
}

test('the factory default is the author\'s portrait, carried as a data URL', async () => {
  // The default changed on 2026-10-11: a fresh install no longer points at
  // `brand/cyrene-avatar.webp`, it carries the author's own picture inline. So the
  // default is asserted as what it is now — a non-empty `data:image/` payload —
  // and the *built-in* file path is exercised on its own below, where it is asked
  // for by name rather than relied on as the default.
  const shipped = shippedCustomAvatar();
  assert.equal(shipped.startsWith('data:image/'), true, `the shipped default must be a data URL, saw ${shipped.slice(0, 40)}`);

  const { sandbox } = await mountPlugin();
  const image = portrait(sandbox);
  assert.notEqual(image, null, 'the dot renders the portrait');
  assert.equal(dot(sandbox).textContent, '', 'and not the plain glyph');
  assert.equal(settingsOf(sandbox).avatarSource, 'custom', 'and the source is the custom one');
  assert.equal(image.getAttribute('src'), shipped, 'the bytes that ship are the bytes on screen');
  assert.equal(image.getAttribute('alt'), '昔涟', 'the portrait is described');
});

test('the built-in portrait is what `builtin` resolves to', async () => {
  // The other half of the pair: the file that ships inside the theme is still
  // reachable. It is no longer the default, so the test asks for it directly.
  const { sandbox } = await mountPlugin({ settings: { avatarSource: 'builtin' } });
  const image = portrait(sandbox);
  assert.notEqual(image, null, 'the dot renders the portrait');
  assert.equal(dot(sandbox).textContent, '', 'and not the plain glyph');
  assert.equal(image.getAttribute('src').endsWith('cyrene-avatar.webp'), true);
  assert.equal(image.getAttribute('alt'), '昔涟', 'the portrait is described');
});

test('reverting to the default puts the portrait back after a custom one', async () => {
  const { sandbox } = await mountPlugin({
    settings: { avatarSource: 'custom', avatarCustom: 'data:image/webp;base64,AAAA' }
  });
  assert.equal(portrait(sandbox).getAttribute('src'), 'data:image/webp;base64,AAAA', 'the custom face is used');

  const panel = await openScene(sandbox);
  press(panel, '回复默认');
  assert.equal(settingsOf(sandbox).avatarSource, 'builtin', 'the revert selects the built-in source');
  assert.equal(
    portrait(sandbox).getAttribute('src').endsWith('cyrene-avatar.webp'),
    true,
    'and the built-in one comes back'
  );
});

test('the no-avatar option leaves a usable plain circle', async () => {
  const { sandbox } = await mountPlugin();
  const panel = await openScene(sandbox);
  press(panel, '不要头像');

  assert.equal(portrait(sandbox), null, 'no portrait');
  assert.equal(dot(sandbox).textContent, '●', 'replaced by the glyph, not by nothing');
});

test('picking a file downscales it and stores the result in settings', async () => {
  const { sandbox } = await mountPlugin();
  const panel = await openScene(sandbox);

  const field = panel.querySelectorAll('input')
    .find((node) => node.getAttribute('type') === 'file');
  assert.notEqual(field, undefined, 'the panel must carry a file field');
  assert.equal(field.getAttribute('accept'), 'image/*', 'and only offer images');

  // A large image: 1200×600 must come back inside the 160-pixel box, which is
  // what keeps a camera-sized original out of the settings document.
  field.files = [{ name: 'face.png', type: 'image/png' }];
  field.dispatchEvent({ type: 'change', target: field });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const saved = sandbox.localStorage.getItem('dsh-theme-cyrene:settings');
  const parsed = saved === null ? {} : JSON.parse(saved);
  assert.equal(parsed.avatarSource, 'custom', 'the source switches to custom');
  assert.equal(String(parsed.avatarCustom).startsWith('data:image/'), true,
    `a data URL is stored, saw ${String(parsed.avatarCustom).slice(0, 40)}`);

  // The data URL carries the downscaled size: 1200×600 becomes 160×80, not a
  // camera-sized original.
  assert.ok(parsed.avatarCustom.includes('W160H80'), `expected a 160×80 encode, saw ${parsed.avatarCustom}`);

  // And the dot is already showing it.
  assert.equal(portrait(sandbox).getAttribute('src'), parsed.avatarCustom);
});

test('a custom value that is not an image falls back to the built-in portrait', async () => {
  // A half-set or invalid custom avatar must not cost the face that already
  // worked, and the value must never reach the DOM unchecked — only
  // `data:image/…` is accepted. The starting source is pinned to `builtin` so
  // this is a statement about the fallback rather than about today's default.
  const { sandbox } = await mountPlugin({ settings: { avatarSource: 'builtin' } });
  assert.equal(
    portrait(sandbox).getAttribute('src').endsWith('cyrene-avatar.webp'),
    true,
    'the built-in portrait is on screen before the patch'
  );

  sandbox.__applySettings({ avatarCustom: 'javascript:alert(1)' });
  const image = portrait(sandbox);
  assert.notEqual(image, null, 'the portrait is still there');
  assert.equal(
    image.getAttribute('src').endsWith('cyrene-avatar.webp'),
    true,
    'the rejected value never reaches the element'
  );
  assert.equal(String(image.getAttribute('src')).includes('javascript:'), false);
});

test('a portrait that fails to load degrades to the circle', async () => {
  const { sandbox } = await mountPlugin({ settings: { avatarSource: 'custom', avatarCustom: 'data:image/webp;base64,broken' } });
  const image = portrait(sandbox);
  assert.notEqual(image, null, 'it renders first');

  // A broken image fires `error`; the dot must stay clickable rather than become
  // an empty button.
  image.dispatchEvent({ type: 'error', target: image });
  assert.equal(portrait(sandbox), null, 'the portrait is dropped');
  assert.equal(dot(sandbox).textContent, '●', 'and the glyph takes its place');
});
