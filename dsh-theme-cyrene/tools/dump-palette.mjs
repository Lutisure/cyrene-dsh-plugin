/**
 * Print the derived palette as JSON, so non-JS consumers (the preview renderer)
 * read the same numbers the theme ships rather than a copy that can drift.
 *
 * Run: node tools/dump-palette.mjs
 */

import { chromaSpread, loadTheme } from './palette.mjs';

const { THEME, TOKENS } = loadTheme();

process.stdout.write(
  `${JSON.stringify(
    {
      surfaces: {
        mask: THEME.mask,
        inkDeep: THEME.inkDeep,
        ink: THEME.ink,
        surface: THEME.surface,
        surfaceHigh: THEME.surfaceHigh
      },
      neutral: THEME.neutral,
      hue: THEME.hue,
      tint: THEME.tint,
      spread: chromaSpread(THEME.surface),
      accents: {
        pink: THEME.pink,
        pinkStrong: THEME.pinkStrong,
        pinkSoft: THEME.pinkSoft,
        purple: THEME.purple,
        text: THEME.text
      },
      borders: [THEME.border.l1, THEME.border.l2, THEME.border.l3, THEME.border.l4],
      radius: THEME.radius,
      shadow: THEME.shadow,
      specular: THEME.specularColor,
      alpha: THEME.alpha,
      tokens: {
        overlay: TOKENS['--dsw-alias-bg-overlay'],
        backdrop: TOKENS['--dsw-menu-backdrop-filter'],
        cornerShape: TOKENS['--dsw-corner-shape'] ?? null
      }
    },
    undefined,
    2
  )}\n`
);
