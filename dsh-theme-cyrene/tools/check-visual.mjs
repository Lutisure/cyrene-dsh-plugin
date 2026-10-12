/**
 * Pixel-level verification against the live interface.
 *
 * browser_* is unavailable in this environment, but Edge is installed and the web
 * carrier can be authenticated against (see cdp.mjs). So this loads the real page
 * in a real browser and checks what actually rendered.
 *
 * Why the screenshot is read back through the page: Node has no PNG decoder and
 * this plugin has no dependencies. The page does — Image + canvas — so a capture
 * is handed back into the page as a data URL, drawn, and sampled. That is real
 * pixel data from the compositor's output, not a computed style.
 *
 * What this establishes: that a colour reached the screen, that two skins differ
 * on screen, that a blur landed on the element that should have it, and that the
 * layout puts things where they are expected. What it does NOT establish is that
 * a palette is attractive — that stays a human judgement, and this file should
 * not pretend otherwise.
 *
 * Run: node tools/check-visual.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { startBrowser } from './cdp.mjs';

const BASE = 'http://127.0.0.1:19387';
const OUT = join(process.env.TEMP ?? '/tmp', 'cyrene-visual');
mkdirSync(OUT, { recursive: true });

// The palette list is read from the panel at run time rather than declared here:
// the check writes the skin setting, so it has to know what was there before.

let failures = 0;
function check(label, ok, detail) {
  const mark = ok ? 'ok  ' : 'FAIL';
  console.log('  ' + mark + ' ' + label.padEnd(38) + ' ' + (detail === undefined ? '' : detail));
  if (!ok) failures += 1;
  return ok;
}

/** Capture a screenshot, write it, and return the base64. */
async function capture(browser, name) {
  const shot = await browser.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name + '.png'), Buffer.from(shot.data, 'base64'));
  return shot.data;
}

/**
 * Sample pixels out of a captured frame, in the page.
 *
 * The points and the payload are passed as an argument rather than interpolated
 * into the expression: a colour-format string inside a nested template expression
 * is exactly the shape that broke the first version of this file.
 */
async function sample(browser, base64, points) {
  const declaration = [
    'async function (dataUrl, rawPoints) {',
    '  const image = new Image();',
    '  image.src = dataUrl;',
    '  await image.decode();',
    '  const canvas = document.createElement("canvas");',
    '  canvas.width = image.naturalWidth;',
    '  canvas.height = image.naturalHeight;',
    '  const ctx = canvas.getContext("2d");',
    '  ctx.drawImage(image, 0, 0);',
    '  const list = JSON.parse(rawPoints);',
    '  const out = {};',
    '  for (const point of list) {',
    '    const d = ctx.getImageData(point.x, point.y, 1, 1).data;',
    '    out[point.name] = [d[0], d[1], d[2]];',
    '  }',
    '  return JSON.stringify(out);',
    '}'
  ].join('\n');
  const payload = await browser.callWith(declaration, [
    'data:image/png;base64,' + base64,
    JSON.stringify(points)
  ]);
  return JSON.parse(payload);
}

/** Euclidean distance between two RGB triples. */
function distance(a, b) {
  return Math.sqrt(((a[0] - b[0]) ** 2) + ((a[1] - b[1]) ** 2) + ((a[2] - b[2]) ** 2));
}

const rgb = (c) => 'rgb(' + c.join(',') + ')';

const browser = await startBrowser({ width: 1440, height: 900 });
try {
  await browser.gotoAuthenticated(BASE);

  console.log('the theme is live in the real interface:');
  const SHEET_PROBE = [
    '(function () {',
    '  const dock = document.querySelector(".cy-dock");',
    '  const sidebar = document.querySelector("[data-slot=\\"sidebar\\"]");',
    '  const composer = document.querySelector("[data-composer-input]");',
    // The portrait belongs to the *collapsed* state, so the dock has to be folded',
    '  // before the dot has a box at all. Measured both ways: folded for the',
    '  // portrait, unfolded for the controls above.',
    '  const dotIdle = document.querySelector(".cy-dot");',
    '  const avatar = document.querySelector(".cy-dot .cy-avatar");',
    '  return JSON.stringify({',
    '    theme: document.documentElement.getAttribute("data-cyrene-theme"),',
    '    sheets: Array.from(document.querySelectorAll("style[data-plugin-css]"))',
    '      .map(function (s) { return s.dataset.pluginCss; })',
    '      .filter(function (n) { return n.indexOf("dsh-theme-cyrene/") === 0; }),',
    '    ids: Array.from(document.querySelectorAll(".cy-btn[data-id]"))',
    '      .map(function (b) { return b.dataset.id; }),',
    '    labels: Array.from(document.querySelectorAll(".cy-btn[data-id]"))',
    '      .map(function (b) { return b.textContent; }),',
    '    avatarSrc: avatar ? avatar.getAttribute("src") : null,',
    '    avatarLoaded: avatar ? { w: avatar.naturalWidth, h: avatar.naturalHeight } : null,',
    '    dotIdleDisplay: dotIdle ? getComputedStyle(dotIdle).display : null,',
    '    dockGlass: dock ? getComputedStyle(dock).backdropFilter : null,',
    '    sidebarGlass: sidebar ? getComputedStyle(sidebar).backdropFilter : null,',
    '    caret: composer ? getComputedStyle(composer).caretColor : null',
    '  });',
    '})()'
  ].join('\n');
  const state = JSON.parse(await browser.evaluate(SHEET_PROBE));

  const EXPECTED_IDS = ['sound', 'fonts', 'particles', 'pointer', 'wallpaper', 'music'];
  check('theme attribute is on', state.theme === 'on', String(state.theme));
  check('five plugin sheets mounted', state.sheets.length === 5, state.sheets.join(' '));
  check('six subsystem buttons', state.ids.join(',') === EXPECTED_IDS.join(','), state.labels.join(' '));
  // The live settings carry whichever avatar the user last chose, so this checks
  // that a portrait resolved and decoded — not that it is a particular one.
  const avatarKind = state.avatarSrc === null
    ? 'absent'
    : (state.avatarSrc.indexOf('data:image/') === 0 ? 'custom (data URL)' : 'built-in');
  check('portrait resolved', state.avatarSrc !== null && state.avatarSrc !== '', avatarKind);
  check('portrait decoded', state.avatarLoaded !== null && state.avatarLoaded.w > 0,
    state.avatarLoaded === null ? 'absent' : state.avatarLoaded.w + 'x' + state.avatarLoaded.h);
  check('dock has the glass material', state.dockGlass !== null && state.dockGlass !== 'none', state.dockGlass);
  check('sidebar has the glass material', state.sidebarGlass !== null && state.sidebarGlass !== 'none', state.sidebarGlass);
  check('composer caret resolves', state.caret !== null, state.caret);

  console.log('');
  console.log('the shipped palette, as rendered:');
  const frame = await capture(browser, '01-shipped');

  const BOX_PROBE = [
    '(function () {',
    '  const dock = document.querySelector(".cy-dock").getBoundingClientRect();',
    '  const side = document.querySelector("[data-slot=\\"sidebar\\"]").getBoundingClientRect();',
    '  return JSON.stringify({',
    '    dock: { x: Math.round(dock.x + dock.width / 2), y: Math.round(dock.y + dock.height / 2) },',
    '    sidebar: { x: Math.round(side.x + 40), y: Math.round(side.height - 60) }',
    '  });',
    '})()'
  ].join('\n');
  const box = JSON.parse(await browser.evaluate(BOX_PROBE));

  const shipped = await sample(browser, frame, [
    { name: 'dock', x: box.dock.x, y: box.dock.y },
    { name: 'sidebar', x: box.sidebar.x, y: box.sidebar.y }
  ]);
  console.log('    dock    ' + rgb(shipped.dock));
  console.log('    sidebar ' + rgb(shipped.sidebar));

  // The dock is mostly transparent over the wallpaper, so its rendered colour is
  // a blend. What matters is that it reads as a dark, cool surface rather than
  // the wallpaper showing through unmodified.
  check('dock renders as a dark surface',
    shipped.dock[0] < 90 && shipped.dock[1] < 90 && shipped.dock[2] < 110,
    rgb(shipped.dock));

  console.log('');
  console.log('all eight skins, sampled from the screen:');

  await browser.evaluate([
    '(function () {',
    '  const b = Array.from(document.querySelectorAll(".cy-btn"))',
    '    .find(function (n) { return n.textContent === "Scene"; });',
    '  if (!b) throw new Error("no Scene button");',
    '  b.click();',
    '})()'
  ].join('\n'));
  await new Promise((resolve) => setTimeout(resolve, 600));
  const panelOpen = await browser.evaluate(
    'document.querySelectorAll(\'[data-skins="true"] button\').length'
  );
  check('the Scene panel opens from the dock', panelOpen === 8, panelOpen + ' skin buttons');

  // Read the palette list and the current selection from the panel itself, rather
  // than hard-coding it: this check writes the skin setting, so it must restore
  // whatever was actually there and must not assume the default.
  const palette = JSON.parse(await browser.evaluate([
    '(function () {',
    '  const buttons = Array.from(document.querySelectorAll(\'[data-skins="true"] button\'));',
    '  const on = buttons.find(function (b) { return b.getAttribute("data-on") === "true"; });',
    '  return JSON.stringify({',
    '    list: buttons.map(function (b) {',
    '      return { id: b.dataset.skin, name: b.textContent };',
    '    }),',
    '    current: on ? on.dataset.skin : null',
    '  });',
    '})()'
  ].join('\n')));
  check('the panel reports a current skin', palette.current !== null, String(palette.current));

  const seen = new Map();
  const readings = new Map();
  for (const skin of palette.list) {
    await browser.callWith([
      'function (id) {',
      '  const b = document.querySelector(\'[data-skins="true"] button[data-skin="\' + id + \'"]\');',
      '  if (!b) throw new Error("no skin button: " + id);',
      '  b.click();',
      '}'
    ].join('\n'), [skin.id]);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const skinFrame = await capture(browser, 'skin-' + skin.id);
    const px = await sample(browser, skinFrame, [{ name: 'dock', x: box.dock.x, y: box.dock.y }]);
    const key = px.dock.join(',');
    console.log('    ' + skin.id.padEnd(9) + ' ' + skin.name.padEnd(12) + ' ' + rgb(px.dock));
    if (seen.has(key)) check(skin.name + ' differs on screen', false, 'identical to ' + seen.get(key));
    seen.set(key, skin.name);
    readings.set(skin.id, px.dock);
  }
  check('every skin differs on screen', seen.size === palette.list.length,
    seen.size + ' distinct dock colours of ' + palette.list.length);

  // Put the user's own palette back — whichever one that was.
  await browser.callWith([
    'function (id) {',
    '  const b = document.querySelector(\'[data-skins="true"] button[data-skin="\' + id + \'"]\');',
    '  if (!b) throw new Error("no skin button: " + id);',
    '  b.click();',
    '}'
  ].join('\n'), [palette.current]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const restored = await capture(browser, '99-restored');
  const back = await sample(browser, restored, [{ name: 'dock', x: box.dock.x, y: box.dock.y }]);
  // Compared against the in-loop reading of the *same* skin, not the capture taken
  // before the panel opened: the panel is a glass surface beside the dock, so
  // those two are different measurements. The first run's failure was that
  // mismatch, not a stuck skin.
  check('the original palette is restored',
    distance(back.dock, readings.get(palette.current)) <= 8,
    rgb(back.dock) + ' vs ' + rgb(readings.get(palette.current)) + ' (' + palette.current + ')');

  console.log('');
  console.log(failures === 0 ? 'VISUAL: all pass' : 'VISUAL: ' + failures + ' failed');
  console.log('screenshots -> ' + OUT);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (error) {
  console.log('FAILED: ' + String((error && error.message) || error).slice(0, 500));
  process.exitCode = 1;
} finally {
  await browser.stop();
}
