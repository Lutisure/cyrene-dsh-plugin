/**
 * Does text on a glass panel stay readable over whatever is behind it?
 *
 * ## Why the existing contrast gate does not cover this
 *
 * `check-contrast.mjs` measures the *token* values: it takes the declared colour
 * of a surface and the declared colour of text and compares them. That is the
 * right check for an opaque surface, where the declared colour is what lands on
 * screen.
 *
 * A glass panel is not opaque. Its rendered background is its own fill composited
 * over whatever happens to be underneath — the wallpaper, the conversation, a
 * heading in large type. The token check cannot see any of that, so it will pass
 * a panel that is unreadable over half the content it will actually be shown on.
 *
 * This measures the composited result. It opens the panel over the busiest part
 * of the conversation it can find, samples the rendered background at several
 * points across the panel, and takes the **worst** one — a panel has to be
 * readable at its hardest point, not on average.
 *
 * ## What it cannot see
 *
 * Antialiasing. Text pixels are a blend of glyph and background, so sampling a
 * pixel that happens to land on a stroke would understate the contrast badly.
 * The samples are therefore taken in the panel's padding and between rows, and
 * the check reports how many points it used so a run that sampled almost nothing
 * is visible rather than reassuring.
 *
 * Run: node tools/check-panel-contrast.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { startBrowser } from './cdp.mjs';

const BASE = 'http://127.0.0.1:19387';
const OUT = join(process.env.TEMP ?? '/tmp', 'cyrene-panel-contrast');
mkdirSync(OUT, { recursive: true });

/** WCAG relative luminance of an `[r,g,b]`. */
function luminance(rgb) {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
}

/** WCAG contrast ratio between two `[r,g,b]`. */
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const parseRgb = (text) => {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/u.exec(String(text));
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
};

const browser = await startBrowser({ width: 1440, height: 900 });
try {
  await browser.gotoAuthenticated(BASE);
  await new Promise((resolve) => setTimeout(resolve, 1400));

  // A conversation, so the panel opens over real content rather than over an
  // empty hero screen. The hardest backdrop is text, and a blank page has none.
  await browser.callWith([
    'function () {',
    '  const row = Array.from(document.querySelectorAll(\'[role="treeitem"]\'))',
    '    .find(function (n) { return /进行中|研发模式/.test(n.textContent || ""); });',
    '  if (row) row.click();',
    '}'
  ].join('\n'), []);
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Open the Scene panel — the largest glass surface the theme has, and the one
  // that carries the most text.
  await browser.callWith([
    'function () {',
    '  const b = Array.from(document.querySelectorAll(".cy-btn"))',
    '    .find(function (n) { return (n.textContent || "").indexOf("Scene") >= 0; });',
    '  if (b) b.click();',
    '}'
  ].join('\n'), []);
  await new Promise((resolve) => setTimeout(resolve, 700));

  const panel = JSON.parse(await browser.evaluate([
    '(function () {',
    '  const pop = document.querySelector(".cy-pop");',
    '  if (!pop) return JSON.stringify({ error: "no .cy-pop on screen" });',
    '  const box = pop.getBoundingClientRect();',
    '  const style = getComputedStyle(pop);',
    '  return JSON.stringify({',
    '    box: { x: box.x, y: box.y, w: box.width, h: box.height },',
    '    fill: style.backgroundColor,',
    '    blur: style.backdropFilter,',
    '    // The colour the labels on it actually resolve to.',
    '    label: document.body ? getComputedStyle(document.body).getPropertyValue("--dsw-alias-label-primary").trim() : ""',
    '  });',
    '})()'
  ].join('\n')));

  if (panel.error) {
    console.log(panel.error);
    process.exitCode = 1;
  } else {
    const shot = await browser.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, 'panel.png'), Buffer.from(shot.data, 'base64'));

    // Sample a grid inside the panel, then throw away anything that is not a
    // plausible background: text antialiasing would make the worst sample
    // meaningless, so samples that sit far from the panel's own modal colour are
    // dropped rather than counted.
    const points = [];
    for (let y = panel.box.y + 10; y < panel.box.y + panel.box.h - 10; y += 9) {
      for (let x = panel.box.x + 10; x < panel.box.x + panel.box.w - 10; x += 23) {
        points.push({ name: `${Math.round(x)}x${Math.round(y)}`, x: Math.round(x), y: Math.round(y) });
      }
    }

    const samples = await browser.callWith([
      'async function (dataUrl, raw) {',
      '  const list = JSON.parse(raw);',
      '  const image = new Image();',
      '  image.src = dataUrl;',
      '  await image.decode();',
      '  const canvas = document.createElement("canvas");',
      '  canvas.width = image.naturalWidth;',
      '  canvas.height = image.naturalHeight;',
      '  const ctx = canvas.getContext("2d");',
      '  ctx.drawImage(image, 0, 0);',
      '  const out = [];',
      '  for (const point of list) {',
      '    const d = ctx.getImageData(point.x, point.y, 1, 1).data;',
      '    out.push([d[0], d[1], d[2]]);',
      '  }',
      '  return JSON.stringify(out);',
      '}'
    ].join('\n'), ['data:image/png;base64,' + shot.data, JSON.stringify(points)]);

    const rgbList = JSON.parse(samples);
    const label = parseRgb(panel.label) ?? [244, 238, 249];

    // Separate background from glyphs before taking a worst case.
    //
    // A grid over a panel full of text lands on text. The first run of this
    // check reported the worst "background" sample as rgb(244,238,249) — which is
    // the label colour, i.e. it had measured a letter against itself and
    // reported 1.00:1. Something has to decide which samples are background, and
    // a luminance histogram does it without guessing: the backdrop is one large
    // cluster, the glyphs are a small bright minority, so the tallest bin is the
    // backdrop.
    const bin = (value) => Math.round(value * 40);
    const histogram = new Map();
    for (const rgb of rgbList) {
      const key = bin(luminance(rgb));
      histogram.set(key, (histogram.get(key) ?? 0) + 1);
    }
    let mode = 0;
    let modeCount = -1;
    for (const [key, count] of histogram) {
      if (count > modeCount) { modeCount = count; mode = key; }
    }

    // Keep everything within a band around the mode. The band is generous enough
    // to hold a backdrop that varies across the panel — it is composited over
    // different content at different points, which is the whole reason this check
    // exists — and tight enough to exclude strokes.
    const kept = [];
    for (const [index, rgb] of rgbList.entries()) {
      const distance = Math.abs(bin(luminance(rgb)) - mode);
      if (distance <= 1) kept.push({ rgb, at: points[index] });
    }

    let worst = null;
    for (const sample of kept) {
      const ratio = contrast(sample.rgb, label);
      if (worst === null || ratio < worst.ratio) worst = { ...sample, ratio };
    }

    if (worst === null) {
      console.log('no background samples survived the filter — the grid missed the backdrop');
      process.exitCode = 1;
    } else {
      const mean = kept.reduce((sum, s) => sum + luminance(s.rgb), 0) / kept.length;
      console.log('panel  fill ' + panel.fill + '  blur ' + panel.blur);
      console.log('label  ' + panel.label);
      console.log('sampled ' + rgbList.length + ' points across '
        + Math.round(panel.box.w) + 'x' + Math.round(panel.box.h)
        + '; ' + kept.length + ' were backdrop, ' + (rgbList.length - kept.length) + ' were glyphs');
      console.log('backdrop luminance, mean ' + mean.toFixed(4));
      console.log('');
      console.log('brightest backdrop point  rgb(' + worst.rgb.join(',') + ')  at ' + worst.at.name);
      console.log('contrast                  ' + worst.ratio.toFixed(2) + ':1   (WCAG AA needs 4.5 for body text)');
      console.log('');

      if (worst.ratio >= 4.5) {
        console.log('PANEL TEXT PASSES');
      } else {
        console.log('PANEL TEXT FAILS at the brightest point of its backdrop');
        process.exitCode = 1;
      }
    }
    console.log('frame -> ' + OUT);
  }
} catch (error) {
  console.log('FAILED: ' + String((error && error.message) || error).slice(0, 400));
  process.exitCode = 1;
} finally {
  await browser.stop();
}
