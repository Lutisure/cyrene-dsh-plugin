/**
 * Human-readable palette report.
 *
 * A theme can look better and still be unreadable, and contrast is the one
 * property of a redesign that can be measured instead of eyeballed.
 *
 * Run: node tools/check-contrast.mjs
 */

import { chromaSpread, contrastRows, loadSkins, loadTheme } from './palette.mjs';

const { THEME, TOKENS } = loadTheme();

console.log(`derived chrome (THEME.tint = ${THEME.tint}, hue ${THEME.hue}):`);
for (const key of ['mask', 'inkDeep', 'ink', 'surface', 'surfaceHigh']) {
  console.log(`  ${key.padEnd(12)} ${THEME[key]}`);
}
console.log(`  hue leak (max channel spread): ${chromaSpread(THEME.surface)}`);
console.log(`  tint 0 would give Apple's plain greys, e.g. ${THEME.neutral.base} (spread ${chromaSpread(THEME.neutral.base)})`);
console.log('  the palette it replaced was #3a2c52 (spread 24)');

console.log('\ncontrast over a mid-tone wallpaper (target in brackets):');
const rows = contrastRows(THEME, TOKENS);
for (const row of rows) {
  console.log(`  ${row.ok ? 'ok  ' : 'FAIL'} ${row.name.padEnd(28)} ${row.ratio.toFixed(2)}:1   [>= ${row.target}]`);
}
const failures = rows.filter((row) => !row.ok).length;
console.log(`\n${failures === 0 ? 'all pass' : `${failures} below target`}`);

// Every skin, against every target. A preset palette is exactly where a
// readability floor gets lost: the eight sets were designed as *colour*, and
// this is the only place that asks whether they can still be read.
console.log('\nall eight skins, same targets:');
const skinRun = loadSkins();
let skinFailures = 0;
for (const skin of skinRun.skins) {
  skinRun.apply(skin.id);
  const skinRows = contrastRows(skinRun.THEME, skinRun.TOKENS);
  const bad = skinRows.filter((row) => !row.ok);
  skinFailures += bad.length;
  const worst = skinRows.reduce((low, row) => (row.ratio < low.ratio ? row : low), skinRows[0]);
  console.log(
    `  ${bad.length === 0 ? 'ok  ' : 'FAIL'} ${skin.name.padEnd(12)} ` +
    `worst ${worst.ratio.toFixed(2)}:1 (${worst.name}, target ${worst.target})`
  );
  for (const row of bad) console.log(`         ${row.name} ${row.ratio.toFixed(2)}:1 < ${row.target}`);
}
console.log(skinFailures === 0 ? '  all skins pass' : `  ${skinFailures} skin targets missed`);

// Leave the shipped palette in place for the token dump below.
skinRun.apply('host');

console.log('\nkey tokens:');
for (const key of [
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l2',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-elevation-panel',
  '--dsw-elevation-stroke',
  '--dsw-menu-backdrop-filter',
  '--dsw-radius-md',
  '--dsw-focus-ring-width'
]) {
  console.log(`  ${key} = ${TOKENS[key]}`);
}
console.log(
  `  --dsw-corner-shape overridden? ${
    TOKENS['--dsw-corner-shape'] === undefined
      ? 'no — the shipped superellipse(1.5) stands'
      : 'yes (the squircle is lost)'
  }`
);

process.exit(failures === 0 && skinFailures === 0 ? 0 : 1);
