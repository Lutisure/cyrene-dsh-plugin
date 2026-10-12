/**
 * Final acceptance: is her identity intact?
 *
 * The brief's constraint was explicit — the palette, the emotes, the disc
 * artwork and the door-peek image must survive all of this. That is a claim about
 * the *built output*, so this reads the built bundle and the asset tree rather
 * than trusting the module sources.
 *
 * ⚠️ 「identity」在这里指**她的美术身份** —— 人像、表情、配色、皮肤表。
 * 它不查、也从来没查过**插件的身份串**。
 *
 * 2026-10-12 的崩溃正是从这个缝里过去的：包名加上了 `@lutisure/` 作用域，
 * 而 bundle 里的 loader id 还是裸名，装上去 `duplicate factory registration`
 * 直接起不来 —— 这个文件叫 identity，通过得漂漂亮亮。
 *
 * 查身份串的是 `build.mjs` 里那道断言（改了包名忘了改 id，构建当场失败）。
 * 两件事都叫 identity，但一件是她的，一件是这个包的。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';

// ---- 仓库根，从本文件的位置推（由 tools/derive-roots.mjs 加的头）----
//
// 以前这里写的是作者机器上的绝对路径。那只在那台机器上成立，
// 而且清洗脚本会把绝对路径换成占位符，于是代码里出现 <本仓库> 这种目录名，直接崩。
import { fileURLToPath as __f } from 'node:url';
import { dirname as __d, join as __j } from 'node:path';
const REPO_ROOT = __j(__d(__f(import.meta.url)), '../..');

import { loadTheme } from './palette.mjs';

const root = `${REPO_ROOT}/dsh-theme-cyrene`;
const bundle = readFileSync(`${root}/lib/client.js`, 'utf8');

// Read from the constants rather than pasted here. These three checks used to
// hold literals, so repainting the palette turned this gate red — and a gate
// that goes red for a colour it was never told about is worse than no gate, since
// its failure stops being distinguishable from a real identity break.
const { THEME } = loadTheme();

const line = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(30)} ${detail ?? ''}`);
  return ok ? 0 : 1;
};

let bad = 0;

console.log('her identity:');
bad += line('portrait (门后探头/收起态)', bundle.includes('cyrene-avatar.webp'), 'brand/cyrene-avatar.webp');
bad += line('disc artwork (转盘)', bundle.includes('celebration') || bundle.includes('DISC'), String(bundle.includes('/brand/') ));
bad += line('emotes', /var EMOTES = \[/.test(bundle) || bundle.includes('emotes'), '');
bad += line('pet frames', bundle.includes('pet/') || bundle.includes('PET ='), '');
bad += line(`accent ${THEME.pinkStrong}`, bundle.includes(THEME.pinkStrong), 'the pink emphasis is built on');
bad += line(`pink ${THEME.pink}`, bundle.includes(THEME.pink), '');
bad += line(`text ${THEME.text}`, bundle.includes(THEME.text), '');

console.log('\nassets on disk:');
for (const dir of ['brand', 'brand/pet', 'assets', 'emotes', 'music']) {
  const at = `${root}/${dir}`;
  if (!existsSync(at)) { console.log(`  --   ${dir.padEnd(30)} (absent)`); continue; }
  const files = readdirSync(at).filter((name) => !name.startsWith('.'));
  console.log(`  ok   ${dir.padEnd(30)} ${files.length} 个文件`);
}

console.log('\nthe skin table does not rewrite those colours:');
const skins = readFileSync(`${root}/lib/client/12-skins.js`, 'utf8');
const shipped = /id: "host"[\s\S]*?pink: "#ffc9e6"/u.test(skins);
bad += line('原色 skin == shipped accent', shipped, 'the first preset restores, never replaces');
bad += line('neutral ladder shared', skins.includes('SKIN_NEUTRAL') && skins.includes(THEME.neutral.base), 'the ladder the constants ship, which every skin must share');

console.log('\nmodule inventory:');
const parts = readdirSync(`${root}/lib/client`).filter((name) => name.endsWith('.js')).sort();
console.log(`  ${parts.length} parts:`);
console.log('    ' + parts.join(' '));

console.log(`\n${bad === 0 ? 'IDENTITY INTACT' : bad + ' PROBLEMS'}`);
// Full asset listing for the door-peek file specifically, since it was named.
const brandDir = `${root}/brand`;
if (existsSync(brandDir)) {
  console.log('\nbrand/ contents:');
  for (const name of readdirSync(brandDir)) console.log('  ' + name);
}
