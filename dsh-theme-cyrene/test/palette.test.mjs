/**
 * Guards on the derived palette.
 *
 * These exist because the look is meant to be tuned by eye, and every knob in
 * `THEME` can quietly destroy legibility. Asserting the measurable properties
 * means the appearance can be iterated freely without shipping unreadable text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { chromaSpread, contrastRows, loadTheme, luminance, parse } from '../tools/palette.mjs';

/**
 * The channel a colour leans on: `blue`, `green` or `red`.
 *
 * Used alongside the spread rather than instead of it. The question the 薄暮
 * palette raises is not only *how much* colour a surface carries but *which*
 * colour it leans toward — a violet surface and a green one can have the same
 * spread, and only the second one has drifted away from the accent.
 *
 * @param {string} hex - a six-digit hex colour.
 * @returns {string} the dominant channel's name.
 */
function channelLean(hex) {
  const value = parseInt(hex.slice(1), 16);
  const channels = { red: (value >> 16) & 255, green: (value >> 8) & 255, blue: value & 255 };
  return Object.entries(channels).sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Whether `derived` is `neutral` moved toward `target` along the channel ratios
 * a single mix would produce, rather than some colour that merely happens to sit
 * nearby.
 *
 * `mix()` cannot be called with an unknown target from here, so this is the
 * check the relationship needs: mixing two colours produces per-channel deltas
 * in exactly the profile of the two endpoints. Any other blend — a second tint
 * on top of an already-tinted value, a third colour introduced — lands off that
 * line. It is the property `the tint colour is re-derived` exercises in the
 * glass sheet, applied to the shipped palette.
 *
 * It answers *which way* a surface moved, not *how far*: the ratio's magnitude
 * is deliberately not asserted, because that is `mix()`'s business and the
 * equality assertion in the test covers it. The tolerance of 0.05 of the span is
 * therefore generous enough for `mix()`'s per-channel rounding and still far
 * below a double tint. `channelLean` carries the direction, so a mirror mix
 * cannot pass by ratio alone.
 *
 * @param {string} derived - the emitted surface.
 * @param {string} neutral - the ladder step it is derived from.
 * @param {string} target - the hue it is mixed toward.
 * @returns {boolean} whether it lies on the blend line, moving the right way.
 */
function onBlendLine(derived, neutral, target) {
  if (Math.abs(chromaSpread(target)) < 12) return false;
  if (channelLean(derived) !== channelLean(target)) return false;
  const channel = (hex, index) => [16, 8, 0].map((shift) => (parseInt(hex.slice(1), 16) >> shift) & 255)[index];
  for (let index = 0; index < 3; index += 1) {
    const span = channel(target, index) - channel(neutral, index);
    const moved = channel(derived, index) - channel(neutral, index);
    // A channel the two endpoints share cannot say anything about the blend.
    if (Math.abs(span) <= 2) continue;
    const ratio = moved / span;
    if (ratio < -0.05 || ratio > 1.05) return false;
  }
  return true;
}

test('the constants file loads and derives the chrome surfaces', () => {
  const { THEME, TOKENS } = loadTheme();
  assert.match(THEME.surface, /^#[0-9a-f]{6}$/u);
  assert.equal(THEME.inkDeep.length, 7);
  // Every surface must be derived, never left undefined by a broken mix().
  for (const key of ['inkDeep', 'ink', 'surface', 'surfaceHigh', 'mask']) {
    assert.match(THEME[key], /^#[0-9a-f]{6}$/u, `${key} must be a derived hex colour`);
  }
  assert.ok(Object.keys(TOKENS).length > 100, 'the token map must still be populated');
});

test('the chrome shares the accent hue instead of drifting to an unrelated colour', () => {
  const { THEME, mix } = loadTheme();
  // This reversed the old rule deliberately. The palette before 薄暮 kept the
  // chrome near-neutral — chroma spread under 18 — because the accent was the
  // only colour on screen. 薄暮 tints every surface instead, so "near-neutral"
  // is no longer the intent, and a spread ceiling here would now be asserting
  // the old design back into place.
  //
  // What is guaranteed is coherence: each surface is its ladder step mixed with
  // the theme's own hue at the theme's tint, so the interface reads as one
  // colour at six depths. The blend is checked rather than a channel count
  // because a surface that drifted to an unrelated colour — a green cast under a
  // violet accent — can keep the same spread and still be wrong.
  const surfaces = [
    [THEME.neutral.base, THEME.ink],
    [THEME.neutral.layer2, THEME.surface],
    [THEME.neutral.layer3, THEME.surfaceHigh]
  ];
  for (const [neutral, derived] of surfaces) {
    assert.equal(mix(neutral, THEME.hue, THEME.tint), derived, `${derived} must be ${neutral} toward ${THEME.hue}`);
    // And each one on its own line, checked against that step rather than
    // against the ladder as a whole: a colour that drifted off `base` would
    // still sit on the line from `layer2`, which is why the neutral is the
    // argument.
    assert.ok(onBlendLine(derived, neutral, THEME.hue), `${derived} must sit on the ${neutral} to ${THEME.hue} line`);
  }
  // Six steps, six colours: a mix that rounded a step back onto its neutral
  // would stop the ladder expressing elevation at all.
  assert.equal(new Set([THEME.inkDeep, THEME.ink, THEME.surface, THEME.surfaceHigh]).size, 4);
});

test('adjacent surfaces keep a measurable step, so elevation still reads', () => {
  const { THEME } = loadTheme();
  // The other half of the same principle. Tinting the chrome is what makes the
  // ladder read as one colour at six depths, and the risk is the opposite of a
  // colour cast: a tint that swamps the luminance steps would flatten six
  // surfaces into one, and a shadow on a dark interface has nothing to darken.
  //
  // Measured in luminance, not in chroma — the step that separates two surfaces
  // for a reader is how much lighter one is, and on a near-black ladder the
  // contrast *ratio* between two adjacent steps is barely above 1 for all of
  // them, so a ratio target would say nothing here.
  const step = (from, to) => luminance(parse(to)) - luminance(parse(from));
  assert.ok(step(THEME.ink, THEME.surface) > 0.008, 'base must be lighter than ink');
  assert.ok(step(THEME.surface, THEME.surfaceHigh) > 0.008, 'and the high surface lighter than the base');
  assert.ok(
    luminance(parse(THEME.surfaceHigh)) > luminance(parse(THEME.ink)) * 1.5,
    'the ladder must climb by more than rounding, or six steps collapse into one'
  );
});

test('the blend-line check rejects a surface that drifted off the hue', () => {
  const { THEME } = loadTheme();
  // Calibration for the two tests above, so they are known to have teeth. A
  // check that passed for every colour would be a green light for any repaint,
  // and a repaint that moved the chrome away from the accent hue is exactly what
  // the 薄暮 palette should be held to.
  const GREEN = '#2f7a3a';
  assert.equal(onBlendLine(GREEN, THEME.neutral.base, THEME.hue), false, 'a green surface belongs to another theme');
  // And the shape the check is aimed at: a surface that is lighter than the
  // neutral, so it reads as elevation, but whose extra light is warm rather than
  // toward the hue. The hue moved blue and red; this one moved red and green.
  // Nothing here is more than a few percent off the ladder, which is what makes
  // it the case a spread or a luminance test would wave through.
  const WARM = '#3a3320';
  assert.equal(parse(WARM).r > parse(THEME.neutral.base).r, true, 'it is lighter than the neutral');
  assert.equal(onBlendLine(WARM, THEME.neutral.base, THEME.hue), false, 'so it must not pass for a tinted surface');
});

test('tint is a real dial: 0 is neutral grey and 1 is the full hue', () => {
  const { THEME, mix } = loadTheme();
  assert.equal(mix(THEME.neutral.layer2, THEME.hue, 0), THEME.neutral.layer2);
  assert.equal(mix(THEME.neutral.layer2, THEME.hue, 1), THEME.hue);
  // Mixing toward the hue must increase the spread, or the knob does nothing.
  assert.ok(
    chromaSpread(mix(THEME.neutral.layer2, THEME.hue, 1)) >
      chromaSpread(mix(THEME.neutral.layer2, THEME.hue, 0))
  );
  // And the shipped tint must land between the two extremes.
  assert.ok(THEME.tint > 0 && THEME.tint < 1, `tint is ${THEME.tint}`);
});

test('every text role stays readable over translucent chrome', () => {
  const { THEME, TOKENS } = loadTheme();
  const rows = contrastRows(THEME, TOKENS);
  for (const row of rows) {
    assert.ok(row.ok, `${row.name} is ${row.ratio.toFixed(2)}:1, below the ${row.target} target`);
  }
});

test('the continuous corner shape is not overridden', () => {
  const { TOKENS } = loadTheme();
  // The shipped sheet sets `superellipse(1.5)` — Apple's squircle. Forcing
  // `round` here is what threw it away before.
  assert.equal(
    TOKENS['--dsw-corner-shape'],
    undefined,
    'do not override --dsw-corner-shape; the shipped superellipse is intentional'
  );
});

test('edges are neutral hairlines rather than coloured strokes', () => {
  const { TOKENS } = loadTheme();
  for (const key of ['--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-border-l3']) {
    const colour = parse(TOKENS[key]);
    const spread = Math.max(colour.r, colour.g, colour.b) - Math.min(colour.r, colour.g, colour.b);
    assert.ok(spread <= 1, `${key} should be a white hairline, got ${TOKENS[key]}`);
  }
});

test('shadows are near-black rather than tinted', () => {
  const { THEME } = loadTheme();
  for (const key of ['soft', 'panel', 'prominent', 'lv1', 'lv2', 'lv3']) {
    const value = THEME.shadow[key];
    assert.ok(value.includes('rgba(0,0,0,'), `shadow.${key} must be near-black, got ${value}`);
    assert.ok(!/rgba\((2[0-9]|3[0-9]),/.test(value), `shadow.${key} still carries a colour cast: ${value}`);
  }
});

test('the elevation stroke carries the specular highlight', () => {
  const { THEME, TOKENS } = loadTheme();
  assert.ok(TOKENS['--dsw-elevation-stroke'].includes('inset'), 'the stroke must be an inner highlight');
  assert.ok(TOKENS['--dsw-elevation-stroke'].includes('255,255,255'), 'the highlight must be white');
  assert.match(THEME.specularColor, /^rgba\(255,255,255,/u);
});

test('hover fills stay uncoloured and only the chosen state takes the hue', () => {
  const { THEME, TOKENS } = loadTheme();
  const hover = parse(TOKENS['--dsw-alias-interactive-bg-hover']);
  // Untouched: a hover is a lift, not a colour. 薄暮 moves the chrome but not
  // this rule, and a hueless white is the only fill that reads the same on every
  // surface of the ladder.
  assert.equal(Math.max(hover.r, hover.g, hover.b) - Math.min(hover.r, hover.g, hover.b), 0);
  // The chosen state does take the hue, and it has to come from the current
  // palette rather than the one this test used to paste in: it was pinned to
  // `207,168,255`, the pre-薄暮 purple, which would have passed while asserting a
  // colour the theme no longer ships.
  const purple = parse(THEME.purple);
  const accent = parse(TOKENS['--dsw-alias-interactive-bg-hover-accent']);
  assert.deepEqual(
    [accent.r, accent.g, accent.b],
    [purple.r, purple.g, purple.b],
    'the accent fill must be the theme purple'
  );
  assert.equal(accent.a, 0.24, 'at the shipped alpha, which no palette decides');
});
