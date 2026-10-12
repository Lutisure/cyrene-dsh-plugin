// Interface language.
//
// The host's language reaches this plugin through two signals, and the plugin
// translates through the `el()` helper rather than at each call site. Both
// halves of that arrangement are worth a test: a detection bug shows the wrong
// language, and a wiring bug shows Chinese inside an English interface — or,
// worse, a raw key like `panel.play`.

import assert from 'node:assert/strict';
import test from 'node:test';

import { mountPlugin } from './harness.mjs';

/** Every dock button's label, in order. */
function dockLabels(sandbox) {
  return sandbox.document.querySelectorAll('.cy-btn').map((node) => node.textContent);
}

/** Open a panel by its dock button and return it. */
async function openPanel(sandbox, label) {
  const button = sandbox.document.querySelectorAll('.cy-btn').find((node) => node.textContent === label);
  assert.notEqual(button, undefined, `no dock button labelled ${label}`);
  button.click();
  await new Promise((resolve) => setImmediate(resolve));
  const panel = sandbox.document.querySelector('.cy-pop');
  assert.notEqual(panel, null, `the ${label} panel must open`);
  return panel;
}

test('a Chinese host gets Chinese labels', async () => {
  const { sandbox } = await mountPlugin({ language: 'zh-CN' });
  // The dock also carries its own collapse control (`‹`), so this looks at the
  // buttons with an id rather than at every button in the bar. The order is the
  // default arrangement: the two fixed slots, then the four movable ones.
  const ids = sandbox.document.querySelectorAll('.cy-btn').map((node) => node.dataset.id);
  assert.deepEqual(
    ids.filter((id) => id !== undefined),
    ['music', 'wallpaper', 'sound', 'fonts', 'particles', 'pointer'],
    'dock labels are brand words and are not translated'
  );
  const panel = await openPanel(sandbox, 'Scene');
  const texts = panel.querySelectorAll('span').map((node) => node.textContent);
  assert.ok(texts.includes('亮度'), 'the wallpaper panel is in Chinese');
});

test('the dock arrangement controls are translated too', async () => {
  const zh = await mountPlugin({ language: 'zh-CN' });
  const zhPanel = await openPanel(zh.sandbox, 'Scene');
  const zhHead = zhPanel.querySelector('[data-dock-group="true"] summary');
  assert.notEqual(zhHead, null, 'the toolbar group must be there');
  assert.equal(zhHead.textContent, '工具栏');

  const en = await mountPlugin({ language: 'en-US' });
  const enPanel = await openPanel(en.sandbox, 'Scene');
  const enHead = enPanel.querySelector('[data-dock-group="true"] summary');
  assert.equal(enHead.textContent, 'Toolbar');
  // 固定 / 可排 are the two words the whole feature hangs on. An untranslated
  // toggle would leave an English interface with the one control it cannot read.
  const toggles = enPanel.querySelectorAll('[data-dock-row] .cy-dockrow-toggle').map((node) => node.textContent);
  // All six, in the order the rows are in: the four movable slots first, then the
  // two fixed ones. Both words have to arrive in English — an untranslated toggle
  // would leave an English interface with the one control it cannot read.
  assert.deepEqual(toggles, ['Free', 'Free', 'Free', 'Free', 'Fixed', 'Fixed'], `saw ${JSON.stringify(toggles)}`);
  const reset = enPanel.querySelectorAll('.cy-act').find((node) => node.textContent === 'Reset to defaults');
  assert.notEqual(reset, undefined, 'the reset button is translated too');
  const names = enPanel.querySelectorAll('[data-dock-row] .cy-dockrow-name').map((node) => node.textContent);
  // The English word the bar shows, kept as-is: it is a brand word, not a noun
  // this plugin gets to translate.
  assert.ok(names.some((name) => name.includes('Cyrene')), `saw ${JSON.stringify(names)}`);
});

test('an English host gets English labels', async () => {
  const { sandbox } = await mountPlugin({ language: 'en-US' });
  const panel = await openPanel(sandbox, 'Scene');
  const texts = panel.querySelectorAll('span').map((node) => node.textContent);
  assert.ok(texts.includes('Brightness'), `expected English, saw ${JSON.stringify(texts.slice(0, 12))}`);
  assert.equal(texts.includes('亮度'), false, 'and not the Chinese source');
});

test('the navigator is the fallback when the host declares nothing', async () => {
  // The harness normally sets both signals; here the host's declaration is
  // dropped so only `navigator.language` is left. This is the path for a host
  // that never writes `lang`, and it must still resolve an English interface.
  const { sandbox } = await mountPlugin({ language: 'en-GB', withoutLangAttribute: true });
  const panel = await openPanel(sandbox, 'Scene');
  const texts = panel.querySelectorAll('span').map((node) => node.textContent);
  assert.ok(texts.includes('Brightness'), `expected the navigator path to resolve English, saw ${JSON.stringify(texts.slice(0, 10))}`);
});

test('an untranslated label stays readable rather than becoming a key', async () => {
  const { sandbox } = await mountPlugin({ language: 'en-US' });
  const panel = await openPanel(sandbox, 'Type');
  const nodes = panel.querySelectorAll('span').concat(panel.querySelectorAll('button'));
  assert.ok(nodes.length > 10, 'the panel must actually have labels');
  for (const node of nodes) {
    const text = node.textContent;
    if (typeof text !== 'string') continue;
    // Dynamic strings built by concatenation are documented as uncovered. What
    // must never happen is a lookup key, or a failed lookup's `undefined`,
    // leaking into the interface.
    assert.equal(/^[a-z]+\.[a-z]/.test(text), false, `a key leaked: ${text}`);
    assert.equal(text.includes('undefined'), false, `an empty lookup leaked: ${text}`);
  }
});

test('titles and placeholders are translated too, not just visible text', async () => {
  const { sandbox } = await mountPlugin({ language: 'en-US' });
  const panel = await openPanel(sandbox, 'Type');

  // The preset selects build their title by appending 预设 to a label, so this
  // covers the fallback rule in `translate` as well as `title` itself.
  const titles = panel.querySelectorAll('select').map((node) => node.getAttribute('title'));
  assert.ok(
    titles.some((title) => title !== null && / preset$/u.test(title)),
    `expected a translated preset title, saw ${JSON.stringify(titles)}`
  );

  const placeholders = panel.querySelectorAll('input').map((node) => node.getAttribute('placeholder'));
  assert.ok(
    placeholders.includes('Name for the new set'),
    `expected a translated placeholder, saw ${JSON.stringify(placeholders)}`
  );

  // A tooltip rather than a label, on an element with no visible text at all.
  const tooltips = panel.querySelectorAll('input')
    .map((node) => node.getAttribute('title'))
    .filter((title) => title !== null);
  assert.ok(
    tooltips.includes('Overall size'),
    `expected a translated tooltip, saw ${JSON.stringify(tooltips.slice(0, 8))}`
  );
});

test('the language follows the host when it decides after load', async () => {
  // This host writes `lang` *after* the plugin's parts have run, so a read at
  // load captures whatever placeholder is there first. The real sequence is
  // exactly this: the document says `en` at boot, then becomes `zh-CN` once the
  // locale resolves. Reading only at load leaves the interface English forever.
  const { sandbox } = await mountPlugin({ language: 'en-US' });
  sandbox.document.documentElement.attributes.lang = 'zh-CN';
  const panel = await openPanel(sandbox, 'Scene');
  const texts = panel.querySelectorAll('span').map((node) => node.textContent);
  assert.ok(texts.includes('亮度'), `expected the new host language, saw ${JSON.stringify(texts.slice(0, 12))}`);
  assert.equal(texts.includes('Brightness'), false, 'and not the language it booted with');
});

test('and follows it back the other way', async () => {
  // The mirror of the case above, so this cannot pass by always resolving one
  // language. An earlier version of this file asserted the *opposite* — that a
  // panel kept the boot language — which locked the defect in place.
  const { sandbox } = await mountPlugin({ language: 'zh-CN' });
  sandbox.document.documentElement.attributes.lang = 'en-US';
  const panel = await openPanel(sandbox, 'Scene');
  const texts = panel.querySelectorAll('span').map((node) => node.textContent);
  assert.ok(texts.includes('Brightness'), `expected English, saw ${JSON.stringify(texts.slice(0, 12))}`);
  assert.equal(texts.includes('亮度'), false, 'and not the language it booted with');
});

test('one panel is never half-translated', async () => {
  // The re-read happens once per build rather than once per string. If it were
  // per string, a host that flipped mid-build would produce a panel with some
  // rows in each language — worse than either language alone.
  const { sandbox } = await mountPlugin({ language: 'en-US' });
  sandbox.document.documentElement.attributes.lang = 'zh-CN';
  const panel = await openPanel(sandbox, 'Scene');
  const texts = panel.querySelectorAll('span').map((node) => node.textContent);
  const hasChinese = texts.some((text) => /[\u4e00-\u9fff]/u.test(text));
  const hasEnglish = texts.some((text) => /Brightness|Contrast|Opacity/u.test(text));
  assert.ok(hasChinese, 'the panel resolved a language at all');
  assert.equal(hasEnglish, false, `the panel mixed languages: ${JSON.stringify(texts.slice(0, 12))}`);
});

test('a host that never declares a language falls back to the navigator', async () => {
  // `withoutLangAttribute` removes the host's declaration entirely. The fallback
  // must keep working, and must not be mistaken for "the declaration changed".
  const { sandbox } = await mountPlugin({ language: 'en-US', withoutLangAttribute: true });
  const panel = await openPanel(sandbox, 'Scene');
  const texts = panel.querySelectorAll('span').map((node) => node.textContent);
  assert.ok(texts.includes('Brightness'), `expected the navigator path, saw ${JSON.stringify(texts.slice(0, 12))}`);
});
