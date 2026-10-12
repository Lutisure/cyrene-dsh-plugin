// Glass tuning: tint strength, transparency, frost.
//
// The thing worth testing here is not that a slider writes a setting — it is
// that the values reach the *right* tokens and that the surface stack survives
// the transformation. The chrome colour is derived (neutral blended with a hue)
// and the alphas form a ladder; a tuning pass that flattened either would leave
// the interface legible-ish and subtly wrong, which is exactly the kind of
// regression no screenshot catches.

import assert from 'node:assert/strict';
import test from 'node:test';

import { mountPlugin } from './harness.mjs';
import { loadTheme } from '../tools/palette.mjs';

/** The glass-tuning sheet's text, or null when it is not mounted. */
function tuningSheet(sandbox) {
  const sheet = sandbox.document.head
    .querySelectorAll('style')
    .find((node) => node.dataset.pluginCss === 'dsh-theme-cyrene/glass-tuning');
  return sheet === undefined ? null : sheet.textContent;
}

/** The dock button with a given label. */
function dockButton(sandbox, label) {
  const button = sandbox.document.querySelectorAll('.cy-btn').find((node) => node.textContent === label);
  assert.notEqual(button, undefined, `the dock must offer a ${label} button`);
  return button;
}

/** Open the Scene panel, which carries the glass rows. */
async function openScene(sandbox) {
  dockButton(sandbox, 'Scene').click();
  await new Promise((resolve) => setImmediate(resolve));
  const panel = sandbox.document.querySelector('.cy-pop');
  assert.notEqual(panel, null, 'the panel must open');
  return panel;
}

/** Drag the slider in a tuning row to a value. */
function setTuning(sandbox, key, value) {
  const row = sandbox.document
    .querySelectorAll('[data-tuning]')
    .find((node) => node.dataset.tuning === key);
  assert.notEqual(row, undefined, `no tuning row for ${key}`);
  const input = row.querySelectorAll('input')[0];
  assert.notEqual(input, undefined, `${key} must have a slider`);
  input.value = String(value);
  input.dispatchEvent({ type: 'input', target: input });
}

/** Every declared alpha in the sheet, keyed by its custom property. */
function alphas(sandbox) {
  const found = {};
  const pattern = /(--dsw-alias-[\w-]+):\s*rgba\([^,]+,[^,]+,[^,]+,\s*([0-9.]+)\)/gu;
  for (const match of tuningSheet(sandbox).matchAll(pattern)) found[match[1]] = Number(match[2]);
  return found;
}

test('an untouched recipe still emits both safety blocks, and nothing else', async () => {
  const { sandbox } = await mountPlugin();
  await openScene(sandbox);

  // The sheet used to come out empty when nothing was customised, and the two
  // fallback blocks only rode along with a tuning change. That early return was
  // removed deliberately: `prefers-reduced-transparency` is an accessibility
  // signal rather than a taste, and a renderer with no `backdrop-filter` is not
  // something that only happens to a reader who moved a slider. So the blocks
  // are always emitted — the regression this guards is a reader with reduced
  // transparency getting a translucent dock on a fresh install, which is
  // invisible to anyone testing with default system settings.
  const sheet = tuningSheet(sandbox);
  assert.notEqual(sheet, null, 'the sheet is mounted from the first paint');
  assert.ok(
    sheet.includes('@media (prefers-reduced-transparency: reduce)'),
    'the reduced-transparency fallback must be there before anything is tuned'
  );
  assert.ok(
    sheet.includes('@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))'),
    'and so must the no-backdrop-filter fallback'
  );

  // The full selector pair, not just `.cy-dock`: a block that reached one of
  // the two surfaces would leave the other translucent. Twice over — the two
  // fallbacks, and nothing else. A block that dropped the popovers fails here
  // even if every declaration in it is otherwise right.
  //
  // It used to be three, and the third was the blur rule. That rule is emitted
  // only when the blur actually differs from the theme's, and it used to differ
  // on a fresh install: the default setting said 40 against a theme of 14, so
  // every untouched recipe carried a 3x blur override nobody had asked for. The
  // default is derived from `THEME.blur.menu` now, so an untouched recipe emits
  // the fallbacks alone — which is what "and nothing else" in this test's name
  // was always meant to mean.
  const fallback = /html\[data-cyrene-theme="on"\]\[data-cyrene-glass="on"\] \.cy-dock, html\[data-cyrene-theme="on"\]\[data-cyrene-glass="on"\] \.cy-pop \{/gu;
  assert.equal((sheet.match(fallback) ?? []).length, 2, 'every block must cover the dock and the popovers');

  // One flat fill, shared by the two blocks. A pair that agreed with each other
  // but not with the theme would still be wrong, so it is the 薄暮 surfaceHigh at
  // the panel alpha: a flat fill that is a different colour from the surface
  // behind it reads as a seam on every panel edge.
  const fill = /background: rgba\((\d+),(\d+),(\d+),([0-9.]+)\) !important;/u.exec(sheet);
  assert.notEqual(fill, null, 'the fallbacks must replace the glass with a flat fill');
  const { THEME } = loadTheme();
  const flat = [16, 8, 0].map((shift) => (parseInt(THEME.surfaceHigh.slice(1), 16) >> shift) & 255);
  assert.deepEqual(
    [Number(fill[1]), Number(fill[2]), Number(fill[3])],
    flat,
    'the flat fill must be the shipped surfaceHigh, not a literal'
  );
  assert.equal(Number(fill[4]), THEME.alpha.panel, 'at the panel alpha');

  // Neither surface may be left on the material inside those blocks.
  for (const block of [
    /@media \(prefers-reduced-transparency: reduce\) \{([\s\S]*?)\n\}/u,
    /@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\) \{([\s\S]*?)\n\}/u
  ]) {
    const body = block.exec(sheet);
    assert.notEqual(body, null, 'each fallback must be a block of its own');
    assert.ok(body[1].includes('background:'), 'and must carry the flat fill');
    assert.equal(/backdrop-filter: (?!none)/u.test(body[1]), false, 'and never re-apply a blur');
  }
  // Switching the material off has to be explicit, and on both spellings.
  const reduce = /@media \(prefers-reduced-transparency: reduce\) \{([\s\S]*?)\n\}/u.exec(sheet);
  assert.ok(reduce[1].includes('backdrop-filter: none !important;'), 'the standard property is switched off');
  assert.ok(reduce[1].includes('-webkit-backdrop-filter: none !important;'), 'and the prefixed one');
});

test('transparency scales every surface by the same ratio', async () => {
  const { sandbox } = await mountPlugin();
  await openScene(sandbox);

  setTuning(sandbox, 'glassAlpha', 80); // 0.80

  const scaled = alphas(sandbox);
  assert.notEqual(scaled['--dsw-alias-bg-base'], undefined, 'the base surface must be re-emitted');
  // At 0.80: base 0.30 → 0.24, layer-2 0.72 → 0.576, layer-3 0.86 → 0.688.
  assert.equal(scaled['--dsw-alias-bg-base'], 0.24);
  assert.equal(scaled['--dsw-alias-bg-layer-2'], 0.576);
  assert.equal(scaled['--dsw-alias-bg-layer-3'], 0.688);

  // The ordering is the thing that matters: a flat subtraction would have made
  // layer 3 and layer 1 converge and the nested dialogs would stop separating.
  assert.ok(scaled['--dsw-alias-bg-layer-1'] < scaled['--dsw-alias-bg-layer-2'], 'the ladder must stay ordered');
  assert.ok(scaled['--dsw-alias-bg-layer-2'] < scaled['--dsw-alias-bg-layer-3'], 'and keep climbing');
  assert.ok(scaled['--dsw-alias-bg-base'] < scaled['--dsw-alias-bg-layer-1'], 'starting from the base');
});

test('transparency never drives a surface to invisible', async () => {
  const { sandbox } = await mountPlugin();
  await openScene(sandbox);
  setTuning(sandbox, 'glassAlpha', 60); // the slider's floor

  const scaled = alphas(sandbox);
  for (const [token, value] of Object.entries(scaled)) {
    assert.ok(value >= 0.05, `${token} must stay visible, saw ${value}`);
  }
});

test('the tint colour is re-derived from the hue, not tinted on top of the old value', async () => {
  const { sandbox } = await mountPlugin();
  const panel = await openScene(sandbox);

  const hue = panel.querySelectorAll('[data-glass="hue"] input')[0];
  assert.notEqual(hue, undefined, 'the panel must offer a hue picker');
  hue.value = '#ff0000';
  hue.dispatchEvent({ type: 'input', target: hue });

  const sheet = tuningSheet(sandbox);
  assert.ok(sheet.includes('--dsw-alias-bg-layer-2'), 'the ladder is re-emitted');
  // Mixing toward pure red has to move the red channel up and leave it the
  // dominant one — if the old value were being tinted *again* the channels
  // would not line up with a single mix.
  const match = /--dsw-alias-bg-layer-2:\s*rgba\((\d+),(\d+),(\d+),/u.exec(sheet);
  assert.notEqual(match, null, 'layer-2 must carry an rgba value');
  const [, r, g, b] = match.map(Number);
  assert.ok(r > g, `red must dominate after mixing toward red (got ${r},${g},${b})`);
  assert.ok(r > b, `and beat blue (got ${r},${g},${b})`);
  // And the channel has to land on one 薄暮 mix, not on the value that was
  // already in the sheet: layer-2 is the shipped neutral toward the hue at the
  // shipped tint, so the expectation is derived from those three inputs. It was
  // a pasted `94` with the arithmetic in a comment, which is exactly what a
  // palette change breaks.
  //
  // Note the direction this now fails in. The tuned ladder comes from the
  // `GLASS_LADDER` copy in `31-glass.js`, and that copy still carries the
  // pre-薄暮 neutrals; a mismatch here means the copy has drifted from
  // `THEME.neutral`, so the slider moves the chrome to colours the theme does
  // not ship. The message names the likely cause rather than printing two
  // numbers and leaving the reader to work it out.
  const { THEME, mix } = loadTheme();
  const expected = mix(THEME.neutral.layer2, '#ff0000', THEME.tint);
  assert.equal(
    r,
    parseInt(expected.slice(1, 3), 16),
    `expected a single ${THEME.tint * 100}% mix of ${THEME.neutral.layer2}, saw ${r} — ` +
      'check whether GLASS_LADDER in 31-glass.js still matches THEME.neutral'
  );
});

test('tint strength of zero yields a pure grey chrome', async () => {
  const { sandbox } = await mountPlugin();
  await openScene(sandbox);
  setTuning(sandbox, 'glassTint', 0);

  const sheet = tuningSheet(sandbox);
  const match = /--dsw-alias-bg-layer-2:\s*rgba\((\d+),(\d+),(\d+),/u.exec(sheet);
  assert.notEqual(match, null);
  const [, r, g, b] = match.map(Number);

  // Derived from the theme, not pasted. This carried `[38, 36, 44]` — the
  // previous palette's `layer2` — which was the one literal that kept the stale
  // `GLASS_LADDER` visible after it had drifted; it went on passing while the
  // glass layer blended from greys the theme no longer shipped. Reading the
  // constant means the next repaint moves this with everything else.
  const { THEME } = loadTheme();
  const neutral = [16, 8, 0].map((shift) => (parseInt(THEME.neutral.layer2.slice(1), 16) >> shift) & 255);
  assert.deepEqual([r, g, b], neutral, 'no hue left, just the neutral: ' + sheet.slice(0, 160));
});

test('the frost radius lands on the glass surface selectors, not the whole document', async () => {
  const { sandbox } = await mountPlugin();
  await openScene(sandbox);
  setTuning(sandbox, 'glassBlur', 12);

  const sheet = tuningSheet(sandbox);
  assert.ok(sheet.includes('blur(12.0px)'), 'the radius is applied');
  assert.ok(sheet.includes('.cy-dock'), 'to the dock');
  assert.ok(sheet.includes('.cy-pop'), 'and the popovers');
  // Scoped to the glass attribute so it disappears with the glass layer.
  assert.ok(sheet.includes('[data-cyrene-glass="on"]'), 'gated on the glass attribute');
  assert.equal(/^\s*\*\s*\{/m.test(sheet), false, 'never a blanket rule');
});

test('restoring the recipe drops the override, leaving only the safety blocks', async () => {
  const { sandbox } = await mountPlugin();
  await openScene(sandbox);
  setTuning(sandbox, 'glassAlpha', 90);
  const tuned = tuningSheet(sandbox);
  assert.ok(tuned.includes('--dsw-alias-bg-base'), 'the alpha drives the ladder while it is tuned');

  setTuning(sandbox, 'glassAlpha', 100);
  const restored = tuningSheet(sandbox);
  // No longer an empty sheet — the two fallbacks are unconditional now, so
  // "back to the shipped recipe" means the ladder is gone and what is left is
  // exactly the safety pair. Asserting emptiness here would be asserting the
  // removal of the accessibility contract.
  assert.equal(restored.includes('--dsw-alias-bg-base'), false, 'the tuned ladder must be gone at 1.00');
  assert.ok(restored.includes('@media (prefers-reduced-transparency: reduce)'), 'the reduce fallback stays');
  assert.ok(restored.includes('@supports not ('), 'and the no-backdrop-filter fallback stays');
});

test('the tuning sheet is released on unmount', async () => {
  const { sandbox, disposers } = await mountPlugin();
  assert.notEqual(tuningSheet(sandbox), null, 'mounted with the rest');
  for (const entry of disposers) {
    if (entry !== null && typeof entry === 'object' && typeof entry.dispose === 'function') entry.dispose();
  }
  assert.equal(tuningSheet(sandbox), null, 'and removed with the rest');
});
