/**
 * 从本机那份主题状态里，提取「可以当发布默认值」的视觉设置。
 *
 * ## 为什么要分三类，而不是全搬
 *
 * 他 2026-10-11 说「在给其他人的主题时，可以保留我当前的设置」，点名了四样
 * （头像 / 小昔涟默认打开 / dock 头像 / 壁纸）。**但全搬是错的**，因为这份状态里
 * 混着三类完全不同的东西：
 *
 *   一、**外观** —— 壁纸、粒子、色调、拖尾、打字光标、字体。**换台机器照样成立，搬。**
 *   二、**位置** —— dock 在哪、面板在哪、小昔涟在哪。**这些是相对这块屏幕的坐标。**
 *       搬到一台窗口更小的机器上，dock 可能落在屏幕外，而**界面不会报错，
 *       只是再也找不着**。所以不搬（留 null，让它自己找默认位）。
 *   三、**声音** —— 开关、曲目、音量。**收件人第一次打开就自动放音乐是惊吓不是礼物。**
 *       不搬。他想要自己开一个开关就行。
 *
 * ## 头像单独说
 *
 * `avatarCustom` 是一张 base64 内嵌的图。他选的那张和 `brand/` 里 builtin 那张
 * **不是同一张**（160×87 对 256×256），而来源我判断不了 —— 可能是他自己裁的，
 * 也可能是游戏截图。**按 `NOTICE.md`，后者不能随包分发。** 所以这一项不在这里决定。
 *
 * ## `--include-avatar` —— 他要的那条路，但需要他先回答一件事
 *
 * 2026-10-11 他点名要保留头像。**这一项不能默认搬**，理由是上面那条：
 * 来源不明。所以做成**显式开关**，跑的时候必须把来源一起写出来 ——
 * 那句 `--avatar-origin` 会进代码注释，**是给以后的人看的**：
 * 三个月后有人问「这张图哪来的」，注释里得有答案。
 *
 * 用法：
 *   node tools/derive-theme-defaults.mjs                          # 看差异
 *   node tools/derive-theme-defaults.mjs --write                  # 写进 10-constants.js
 *   node tools/derive-theme-defaults.mjs --write \
 *     --include-avatar --avatar-origin "他自己裁的，不是游戏截图"   # 连头像一起
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const THEME = 'dsh-theme-cyrene';
const STATE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'theme-cyrene', 'state.json');
const CONSTANTS = join(import.meta.dirname, '..', 'lib', 'client', '10-constants.js');

/** 外观类：换台机器照样成立，可以当默认值。 */
const LOOK = [
  'wallpaper', 'wallpaperType', 'randomOn',
  'shade', 'wallBrightness', 'wallSaturate', 'wallContrast', 'wallOpacity', 'wallFog', 'wallScale',
  'glass', 'glassHue', 'glassTint', 'glassAlpha', 'glassBlur',
  'particles',
  'clickEffect', 'clickColor', 'clickColorCustom', 'clickOpacity', 'clickBlend',
  'trailEffect', 'trailColor', 'trailColorCustom', 'trailOpacity', 'trailBlend',
  'fontScale', 'fontWeight', 'fontActiveSet',
  'caretColor', 'caretColorCustom', 'caretComposerColor', 'caretComposerCustom',
  'skin',
  'petOn', 'replyAvatar'
  // ⚠️ `avatarSource` **不在这一列**。他选的是 `custom`，而 `custom` 指着一张
  //    base64 内嵌的图；**那张图不随包发**（见文件头）。把默认值设成 `custom`
  //    而图是空的，新装的会是一个空头像 —— **比保持 `builtin` 更坏**。
];

/**
 * 明确**不搬**的，以及为什么。列出来是为了让「不搬」是一个决定，不是遗漏。
 */
const NOT_LOOK = {
  // 位置：相对某块屏幕的坐标，换台机器可能落在屏幕外，而界面不会报错。
  panelPos: '位置 —— 相对屏幕的坐标',
  dockPos: '位置 —— 同上',
  petPos: '位置 —— 同上',
  // 声音：第一次打开就自动放音乐是惊吓不是礼物。
  sound: '声音 —— 收件人自己开一个开关就行',
  musicOn: '声音 —— 同上',
  trackId: '声音 —— 同上',
  loop: '声音 —— 同上',
  volume: '声音 —— 同上',
  // 不该由这份状态决定的。
  avatarCustom: '头像内容 —— 见文件头「头像单独说」',
  dockCollapsed: '界面状态 —— 这是「他现在把 dock 收起来了」，不是外观偏好',
  bootSeen: '界面状态 —— 引导看过没有，每个宿主各自记',
  randomPool: '随机池 —— 里面是文件路径，换了机器就不存在',
  randomMinutes: '随机间隔 —— 属于随机播放的配置，跟着 randomOn 一起留',
  fontSets: '字体集 —— 里面是文件路径',
  fontBodyFamily: '字体 —— 宿主装的字体换了机器不一定有，保持「跟随宿主」',
  fontMonoFamily: '字体 —— 同上',
  hidden: '列表 —— 里面是他隐藏过哪些项，属于使用历史'
};

const state = JSON.parse(readFileSync(STATE, 'utf8'));

/** 从 10-constants.js 里读出现有的 DEFAULT_SETTINGS。 */
const source = readFileSync(CONSTANTS, 'utf8');
const block = /var DEFAULT_SETTINGS = \{([\s\S]*?)\n\};/u.exec(source);
if (block === null) {
  console.log('  ✗ 找不到 DEFAULT_SETTINGS');
  process.exit(1);
}

/** 粗略取出每个键现在的默认值文本。 */
const current = new Map();
for (const m of block[1].matchAll(/^\s{2}(\w+):\s*(.+?),?\s*$/gm)) {
  current.set(m[1], m[2].replace(/,$/u, ''));
}

console.log(`\n  本机状态 ${state ? Object.keys(state).length : 0} 个键\n`);

const lines = [];
let same = 0;
let diff = 0;
let unknown = 0;
let missing = 0;
let expressions = 0;

for (const key of LOOK) {
  const now = current.get(key);
  if (now === undefined) {
    console.log(`    ?  ${key.padEnd(22)} DEFAULT_SETTINGS 里没有这个键`);
    unknown += 1;
    continue;
  }
  // ⚠️ 状态里**没有**这个键时，`state[key]` 是 undefined。
  //    第一版直接 `JSON.stringify` 它，打出「→ undefined」，
  //    而 `--write` 会把字面量 `undefined` 写进源码 —— **那是一个语法上合法、
  //    语义上全错的默认值**（读出来真的是 undefined，不是「不设置」）。
  //    「他没改过这一项」和「他把它设成了 undefined」是两回事。
  if (!Object.hasOwn(state, key)) {
    missing += 1;
    continue;
  }
  // ⚠️ 默认值写成 `THEME.shade` 这种表达式时，**文本比对没有意义** ——
  //    它和 `0.7` 可能本来就是同一个数。当成差异会误报，写死又丢掉「跟着主题走」这个性质。
  //    所以这一类只列出来给人看，不自动写。
  if (!/^[\d."'\-[tfn]/u.test(now.trim())) {
    expressions += 1;
    console.log(`    ~  ${key.padEnd(22)} ${now.padEnd(26)} 是表达式，与 ${JSON.stringify(state[key])} 无法直接比`);
    continue;
  }
  const text = JSON.stringify(state[key]);
  if (now.trim() === text) {
    same += 1;
    continue;
  }
  diff += 1;
  console.log(`    →  ${key.padEnd(22)} ${now.padEnd(26)} → ${text}`);
  lines.push({ key, now, text });
}

console.log('');
console.log(
  `    相同 ${same} 项，不同 ${diff} 项` +
  `${missing === 0 ? '' : `，他没设过 ${missing} 项`}` +
  `${expressions === 0 ? '' : `，是表达式 ${expressions} 项`}` +
  `${unknown === 0 ? '' : `，认不出 ${unknown} 项`}`
);

console.log('\n  明确不搬的：\n');
for (const [key, why] of Object.entries(NOT_LOOK)) {
  const has = key in state;
  console.log(`    ·  ${key.padEnd(20)} ${has ? '(本机有这个键)' : '(本机没有)'}  ${why}`);
}

if (!process.argv.includes('--write')) {
  console.log('\n  加 --write 写进 10-constants.js\n');
  process.exit(0);
}

// ---- 头像：显式开关，而且必须交代来源 ------------------------------------
//
// ⚠️ 他 2026-10-11 说头像「是自己截的图」——**但那和「游戏截图」在版权上是同一件事**：
//    截图这个动作不改变画面上是谁画的东西。这一项**默认不搬**，因为它和
//    `NOTICE.md` 那条线（游戏素材不进 MIT 包）冲突，而那条线是他自己划的。
//
//    所以做成开关。打开的时候**必须同时给出「这张图哪来的」** ——
//    那句话会写进代码注释，**是给三个月后的人看的**：有人问「这张图哪来的」，
//    注释里得有答案，而不是只能去翻聊天记录。
// ⚠️ 声明要在用之前 —— 我第一版把 `let avatarPlan = null;` 放在了 `if (withAvatar)`
//    后面，于是那个分支里对它赋值时它还在暂时性死区里。**同一个错今晚犯了两次。**
let avatarPlan = null;

const withAvatar = process.argv.includes('--include-avatar');
if (withAvatar) {
  const at = process.argv.indexOf('--avatar-origin');
  const origin = at === -1 ? '' : String(process.argv[at + 1] ?? '').trim();
  if (origin.length < 6) {
    console.log('\n  ✗ --include-avatar 要和 --avatar-origin "<来源>" 一起用。');
    console.log('    那句话会写进代码注释 —— 以后有人问「这张图哪来的」，注释里得有答案。\n');
    process.exit(1);
  }
  if (!Object.hasOwn(state, 'avatarCustom') || String(state.avatarCustom).trim() === '') {
    console.log('\n  ✗ 本机状态里没有 avatarCustom，没有可搬的图。\n');
    process.exit(1);
  }
  const dataUrl = String(state.avatarCustom);
  if (!dataUrl.startsWith('data:image/')) {
    console.log(`\n  ✗ avatarCustom 不是 data URL：${dataUrl.slice(0, 40)}\n`);
    process.exit(1);
  }
  const bytes = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);
  console.log(`\n  ⚠️ 连头像一起搬：${bytes} 字节的图，来源写成「${origin}」`);
  console.log('     这一项会让包里带上游戏素材 —— 和 NOTICE.md 的那条线冲突。是你决定的。\n');
  avatarPlan = { dataUrl, origin };
}

// ---- 写回去 --------------------------------------------------------------
//
// 只替换「值」，保留上面那些注释 —— 那些注释解释了每个默认值为什么是它。
if (lines.length === 0 && avatarPlan === null) {
  console.log('\n  没有要改的。\n');
  process.exit(0);
}

let next = source;
for (const { key, now, text } of lines) {
  // 行首两个空格缩进、`key: 值,` 的形状。注释在上一行，不动。
  const re = new RegExp(`^(\\s{2}${key}:\\s*)${now.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(,?)$`, 'mu');
  if (!re.test(next)) {
    console.log(`    ✗ ${key} 没匹配上，跳过`);
    continue;
  }
  next = next.replace(re, `$1${text}$2`);
}

// 头像：两张一起改 —— `avatarSource` 和 `avatarCustom`。
//
// 分开改会留下一个**中间态**：源写成 `custom` 而图还是空的，
// 那正好是这一项要避免的坏状态（新装的会是个空头像）。
let avatarWritten = false;
if (avatarPlan !== null) {
  const srcRe = /^(\s{2}avatarSource:\s*)("[^"]*"|\S+?)(,?)$/mu;
  const customRe = /^(\s{2}avatarCustom:\s*)(".{0,40}"|''|\S+?)(,?)$/mu;
  if (!srcRe.test(next) || !customRe.test(next)) {
    console.log('    ✗ 头像那两行没匹配上，跳过');
  } else {
    // 注释写进代码 —— **这是这一项最要紧的部分**。
    const note = `  // ⚠️ 头像来源（2026-10-11 他本人口述）：${avatarPlan.origin}\n` +
      '  // 这一项和 NOTICE.md 那条线（游戏素材不进 MIT 包）冲突，是他权衡后决定的。\n' +
      '  // 要撤掉：把下面两行改回 `avatarSource: "builtin"` 和 `avatarCustom: ""`。\n';
    next = next.replace(srcRe, (m, pre, _v, tail) => `${note}${pre}"custom"${tail}`);
    next = next.replace(customRe, (m, pre, _v, tail) => `${pre}${JSON.stringify(avatarPlan.dataUrl)}${tail}`);
    avatarWritten = true;
  }
}

writeFileSync(CONSTANTS, next, 'utf8');
console.log(`\n  写了 ${lines.length} 项进 ${CONSTANTS}`);
if (avatarWritten) console.log('  头像也写进去了 —— 注释里记了来源和撤掉的办法');
console.log('  ⚠️ 改完要重建：node build.mjs\n');
