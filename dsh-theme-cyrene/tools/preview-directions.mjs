/**
 * Render candidate design directions on the live interface, for choosing between.
 *
 * ## Why this injects rather than editing the theme
 *
 * The four directions differ in *weight* — the neutral ladder, surface opacity,
 * and how heavy the glass is — and the skin system deliberately does not carry
 * those: `12-skins.js` says a skin changes a theme's temperature, never its
 * weight, and keeps `neutral` fixed across all eight presets. So a skin is the
 * wrong vehicle for candidates that are precisely about weight.
 *
 * This renders them without touching the shipped architecture: each direction is
 * a set of mutations to the same `THEME` object, the CSS is produced by calling
 * the plugin's **own** `tokenDeclarations()` / `glassCSS()`, and the result is
 * injected as a later stylesheet. Nothing here is a hand-copied token value, so
 * what is on screen is what the real generators produce.
 *
 * ## What it is not
 *
 * A preview. The chosen direction still has to be implemented properly, with
 * tests, in the parts that own those values.
 *
 * Run: node tools/preview-directions.mjs [id ...]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { startBrowser } from './cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://127.0.0.1:19387';
const OUT = join(process.env.TEMP ?? '/tmp', 'cyrene-directions');
mkdirSync(OUT, { recursive: true });

/**
 * Evaluate the parts that produce the stylesheets, in one scope.
 *
 * The parts are not modules — they are fragments concatenated into one bundle —
 * so they are evaluated together the way the bundle evaluates them. `30-theme.js`
 * only *defines* functions at load, which is what makes this safe to run without
 * the rest of the plugin.
 */
function loadEngine() {
  const read = (name) => readFileSync(join(root, 'lib/client', name), 'utf8');
  // The constants file ends with build-time placeholders — `var WALLPAPERS =
  // /*__CYRENE_WALLPAPERS__*/;` — which the bundler substitutes and which are not
  // valid JS as written. `palette.mjs` cuts the file before them; that also drops
  // `DEFAULT_SETTINGS`, which the theme layer reads. So they are neutralised in
  // place instead, and the whole file stays loadable.
  const constants = read('10-constants.js').replace(
    /=\s*\/\*__CYRENE_[A-Z_]+__\*\/\s*;/gu,
    '= null;'
  );

  const context = { console: { warn() {}, error() {}, log() {} } };
  vm.createContext(context);
  // In bundle order, and only the parts that define helpers the theme layer
  // calls. `clamp` lives in `20-util.js`, which is why it is here: without it
  // the theme layer evaluates fine and then throws on first call.
  const PARTS = [
    '10-constants.js',
    '12-skins.js',
    '20-util.js',
    '22-lang.js',
    '26-package.js',
    '30-theme.js',
    '31-glass.js',
    '32-fonts.js'
  ];
  vm.runInContext(
    [
      constants,
      ...PARTS.slice(1).map(read),
      ';globalThis.OUT = { THEME, TOKENS, PALETTE, mix, tint,',
      '  tokenDeclarations, glassCSS, glassTuningCSS, refreshTokens, refreshPalette };'
    ].join('\n'),
    context
  );
  return context.OUT;
}

/**
 * The shipped values, captured once so every direction starts from the same place.
 *
 * `THEME` is mutated in place between directions — the same reason `applySkin`
 * does it — so the original has to be copied before the first mutation.
 */
function snapshot(engine) {
  return JSON.parse(JSON.stringify({
    neutral: engine.THEME.neutral,
    hue: engine.THEME.hue,
    tint: engine.THEME.tint,
    alpha: engine.THEME.alpha,
    blur: engine.THEME.blur,
    border: engine.THEME.border,
    text: engine.THEME.text,
    pink: engine.THEME.pink,
    pinkStrong: engine.THEME.pinkStrong,
    pinkSoft: engine.THEME.pinkSoft,
    purple: engine.THEME.purple,
    info: engine.THEME.info,
    success: engine.THEME.success,
    warn: engine.THEME.warn,
    danger: engine.THEME.danger
  }));
}

const DIRECTIONS = [
  {
    id: 'current',
    name: '现状',
    note: '现在线上跑的这一套，作为基准',
    source: null,
    /** Injects nothing, so this frame is the real thing rather than a re-render. */
    baseline: true,
    apply() {}
  },
  {
    id: 'obsidian',
    name: '暗玉 · Obsidian',
    note: '内容做实，玻璃只留给浮动层；品牌色收敛成一次高光',
    source: 'Linear / Raycast 的 dark-first：近黑中性阶梯、抬升靠变亮而不是投影、强调色只用在主操作',
    apply(theme) {
      theme.neutral = {
        deep: '#0a0a0c', base: '#121214', layer1: '#191a1d',
        layer2: '#212226', layer3: '#2a2b30', high: '#34353b'
      };
      theme.hue = '#4a4a52';
      theme.tint = 0.06;
      theme.text = '#e8e8ec';
      theme.alpha = {
        base: 0.55, layer1: 0.75, layer2: 0.90, layer3: 0.96,
        panel: 0.98, scrim: 0.80, bubble: 0.96, input: 0.96, card: 0.96
      };
      theme.blur = { mask: '14px', menu: '14px', saturate: '140%' };
      theme.border = { hairline: 0.06, l1: 0.09, l2: 0.13, l3: 0.19, l4: 0.28, accent: 0.50 };
    }
  },
  {
    id: 'greenhouse',
    name: '花房 · Greenhouse',
    note: '按 Apple 的量做玻璃：模糊更薄、更透，填充落在 55–75%',
    source: 'Apple Liquid Glass（iOS 26）：glass 只给浮动控制层；网页侧实测参数 blur 10–16px、saturate 1.4–1.8、填充 55–75%',
    apply(theme) {
      theme.tint = 0.30;
      theme.alpha = {
        base: 0.55, layer1: 0.65, layer2: 0.72, layer3: 0.78,
        panel: 0.75, scrim: 0.70, bubble: 0.78, input: 0.80, card: 0.74
      };
      theme.blur = { mask: '12px', menu: '14px', saturate: '150%' };
      theme.border = { hairline: 0.08, l1: 0.10, l2: 0.14, l3: 0.20, l4: 0.30, accent: 0.46 };
    }
  },
  {
    id: 'sandstone',
    name: '暖砂 · Sandstone',
    note: '暖中性，纸感，退掉一点霓虹',
    source: '2026 的人本那一支：暖中性而非冷灰、颗粒与纹理、降低饱和度换耐看',
    apply(theme) {
      theme.neutral = {
        deep: '#12100c', base: '#1a1712', layer1: '#221e18',
        layer2: '#2b261e', layer3: '#363025', high: '#423b2e'
      };
      theme.hue = '#6b5230';
      theme.tint = 0.34;
      theme.text = '#f0ebe2';
      theme.pink = '#ffd9b8';
      theme.pinkStrong = '#e8a06a';
      theme.pinkSoft = '#fff0dc';
      theme.purple = '#e0b98a';
      theme.info = '#a8c4d8';
      theme.warn = '#ffd0a0';
      theme.blur = { mask: '18px', menu: '20px', saturate: '130%' };
    }
  },
  {
    id: 'dusk',
    name: '薄暮 · Dusk',
    note: '抬升一层就多一分她的颜色；整个界面是同一种色的深浅',
    source: 'Material 3 的 tonal elevation：每一级表面都朝品牌色偏一点，用色彩本身表达层级',
    apply(theme) {
      theme.neutral = {
        deep: '#100c15', base: '#1a1220', layer1: '#23182c',
        layer2: '#2d1f38', layer3: '#392845', high: '#463153'
      };
      theme.hue = '#6d3d8f';
      theme.tint = 0.10;
      theme.text = '#f4eef9';
      theme.pink = '#ffc9e6';
      theme.pinkStrong = '#d946ef';
      theme.purple = '#c9a4ff';
      theme.blur = { mask: '16px', menu: '18px', saturate: '160%' };
    }
  },
  {
    id: 'current-tuned',
    name: '现状 + 结构修正',
    note: '配色不动，只把量值改到查到的区间、把玻璃从内容卡片上撤下来',
    source: '同一份调研里的数值建议，用在现有配色上',
    apply(theme) {
      theme.alpha = {
        base: 0.44, layer1: 0.62, layer2: 0.78, layer3: 0.88,
        panel: 0.92, scrim: 0.74, bubble: 0.90, input: 0.92, card: 0.90
      };
      theme.blur = { mask: '14px', menu: '15px', saturate: '160%' };
    }
  }
];

/**
 * Recompute the surfaces that are derived from the neutral ladder.
 *
 * `refreshPalette()` only copies `THEME.ink` / `.inkDeep` / `.surface` into
 * `PALETTE` — it does not recompute them. The derivation lives *inside*
 * `applySkin`, so a direction that changes the ladder has to redo it here or the
 * new ladder never reaches a single token. That is exactly what the first run
 * did: the text colour changed and every surface stayed put.
 */
function deriveSurfaces(engine) {
  const { THEME, mix } = engine;
  THEME.inkDeep = mix(THEME.neutral.deep, THEME.hue, THEME.tint);
  THEME.ink = mix(THEME.neutral.base, THEME.hue, THEME.tint);
  THEME.surface = mix(THEME.neutral.layer2, THEME.hue, THEME.tint);
  THEME.surfaceHigh = mix(THEME.neutral.layer3, THEME.hue, THEME.tint);
  THEME.mask = mix('#070509', THEME.hue, THEME.tint * 0.6);
}

/** `blur(14px)` → `14`. */
const pxOf = (value) => Number.parseFloat(String(value));

/** Build the stylesheet for one direction. */
function sheetFor(engine, direction) {
  direction.apply(engine.THEME, engine.PALETTE);
  deriveSurfaces(engine);
  engine.refreshPalette();
  engine.refreshTokens();

  const scope = 'html[data-cyrene-theme="on"][data-cyrene-glass="on"]';
  const blur = engine.THEME.blur;
  const hue = engine.THEME.hue;
  const tint = engine.THEME.tint;

  return [
    '/* direction: ' + direction.id + ' */',

    // The sidebar, which `30-theme.js` owns. Reflects the direction's mask blur.
    engine.glassCSS(),

    // `31-glass.js` owns the floating layer, and it emits a **second** copy of the
    // surface tokens derived from its own glass parameters — not from `THEME`.
    // Emitting the direction's tokens before this is what made the first run look
    // unchanged: every surface was declared twice, and the later copy won. So the
    // direction's own token block is emitted *after* it, and the hue and tint are
    // passed through so the two agree rather than fight.
    engine.glassTuningCSS({
      glassHue: hue,
      glassTint: tint,
      glassAlpha: 1,
      glassBlur: pxOf(blur.menu)
    }),

    'html[data-cyrene-theme="on"] body {',
    engine.tokenDeclarations(),
    '}',

    // Glass belongs on the floating control layer, not on content. Apple's rule
    // is the strictest statement of it: never on lists, cards or media. This
    // generator hard-codes `saturate(200%)` and covers `.cy-card`, so the scope
    // and the saturation are set here instead.
    scope + ' .cy-dock,',
    scope + ' .cy-pop {',
    '  backdrop-filter: blur(' + blur.menu + ') saturate(' + blur.saturate + ') !important;',
    '  -webkit-backdrop-filter: blur(' + blur.menu + ') saturate(' + blur.saturate + ') !important;',
    '}',
    scope + ' .cy-card {',
    '  backdrop-filter: none !important;',
    '  -webkit-backdrop-filter: none !important;',
    '}',

    direction.extra ?? ''
  ].join('\n');
}

const wanted = process.argv.slice(2);
const chosen = wanted.length === 0
  ? DIRECTIONS
  : DIRECTIONS.filter((direction) => wanted.includes(direction.id));

const browser = await startBrowser({ width: 1440, height: 900 });
try {
  await browser.gotoAuthenticated(BASE);
  const engine = loadEngine();
  const shipped = snapshot(engine);

  /** Restore the shipped values before each direction. */
  const reset = () => {
    Object.assign(engine.THEME, JSON.parse(JSON.stringify(shipped)));
    Object.assign(engine.THEME.neutral, shipped.neutral);
    Object.assign(engine.THEME.alpha, shipped.alpha);
    Object.assign(engine.THEME.blur, shipped.blur);
    Object.assign(engine.THEME.border, shipped.border);
    engine.refreshPalette();
    engine.refreshTokens();
  };

  for (const direction of chosen) {
    reset();
    if (direction.baseline) {
      await browser.evaluate(
        'var s = document.getElementById("cy-direction-preview"); if (s) s.remove();'
      );
    } else {
      const css = sheetFor(engine, direction);
      // Kept beside the screenshot so the exact stylesheet behind a frame can be
      // re-injected by hand when a frame looks wrong.
      writeFileSync(join(OUT, direction.id + '.css'), css);
      await browser.callWith([
        'function (text) {',
        '  const old = document.getElementById("cy-direction-preview");',
        '  if (old) old.remove();',
        '  const style = document.createElement("style");',
        '  style.id = "cy-direction-preview";',
        '  style.textContent = text;',
        '  document.head.appendChild(style);',
        '}'
      ].join('\n'), [css]);
    }
    await new Promise((resolve) => setTimeout(resolve, 450));

    const shot = await browser.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, direction.id + '.png'), Buffer.from(shot.data, 'base64'));

    const probe = JSON.parse(await browser.evaluate([
      '(function () {',
      '  const dock = document.querySelector(".cy-dock");',
      '  const side = document.querySelector(\'[data-slot="sidebar"]\');',
      '  const body = getComputedStyle(document.body);',
      '  return JSON.stringify({',
      '    dockBlur: dock ? getComputedStyle(dock).backdropFilter : null,',
      '    sideBlur: side ? getComputedStyle(side).backdropFilter : null,',
      '    bg: body.getPropertyValue("--dsw-alias-bg-base").trim(),',
      '    text: body.getPropertyValue("--dsw-alias-label-primary").trim(),',
      '    accent: body.getPropertyValue("--dsw-alias-brand-primary").trim(),',
      '    cardBlur: (function () {',
      '      const card = document.querySelector(".cy-card");',
      '      return card ? getComputedStyle(card).backdropFilter : "no card on screen";',
      '    })()',
      '  });',
      '})()'
    ].join('\n')));

    console.log(direction.id.padEnd(14) + direction.name);
    console.log('   dock  ' + probe.dockBlur);
    console.log('   side  ' + probe.sideBlur);
    console.log('   card  ' + probe.cardBlur);
    console.log('   bg ' + probe.bg + '  text ' + probe.text + '  accent ' + probe.accent);
  }

  // Leave the page as it was found.
  await browser.evaluate(
    'var s = document.getElementById("cy-direction-preview"); if (s) s.remove();'
  );
  console.log('');
  console.log('screenshots -> ' + OUT);
} catch (error) {
  console.log('FAILED: ' + String((error && error.message) || error).slice(0, 500));
  process.exitCode = 1;
} finally {
  await browser.stop();
}
