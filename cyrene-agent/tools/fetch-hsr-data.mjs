/**
 * 重新抓取崩坏：星穹铁道的剧情文本所需的数据表。
 *
 * 背景见 docs/STORY-EXTRACTION.md。这套东西原本放在 %TEMP% 里，会被系统清理，
 * 而且抽取脚本写死了那个路径——TEMP 一清，整个流程就废了。所以：
 *
 *   · 数据落到仓库的 .data/hsr（进 .gitignore），抽取脚本默认读那里；
 *   · 抓取过程写成这个脚本，换机器或 F 盘重建都能一条命令跑回来。
 *
 * 用法：
 *   node tools/fetch-hsr-data.mjs              # 缺什么抓什么
 *   node tools/fetch-hsr-data.mjs --force      # 全部重抓
 *   HSR_DATA=D:/somewhere node tools/fetch-hsr-data.mjs
 *
 * 注意：这里抓的是 **GitHub 上的公开数据包**，本来就是明文 JSON。
 * 本机游戏目录里的 AssetBundle 没有被解过，也不在这个脚本的范围内。
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// ---- 仓库根，从本文件的位置推（由 tools/derive-roots.mjs 加的头）----
//
// 以前这里写的是作者机器上的绝对路径。那只在那台机器上成立，
// 而且清洗脚本会把绝对路径换成占位符，于是代码里出现 <本仓库> 这种目录名，直接崩。
import { fileURLToPath as __f } from 'node:url';
import { dirname as __d, join as __j } from 'node:path';
const REPO_ROOT = __j(__d(__f(import.meta.url)), '../..');

import { assertSafe } from '../safe-url.mjs';

const DATA = (process.env.HSR_DATA ?? `${REPO_ROOT}/.data/hsr`).replace(/\\/g, '/');
const FORCE = process.argv.includes('--force');
const REPO = 'https://github.com/DimbreathBot/TurnBasedGameData.git';
const RAW = 'https://raw.githubusercontent.com/DimbreathBot/TurnBasedGameData/main/ExcelOutput';

/** 必需的表。顺序无关，体积只用来做「抓全了没有」的判断。 */
const TABLES = [
  ['TextMapCHS.json', 40e6, '哈希 → 中文正文'],
  ['TalkSentenceConfig.json', 30e6, 'TalkSentenceID → 文本 / 说话人 / VoiceID'],
  ['VoiceConfig.json', 5e6, 'VoiceID → VoicePath（场景名与序号都在这）'],
  ['VoiceAtlas.json', 1e6, 'AvatarID → 每个角色有哪些语音'],
  ['MainMission.json', 1e6, '任务 → 类型 / 章节 / 名字'],
  ['MissionChapterConfig.json', 1e4, '章节名与所属世界'],
  ['MainMissionType.json', 1e3, '任务类型枚举'],
  ['AvatarConfig.json', 1e5, '角色 ID → 名字'],
  ['StoryAtlas.json', 3e4, '角色故事'],
  ['StoryCharacter.json', 1e5, '角色故事里的人物'],
  ['MainStoryActView.json', 1e3, '幕次'],
  ['MessageItemConfig.json', 1e6, '短信正文'],
  ['MessageSectionConfig.json', 5e4, '短信分节'],
];

mkdirSync(DATA, { recursive: true });
console.log('数据目录 ' + DATA);
console.log('');

function ok(name, min) {
  const p = join(DATA, name);
  return existsSync(p) && statSync(p).size >= min;
}

// ── 1. CSV 表 ────────────────────────────────────────────────────────────
/**
 * 抓之前先验目标。守卫本体在 `../safe-url.mjs` —— 搬出去是为了能测它。
 *
 * 安全扫描器对下面那行 `fetch(url)` 报过**三次**「地址来自外部输入」。
 * 三次都是误报：RAW 是文件顶部的写死常量，name 来自写死的 TABLES，
 * 没有任何外部输入能进到这个 URL 里。
 *
 * 但「是误报」这句话之前只写在注释里。现在 `test/safe-url.test.mjs` 里有
 * 一批绕过尝试（userinfo、后缀伪装、IDN、尾点、IP 字面量、非 https 协议）
 * 在验它 —— 那句话从断言变成了结论。
 */

let got = 0, skipped = 0, failed = 0;
for (const [name, min, why] of TABLES) {
  if (!FORCE && ok(name, min)) { skipped++; continue; }
  let url;
  try { url = assertSafe(`${RAW}/${name}`); }
  catch (e) { console.log('  ' + name + ' 目标校验失败：' + e.message); failed++; continue; }
  process.stdout.write(`  ${name.padEnd(30)} ${why}  … `);
  try {
    // 这里的 url 是上面 assertSafe() 的返回值，主机名已经精确核对过。
    // RAW 是文件顶部的写死常量，name 来自写死的 TABLES —— 没有外部输入能进来。
    // 安全扫描器对这一行报过两次「地址来自外部输入」，两次都是误报；
    // 判断依据是上面那个守卫，不是这一行的写法。
    const res = await fetch(url, { redirect: 'error' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(join(DATA, name), buf);
    console.log((buf.length / 1e6).toFixed(1) + ' MB');
    got++;
  } catch (e) {
    console.log('失败：' + e.message);
    failed++;
  }
}
console.log('');
console.log(`抓取 ${got} 个，跳过 ${skipped} 个（已存在），失败 ${failed} 个`);

// ── 2. 剧情场景图（稀疏克隆） ───────────────────────────────────────────
const repoDir = join(DATA, 'TurnBasedGameData');
if (FORCE || !existsSync(join(repoDir, 'Story/Discussion/Mission'))) {
  console.log('');
  console.log('克隆剧情目录（稀疏，只取 Story/Discussion/Mission 和 Story/Mission）…');
  try {
    if (existsSync(repoDir)) execFileSync('git', ['-C', repoDir, 'pull', '--depth', '1'], { stdio: 'inherit' });
    else {
      execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', '--depth', '1', REPO, repoDir], { stdio: 'inherit' });
      execFileSync('git', ['-C', repoDir, 'sparse-checkout', 'init', '--cone'], { stdio: 'inherit' });
      execFileSync('git', ['-C', repoDir, 'sparse-checkout', 'set', 'Story/Discussion/Mission', 'Story/Mission'], { stdio: 'inherit' });
      execFileSync('git', ['-C', repoDir, 'checkout'], { stdio: 'inherit' });
    }
  } catch (e) {
    console.log('克隆失败：' + e.message);
  }
} else {
  console.log('');
  console.log('剧情目录已存在，跳过（--force 可重抓）');
}

// ── 3. 收尾检查 ─────────────────────────────────────────────────────────
console.log('');
const storyDir = join(repoDir, 'Story/Discussion/Mission');
if (existsSync(storyDir)) {
  const { readdirSync } = await import('node:fs');
  const n = readdirSync(storyDir).filter((x) => /^\d+$/.test(x)).length;
  console.log('剧情目录里有 ' + n + ' 个任务');
} else {
  console.log('⚠ 剧情目录不在，抽取脚本会什么都读不到');
}
console.log('');
console.log('下一步：node tools/extract-main-story-voiced.mjs');
