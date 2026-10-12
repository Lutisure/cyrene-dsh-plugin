/**
 * Load the derived palette out of `lib/client/10-constants.js` and measure it.
 *
 * The constants file is not importable: it defines everything with `var` for the
 * concatenated client bundle, and its asset-manifest markers are not valid JS.
 * So the self-contained prefix is evaluated in a VM instead. That keeps this
 * check reading the *shipped* numbers rather than a copy that can drift.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Evaluate the constants prefix and return the values worth asserting on.
 *
 * `mix` and `tint` come out of the evaluated scope rather than being reimplemented
 * here, so a test of the tint dial exercises the real function.
 *
 * @returns {{THEME: object, TOKENS: object, mix: Function, tint: Function, hairline: Function}} the loaded values.
 */
export function loadTheme() {
  const source = readFileSync(join(root, 'lib/client/10-constants.js'), 'utf8');
  const cut = source.indexOf('var WALLPAPERS');
  if (cut === -1) throw new Error('could not find the asset-marker block in 10-constants.js');
  const context = { console: { warn() {}, error() {}, log() {} } };
  vm.createContext(context);
  vm.runInContext(
    `${source.slice(0, cut)}\n;globalThis.OUT = { THEME, TOKENS, mix, tint, hairline };`,
    context
  );
  return context.OUT;
}

/**
 * The skin presets, read out of `12-skins.js`.
 *
 * The file is not standalone — it calls `mix`, `tint` and `refreshTokensFromTheme`,
 * which live in the parts before it. So it is concatenated onto the same prefix
 * `loadTheme` evaluates and run in one scope, which exercises the real derivation
 * rather than a copy of it.
 *
 * @returns {{skins: Array, apply: Function, THEME: object, TOKENS: object}} the
 *   presets plus an `apply(id)` that re-derives both objects in place.
 */
export function loadSkins() {
  const constants = readFileSync(join(root, 'lib/client/10-constants.js'), 'utf8');
  const cut = constants.indexOf('var WALLPAPERS');
  if (cut === -1) throw new Error('could not find the asset-marker block in 10-constants.js');

  const skins = readFileSync(join(root, 'lib/client/12-skins.js'), 'utf8');
  const context = { console: { warn() {}, error() {}, log() {} } };
  vm.createContext(context);
  vm.runInContext(
    `${constants.slice(0, cut)}\n${skins}\n;globalThis.OUT = { SKINS, applySkin, THEME, TOKENS };`,
    context
  );

  const exported = context.OUT;
  return {
    skins: exported.SKINS,
    THEME: exported.THEME,
    TOKENS: exported.TOKENS,
    apply: (id) => exported.applySkin(id)
  };
}

/** Parse `#rrggbb` or `rgba(...)` into channels. */
export function parse(value) {
  const match = /rgba?\(([^)]+)\)/u.exec(value);
  if (match !== null) {
    const parts = match[1].split(',').map((part) => parseFloat(part));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] === undefined ? 1 : parts[3] };
  }
  const hex = parseInt(value.slice(1), 16);
  return { r: (hex >> 16) & 255, g: (hex >> 8) & 255, b: hex & 255, a: 1 };
}

/** Source-over composite of `fg` onto an opaque `bg`. */
export function over(fg, bg) {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1
  };
}

/** WCAG relative luminance. */
export function luminance(colour) {
  const channel = (value) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(colour.r) + 0.7152 * channel(colour.g) + 0.0722 * channel(colour.b);
}

/** WCAG contrast ratio between two opaque colours. */
export function contrast(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/**
 * How much colour the chrome carries, as the blue-minus-red channel spread of
 * the most-tinted surface. A neutral grey scores 0; Apple's dark materials are
 * essentially 0; the theme's original palette scored 24.
 */
export function chromaSpread(hex) {
  const colour = parse(hex);
  return Math.round(Math.max(colour.r, colour.g, colour.b) - Math.min(colour.r, colour.g, colour.b));
}

/**
 * The pairs worth measuring, with the WCAG target for each.
 *
 * The backdrop is a deliberately harsh mid-tone wallpaper: a bright image
 * behind translucent chrome is the worst realistic case for contrast.
 *
 * @param {object} theme - the loaded `THEME`.
 * @param {object} tokens - the loaded `TOKENS`.
 * @param {object} [wallpaper] - the backdrop to composite over.
 * @returns {Array<{name: string, ratio: number, target: number, ok: boolean}>} the rows.
 */
export function contrastRows(theme, tokens, wallpaper = { r: 108, g: 104, b: 118, a: 1 }) {
  const panel = over(parse(tokens['--dsw-alias-bg-overlay']), wallpaper);
  const layer2 = over(parse(tokens['--dsw-alias-bg-layer-2']), wallpaper);
  const bubble = over(parse(tokens['--dsw-specific-bubble']), wallpaper);
  const card = over(parse(tokens['--dsw-alias-settings-card-fill']), wallpaper);

  const spec = [
    ['label-primary on panel', tokens['--dsw-alias-label-primary'], panel, 4.5],
    ['label-secondary on panel', tokens['--dsw-alias-label-secondary'], panel, 4.5],
    ['label-tertiary on panel', tokens['--dsw-alias-label-tertiary'], panel, 3.0],
    ['label-caption on panel', tokens['--dsw-alias-label-caption'], panel, 3.0],
    ['label-dimmed on panel', tokens['--dsw-alias-label-dimmed'], panel, 2.0],
    ['label-primary on layer-2', tokens['--dsw-alias-label-primary'], layer2, 4.5],
    ['label-secondary on layer-2', tokens['--dsw-alias-label-secondary'], layer2, 4.5],
    ['label-secondary on bubble', tokens['--dsw-alias-label-secondary'], bubble, 4.5],
    ['label-secondary on card', tokens['--dsw-alias-label-secondary'], card, 4.5],
    ['pink accent on panel', theme.pink, panel, 3.0],
    ['purple link on panel', theme.purple, panel, 3.0]
  ];

  return spec.map(([name, foreground, background, target]) => {
    const ratio = contrast(over(parse(foreground), background), background);
    return { name, ratio, target, ok: ratio >= target };
  });
}
