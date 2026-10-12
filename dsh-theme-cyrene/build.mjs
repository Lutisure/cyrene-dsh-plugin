#!/usr/bin/env node
/**
 * Build `lib/client.js` from `lib/client/*.js`.
 *
 * Three jobs:
 * 1. concatenate the browser-half parts, in filename order, into one classic
 *    script (the client module loader takes a single file via
 *    `exports["./client"]`, and the parts share one factory scope);
 * 2. substitute the five asset markers with JSON URL manifests, so media is
 *    referenced by route URL and **never** inlined — an inlined bundle is what
 *    pushed the reference plugin to 82 MB and broke the combo loader;
 * 3. report exactly what was picked up, and refuse to emit a bundle with a
 *    marker left unsubstituted or a part missing.
 *
 * Usage:
 *   node build.mjs            full build — every asset found on disk
 *   node build.mjs --clean    wallpapers limited to build.include.txt
 *   node build.mjs --check    verify the emitted bundle without writing it
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PARTS_DIR = join(ROOT, 'lib', 'client');
const OUTPUT = join(ROOT, 'lib', 'client.js');
const ROUTE = '/theme-cyrene-assets';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);
const VIDEO_EXT = new Set(['.mp4', '.webm']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.flac', '.ogg', '.oga', '.opus', '.wav']);
const ANIM_EXT = new Set(['.gif', '.webp', '.png']);

/** Marker → the manifest it is replaced with. */
const MARKERS = Object.freeze({
  '/*__CYRENE_WALLPAPERS__*/': 'wallpapers',
  '/*__CYRENE_COVERS__*/': 'covers',
  '/*__CYRENE_MUSIC__*/': 'music',
  '/*__CYRENE_BOOT__*/': 'boot',
  '/*__CYRENE_EMOTES__*/': 'emotes',
  // A scalar rather than a manifest: a URL string, or null when the portrait
  // is missing. `JSON.stringify` quotes it, which is what the client wants.
  '/*__CYRENE_AVATAR__*/': 'avatar',
  '/*__CYRENE_PET__*/': 'pet',
  '/*__CYRENE_DISC__*/': 'disc',
  '/*__CYRENE_CELEBRATE__*/': 'celebrate'
});

/**
 * The brand bucket: images the plugin uses as its own chrome, kept out of
 * `assets/` so they never show up as selectable wallpapers.
 */
const AVATAR_NAME = 'cyrene-avatar.webp';

/**
 * What the music player's disc shows when a track has no cover of its own.
 *
 * The covers bucket ships empty, so "no cover" is not an edge case — it is every
 * track, and the disc rendered as a bare translucent circle with its groove ring
 * and nothing inside. This is the fallback that fills it.
 */
const DISC_NAME = 'disc-cyrene.webp';

/**
 * The end-of-turn flourish: the animation, the still it ends on, and how long the
 * animation runs.
 *
 * The duration comes from a sidecar JSON rather than being parsed here. Reading a
 * GIF's per-frame delays means walking its Graphic Control Extensions, and this
 * file builds; it does not decode. tools/install-celebrate.py measures the file
 * once when the artwork is installed, which is the only moment it can change.
 */
const CELEBRATE_ART = 'celebrate.webp';
const CELEBRATE_LAST = 'celebrate-last.webp';
const CELEBRATE_META = 'celebrate.json';

/**
 * Which expression each harvested sticker carries.
 *
 * Read off the contact sheet (`docs/pet-assets.png`) by **looking**: the real
 * filenames are `sticker-ppg-24-cyrene-01..05`, and the numbers carry no
 * meaning. This map is the only place that knowledge exists, so a renumbered
 * upload would silently shuffle her expressions without it.
 */
const PET_ROLES = Object.freeze({
  'sticker-ppg-24-cyrene-01': { role: 'happy', label: '开心' },
  'sticker-ppg-24-cyrene-02': { role: 'surprised', label: '惊讶' },
  'sticker-ppg-24-cyrene-03': { role: 'smug', label: '得意' },
  'sticker-ppg-24-cyrene-04': { role: 'wink', label: '眨眼' },
  'sticker-ppg-24-cyrene-05': { role: 'sparkle', label: '闪亮' }
});


const MIME = Object.freeze({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav'
});

const args = new Set(process.argv.slice(2));
const CLEAN = args.has('--clean');
const CHECK = args.has('--check');

/** Log one line of build output. */
const say = (message) => process.stdout.write(`${message}\n`);

/**
 * List files in a directory, optionally walking subdirectories.
 * @param {string} dir - absolute directory.
 * @param {{recursive?: boolean, extensions?: Set<string>}} [options] - filters.
 * @returns {Array<{name: string, relative: string, absolute: string, size: number}>} matches.
 */
function listMedia(dir, options = {}) {
  const extensions = options.extensions;
  if (!existsSync(dir)) return [];
  const found = [];
  const walk = (current, prefix) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const absolute = join(current, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (options.recursive === true) walk(absolute, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (extensions !== undefined && !extensions.has(ext)) continue;
      let size = 0;
      try {
        size = statSync(absolute).size;
      } catch {
        continue;
      }
      found.push({ name: entry.name, relative: rel, absolute, size });
    }
  };
  walk(dir, '');
  return found.sort((left, right) => left.relative.localeCompare(right.relative, 'zh-Hans-CN'));
}

/** Percent-encode each segment of a relative path for use in a URL. */
const encodePath = (relativePath) => relativePath.split('/').map((part) => encodeURIComponent(part)).join('/');

/** Strip the extension, for a human-facing label. */
const labelOf = (name) => name.replace(/\.[^.]+$/u, '');

/** Bytes → a short human string, for the build report. */
function human(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)}${units[unit]}`;
}

/**
 * Read `build.include.txt` as an exact-path allow-list.
 * @returns {Set<string>} allowed `assets/<file>` paths.
 */
function readIncludeList() {
  const file = join(ROOT, 'build.include.txt');
  if (!existsSync(file)) return new Set();
  return new Set(readFileSync(file, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#')));
}

/**
 * Read `build.music-exclude.txt` as a bare-filename deny-list.
 * @returns {Set<string>} excluded filenames (lower-cased).
 */
function readMusicExclude() {
  const file = join(ROOT, 'build.music-exclude.txt');
  if (!existsSync(file)) return new Set();
  return new Set(readFileSync(file, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.toLowerCase()));
}

/**
 * Build every manifest the client bundle needs.
 * @returns {{wallpapers: object[], covers: object[], music: object[], boot: object[], emotes: object[]}} manifests.
 */
function collect() {
  const warnings = [];
  const include = CLEAN ? readIncludeList() : undefined;
  const musicExclude = readMusicExclude();

  const wallpapers = [];
  for (const file of listMedia(join(ROOT, 'assets'), { recursive: true, extensions: new Set([...IMAGE_EXT, ...VIDEO_EXT]) })) {
    if (include !== undefined && !include.has(`assets/${file.relative}`) && include.size > 0) continue;
    if (include !== undefined && include.size === 0) {
      warnings.push('build.include.txt is empty — --clean produced no wallpapers');
      break;
    }
    const ext = extname(file.name).toLowerCase();
    wallpapers.push({
      id: `builtin:assets/${file.relative}`,
      name: file.relative,
      label: labelOf(file.name),
      kind: VIDEO_EXT.has(ext) ? 'video' : 'image',
      mime: MIME[ext] ?? 'application/octet-stream',
      url: `${ROUTE}/pkg/assets/${encodePath(file.relative)}`,
      source: 'builtin',
      // The first wallpaper whose name mentions "Default" seeds a fresh install.
      default: /default/iu.test(file.name)
    });
  }
  // Videos first: the grid shows moving wallpapers before stills.
  wallpapers.sort((left, right) => Number(right.kind === 'video') - Number(left.kind === 'video'));

  const covers = listMedia(join(ROOT, 'music', 'figure'), { extensions: IMAGE_EXT }).map((file) => ({
    id: `builtin:covers/${file.name}`,
    name: file.name,
    label: labelOf(file.name),
    mime: MIME[extname(file.name).toLowerCase()] ?? 'image/png',
    url: `${ROUTE}/pkg/music/figure/${encodeURIComponent(file.name)}`,
    source: 'builtin'
  }));

  const coverByStem = new Map(covers.map((cover) => [cover.label.toLowerCase(), cover.url]));
  const music = [];
  for (const file of listMedia(join(ROOT, 'music'), { extensions: AUDIO_EXT })) {
    if (musicExclude.has(file.name.toLowerCase())) continue;
    music.push({
      id: `builtin:music/${file.name}`,
      name: file.name,
      label: labelOf(file.name),
      kind: 'audio',
      mime: MIME[extname(file.name).toLowerCase()] ?? 'audio/mpeg',
      url: `${ROUTE}/pkg/music/${encodeURIComponent(file.name)}`,
      source: 'builtin',
      cover: coverByStem.get(labelOf(file.name).toLowerCase()) ?? null
    });
  }

  const boot = listMedia(join(ROOT, 'GIF'), { extensions: ANIM_EXT }).map((file) => ({
    id: `builtin:GIF/${file.name}`,
    name: file.name,
    label: labelOf(file.name),
    mime: MIME[extname(file.name).toLowerCase()] ?? 'image/gif',
    url: `${ROUTE}/pkg/GIF/${encodeURIComponent(file.name)}`,
    source: 'builtin'
  }));

  const emotes = listMedia(join(ROOT, 'GIF', 'emotes'), { extensions: ANIM_EXT }).map((file) => ({
    id: `builtin:emotes/${file.name}`,
    name: file.name,
    label: labelOf(file.name),
    mime: MIME[extname(file.name).toLowerCase()] ?? 'image/gif',
    url: `${ROUTE}/pkg/GIF/emotes/${encodeURIComponent(file.name)}`,
    source: 'builtin'
  }));


  // Her portrait, if the brand bucket has one. Absent is fine: the collapsed
  // dot falls back to a plain glowing circle.
  const avatarPath = join(ROOT, 'brand', AVATAR_NAME);
  const avatar = existsSync(avatarPath)
    ? `${ROUTE}/pkg/brand/${encodeURIComponent(AVATAR_NAME)}`
    : null;
  if (avatar === null) warnings.push(`no brand/${AVATAR_NAME} — the collapsed dot shows a plain circle`);

  // Same shape as the avatar: one brand image, referenced by route URL. Absent is
  // survivable — the disc goes back to being an empty circle.
  const discPath = join(ROOT, 'brand', DISC_NAME);
  const disc = existsSync(discPath)
    ? `${ROUTE}/pkg/brand/${encodeURIComponent(DISC_NAME)}`
    : null;
  if (disc === null) warnings.push(`no brand/${DISC_NAME} — the music disc shows an empty circle`);

  // The celebration is optional in every part: no art means no overlay, and no
  // sidecar means the animation duration is unknown, which the client treats as
  // "hold immediately" rather than as an error.
  const celebrateArtPath = join(ROOT, 'brand', CELEBRATE_ART);
  const celebrateLastPath = join(ROOT, 'brand', CELEBRATE_LAST);
  const celebrateMetaPath = join(ROOT, 'brand', CELEBRATE_META);
  let celebrateMs = 0;
  if (existsSync(celebrateMetaPath)) {
    try {
      const meta = JSON.parse(readFileSync(celebrateMetaPath, 'utf8'));
      if (Number.isFinite(meta?.ms) && meta.ms >= 0) celebrateMs = Math.round(meta.ms);
    } catch (error) {
      warnings.push(`brand/${CELEBRATE_META} is not valid JSON — the hold timing falls back to zero`);
    }
  }
  const celebrate = existsSync(celebrateArtPath)
    ? {
        art: `${ROUTE}/pkg/brand/${encodeURIComponent(CELEBRATE_ART)}`,
        last: existsSync(celebrateLastPath)
          ? `${ROUTE}/pkg/brand/${encodeURIComponent(CELEBRATE_LAST)}`
          : null,
        ms: celebrateMs
      }
    : null;
  if (celebrate === null) warnings.push(`no brand/${CELEBRATE_ART} — nothing plays when a turn ends`);
  else if (celebrate.last === null) warnings.push(`no brand/${CELEBRATE_LAST} — the animation will not hold its last frame`);

  // The pet's expressions. These are the official chat stickers, which happen to
  // be exactly what a pet needs: chibi, already transparent, and five distinct
  // expressions that a human read off the sheet above.
  const petDir = join(ROOT, 'brand', 'pet');
  const pet = existsSync(petDir)
    ? readdirSync(petDir)
        .filter((name) => name.startsWith('sticker-') && name.endsWith('.webp'))
        .sort()
        .map((name) => {
          const stem = name.replace(/\.webp$/u, '');
          const meta = PET_ROLES[stem] ?? { role: 'idle', label: stem };
          return {
            id: `builtin:pet/${stem}`,
            name,
            role: meta.role,
            label: meta.label,
            url: `${ROUTE}/pkg/brand/pet/${encodeURIComponent(name)}`,
            source: 'builtin'
          };
        })
    : [];
  if (pet.length === 0) warnings.push('no brand/pet stickers — the pet stays off');

  return { wallpapers, covers, music, boot, emotes, avatar, disc, celebrate, pet, warnings };
}

/**
 * Concatenate the browser-half parts in filename order.
 * @returns {{code: string, parts: string[]}} the joined source and the part names.
 */
function concatenateParts() {
  if (!existsSync(PARTS_DIR)) throw new Error(`missing ${relative(ROOT, PARTS_DIR)}`);
  const parts = readdirSync(PARTS_DIR)
    .filter((name) => name.endsWith('.js'))
    .sort((left, right) => left.localeCompare(right));
  if (parts.length === 0) throw new Error(`${relative(ROOT, PARTS_DIR)} holds no .js parts`);

  const missing = ['00-prologue.js', '99-epilogue.js'].filter((name) => !parts.includes(name));
  if (missing.length > 0) throw new Error(`browser half is missing ${missing.join(', ')}`);

  const code = parts
    .map((name) => readFileSync(join(PARTS_DIR, name), 'utf8'))
    .join('\n');
  return { code, parts };
}

function main() {
  const manifests = collect();
  const { code, parts } = concatenateParts();

  let bundle = code;
  for (const [marker, key] of Object.entries(MARKERS)) {
    if (!bundle.includes(marker)) throw new Error(`marker ${marker} not found in any part`);
    const json = JSON.stringify(manifests[key]);
    // A replacer function, not a string: `$&`-style sequences inside JSON would
    // otherwise be interpreted as replacement patterns and corrupt the output.
    bundle = bundle.replace(marker, () => json);
  }

  const leftover = Object.keys(MARKERS).filter((marker) => bundle.includes(marker));
  if (leftover.length > 0) throw new Error(`unsubstituted markers: ${leftover.join(', ')}`);

  const banner = [
    '/* dsh-theme-cyrene — browser half (generated by build.mjs; edit lib/client/*.js) */',
    `/* mode: ${CLEAN ? 'clean' : 'full'} · parts: ${parts.length} */`
  ].join('\n');
  const output = `${banner}\n${bundle}`;

  // ⚠️ 客户端 bundle 的 loader id 必须**等于包名**。
  //
  // 2026-10-12：这个 id 写的是裸名，而包按 npm 的要求加了 `@lutisure/` 作用域 ——
  // 加载器按包名装一次、bundle 又按这个 id 注册一次，同一个文件执行了两遍：
  //
  //     client-modules: duplicate factory registration for "dsh-theme-cyrene"
  //
  // 整个 web boot 起不来。而它只在**装上去之后**才发作 —— 本地构建、测试、`--check`
  // 全都是绿的。所以这道断言放在构建里：**改包名忘了改 id，构建当场失败。**
  //
  // 依据不是惯例，是加载器的要求：两个官方客户端插件
  // （`@deepseek-ai/dsh-client-ui-skill`、`@deepseek-ai/dsh-client-ui-theme`）
  // 的 id 都等于各自的包名。去看一眼就知道。
  const pkgName = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name;
  const declared = /__ModuleLoader__\.load\(\{\s*\n\s*id:\s*"([^"]+)"/u.exec(bundle);
  if (declared === null) {
    throw new Error('客户端 bundle 里找不到 `__ModuleLoader__.load({ id: "..." })` —— 检查 lib/client/00-prologue.js');
  }
  if (declared[1] !== pkgName) {
    throw new Error(
      `客户端 loader id 与包名不一致：\n` +
      `    lib/client/00-prologue.js 里写的是  "${declared[1]}"\n` +
      `    package.json 的 name 是          "${pkgName}"\n` +
      `  两者必须相同 —— 否则加载器会把同一个 bundle 装两次，启动时 duplicate factory registration 直接失败。`
    );
  }

  // A bundle that grows past a few hundred KB starts to threaten the combo
  // loader, so fail loudly rather than shipping something that will not load.
  const bytes = Buffer.byteLength(output);
  const LIMIT = 512 * 1024;
  if (bytes > LIMIT) throw new Error(`bundle is ${human(bytes)}, over the ${human(LIMIT)} budget — assets must not be inlined`);

  if (!CHECK) writeFileSync(OUTPUT, output);

  say(`dsh-theme-cyrene · ${CLEAN ? 'clean' : 'full'} build`);
  say(`  parts      ${parts.length} (${parts.join(', ')})`);
  say(`  wallpapers ${manifests.wallpapers.length}`);
  say(`  covers     ${manifests.covers.length}`);
  say(`  music      ${manifests.music.length}`);
  say(`  boot       ${manifests.boot.length}`);
  say(`  emotes     ${manifests.emotes.length}`);
  say(`  pet        ${manifests.pet.length} expression(s)`);
  for (const warning of manifests.warnings ?? []) say(`  warning    ${warning}`);
  say(`  output     ${relative(ROOT, OUTPUT)} (${human(bytes)})${CHECK ? ' [checked, not written]' : ''}`);

  if (manifests.wallpapers.length === 0 && manifests.music.length === 0) {
    say('  note       no media found — the theme will run as a palette-only theme and');
    say('             pick assets up at runtime through the panel\'s add buttons.');
  }
  if (manifests.boot.length === 0) say('  note       no boot GIF — the opening animation stays off, which is expected.');
  if (manifests.emotes.length === 0) say('  note       no emotes — the emote easter egg stays off, which is expected.');
  if (manifests.pet.length === 0) say('  note       no pet stickers — the companion stays off, which is expected.');
}

main();
