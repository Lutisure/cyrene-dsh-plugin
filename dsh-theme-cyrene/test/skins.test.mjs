// Skins: the eight Mirage presets.
//
// The thing that matters most here is not that a skin changes colours. It is
// that the *identity* survives one. This theme is 昔涟 — her palette, her
// emotes, the disc artwork, the pet — and the brief for this work was explicit
// that those must not be collateral damage. So the tests below check both
// directions: a skin moves the chrome, and switching back restores the shipped
// values exactly, with the asset paths never touched at all.

import assert from 'node:assert/strict';
import test from 'node:test';

import {PLUGIN_ID,  mountPlugin } from './harness.mjs';
import { loadTheme } from '../tools/palette.mjs';

/** The identity sheet's text, or null. */
function identitySheet(sandbox) {
  const sheet = sandbox.document.head
    .querySelectorAll('style')
    .find((node) => node.dataset.pluginCss === `${PLUGIN_ID}/identity.css`);
  return sheet === undefined ? null : sheet.textContent;
}

/** One token's declared value in the identity sheet. */
function tokenOf(sandbox, name) {
  const text = identitySheet(sandbox);
  if (text === null) return null;
  // No escaping of `-`: inside a character class or outside one it is literal,
  // and `\-` is an invalid escape under the `u` flag.
  const match = new RegExp(`${name}:\\s*([^;]+);`, 'u').exec(text);
  return match === null ? null : match[1].trim();
}

/** Open the Scene panel, which carries the skin picker. */
async function openScene(sandbox) {
  sandbox.document.querySelectorAll('.cy-btn')
    .find((node) => node.dataset.id === 'wallpaper')
    .click();
  await new Promise((resolve) => setImmediate(resolve));
  const panel = sandbox.document.querySelector('.cy-pop');
  assert.notEqual(panel, null, 'the panel must open');
  return panel;
}

/** Press a skin button by its label. */
function chooseSkin(sandbox, label) {
  const button = sandbox.document
    .querySelectorAll('[data-skins="true"] button')
    .find((node) => node.textContent === label);
  assert.notEqual(button, undefined, `no skin labelled ${label}`);
  button.click();
}

/** The skin buttons, in declaration order. */
function skinLabels(sandbox) {
  return sandbox.document.querySelectorAll('[data-skins="true"] button').map((node) => node.textContent);
}

test('all eight presets are offered, with 薄暮 active to start', async () => {
  const { sandbox } = await mountPlugin();
  await openScene(sandbox);

  const labels = skinLabels(sandbox);
  assert.equal(labels.length, 8, `expected eight skins, saw ${labels.length}`);
  // The shipped palette is the Dusk one now, so the label moved with it. Only
  // the label: the id below it stays `host`, which is what a settings document
  // already holds.
  assert.equal(labels[0], '薄暮 · 昔涟', 'the shipped palette comes first');

  const active = sandbox.document
    .querySelectorAll('[data-skins="true"] button')
    .filter((node) => node.getAttribute('data-on') === 'true');
  assert.deepEqual(active.map((node) => node.textContent), ['薄暮 · 昔涟']);
});

test('the shipped skin is emitted identically to a theme that never had skins', async () => {
  const { sandbox } = await mountPlugin();
  // The concern this answers: the derivation was moved into a refreshable
  // function and the token table rebuilt at load. A regression there would
  // recolour every existing install on upgrade, so what the shipped skin emits
  // is pinned here rather than described.
  //
  // Pinned as a derivation rather than as three literals. The surface is
  // `THEME.ink` at `THEME.alpha.base`, and the whole point of a palette is that
  // those inputs are free to move — pasting today's numbers would mean the test
  // failed on the next deliberate repaint and said nothing about the wiring.
  // Reading them out of `10-constants.js` keeps this a statement about the
  // derivation: the skin path has to reproduce exactly what the constants
  // produce, whatever the 薄暮 ladder happens to hold.
  const { THEME, TOKENS } = loadTheme();
  const ink = TOKENS['--dsw-alias-bg-base'];
  assert.match(ink, /^rgba\(/u, 'the base surface is a translucent rgba');
  assert.equal(
    tokenOf(sandbox, '--dsw-alias-bg-base'),
    `${ink} !important`,
    'the shipped skin must emit the same base surface the constants derive'
  );
  assert.equal(tokenOf(sandbox, '--dsw-alias-label-primary'), `${THEME.text} !important`, 'and the text colour');
  assert.equal(
    tokenOf(sandbox, '--dsw-alias-state-business-primary'),
    `${THEME.info} !important`,
    'and the accent'
  );
});

test('choosing a skin recolours the accents and the chrome', async () => {
  const { sandbox } = await mountPlugin();
  await openScene(sandbox);

  const before = tokenOf(sandbox, '--dsw-alias-state-business-primary');
  chooseSkin(sandbox, '冰河');

  const sheet = identitySheet(sandbox);
  // The accent is the theme's own token for its primary state colour, which the
  // caret and focus rings read.
  assert.ok(sheet.includes('#8ed0ff'), 'the glacier accent must reach the sheet');

  // And the chrome takes the skin's hue rather than the shipped violet.
  const ink = tokenOf(sandbox, '--dsw-alias-bg-base');
  assert.notEqual(ink, before, 'the surface must move with the skin');
  assert.ok(ink.startsWith('rgba('), `expected an rgba surface, saw ${ink}`);
});

test('every preset produces a distinct chrome and a visible accent', async () => {
  const { sandbox } = await mountPlugin();
  await openScene(sandbox);

  const seen = new Map();
  for (const label of skinLabels(sandbox)) {
    chooseSkin(sandbox, label);
    const ink = tokenOf(sandbox, '--dsw-alias-bg-base');
    assert.notEqual(ink, null, `${label} must produce a surface`);
    assert.equal(seen.has(ink), false, `${label} shares a surface with ${seen.get(ink)} — the presets must differ`);
    seen.set(ink, label);
  }
  assert.equal(seen.size, 8, 'all eight must be distinct');
});

test('switching back restores the shipped values exactly', async () => {
  const { sandbox } = await mountPlugin();
  await openScene(sandbox);

  // Read out of the constants rather than pasted: the skin path has to land on
  // the same palette the theme ships, so the expectation is derived from that
  // palette. A skin that leaves a stale value behind fails on the numbers below
  // however the ladder is retuned.
  const { THEME } = loadTheme();

  const before = {
    ink: tokenOf(sandbox, '--dsw-alias-bg-base'),
    surface: tokenOf(sandbox, '--dsw-alias-bg-layer-2'),
    accent: tokenOf(sandbox, '--dsw-alias-state-business-primary'),
    text: tokenOf(sandbox, '--dsw-alias-label-primary')
  };

  chooseSkin(sandbox, '余烬');
  assert.notEqual(tokenOf(sandbox, '--dsw-alias-bg-base'), before.ink, 'the skin took effect');

  chooseSkin(sandbox, '薄暮 · 昔涟');
  assert.deepEqual({
    ink: tokenOf(sandbox, '--dsw-alias-bg-base'),
    surface: tokenOf(sandbox, '--dsw-alias-bg-layer-2'),
    accent: tokenOf(sandbox, '--dsw-alias-state-business-primary'),
    text: tokenOf(sandbox, '--dsw-alias-label-primary')
  }, before, 'the original palette must come back byte for byte');
  assert.equal(before.text, `${THEME.text} !important`, 'and it is the shipped text colour');
});

test('a skin never touches the wallpaper, the emotes, the disc or the pet', async () => {
  // The avatar source is pinned to `builtin`, so the face on the dot is a file
  // under `/theme-cyrene-assets/` and this can assert that a skin leaves it where
  // it is. A default `custom` face is a data URL, which never appears in the asset
  // list below and would have made the old assertion vacuous.
  const { sandbox } = await mountPlugin({ settings: { avatarSource: 'builtin' } });
  await openScene(sandbox);

  /** Every asset URL the plugin has rendered. */
  const assets = () => sandbox.document
    .querySelectorAll('img, [style]')
    .map((node) => `${node.getAttribute('src') ?? ''} ${node.getAttribute('style') ?? ''}`)
    .join(' ')
    .split(/\s+/u)
    .filter((part) => part.includes('/theme-cyrene-assets/'))
    .sort();

  const before = assets();
  chooseSkin(sandbox, '青玉');
  const after = assets();

  assert.deepEqual(after, before, 'the artwork is files, not colours — nothing may move');
  // And the portrait specifically, since it is the identity's face.
  const portrait = sandbox.document.querySelector('.cy-dot .cy-avatar');
  assert.notEqual(portrait, null, 'her portrait is still the collapsed dot');
  assert.equal(portrait.getAttribute('src').endsWith('cyrene-avatar.webp'), true);
});

test('the skin is remembered in the settings document', async () => {
  const { sandbox } = await mountPlugin();
  await openScene(sandbox);
  chooseSkin(sandbox, '星穹');

  const raw = sandbox.localStorage.getItem('dsh-theme-cyrene:settings');
  assert.notEqual(raw, null);
  assert.equal(JSON.parse(raw).skin, 'astral');
});

test('a stored skin is applied on the next load, without opening the panel', async () => {
  const { sandbox } = await mountPlugin({ settings: { skin: 'jade' } });
  // No panel interaction at all: this is what a restart looks like.
  const sheet = identitySheet(sandbox);
  assert.ok(sheet.includes('#4ade80'), `the jade accent must be applied at mount, saw ${sheet.slice(0, 200)}`);
  assert.equal(sheet.includes('#d946ef'), false, 'and the shipped pink must not be');
});

test('an unknown skin id falls back to the shipped palette', async () => {
  // A settings file written by a future version must not leave the theme
  // half-defined; the theme is the one place a wrong value is visible everywhere.
  const { sandbox } = await mountPlugin({ settings: { skin: 'from-a-future-version' } });
  const { THEME } = loadTheme();
  const sheet = identitySheet(sandbox);
  // `THEME.pinkStrong` is the 薄暮 accent, and it is the one a fallback must
  // reproduce. Reading it from the constants rather than pasting the hex keeps
  // the test about the fallback rather than about today's palette.
  assert.ok(sheet.includes(THEME.pinkStrong), 'the shipped accent stands in');
  assert.equal(sheet.includes('undefined'), false, 'and nothing leaks');
});

test('the plugin stylesheet is rebuilt too, not only the tokens', async () => {
  const { sandbox } = await mountPlugin();
  await openScene(sandbox);

  const controls = () => sandbox.document.head
    .querySelectorAll('style')
    .find((node) => node.dataset.pluginCss === `${PLUGIN_ID}/controls.css`).textContent;

  const before = controls();
  // The dock and the popovers carry the accent directly in their own rules, so a
  // token-only refresh would leave the chrome around them on the old palette.
  chooseSkin(sandbox, '珊瑚');
  const after = controls();

  assert.notEqual(after, before, 'the control stylesheet must be re-emitted');
  assert.equal((after.match(/\{/gu) ?? []).length, (before.match(/\{/gu) ?? []).length, 'with the same rules, not fewer');
});
