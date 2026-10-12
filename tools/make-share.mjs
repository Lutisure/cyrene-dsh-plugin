/**
 * 打一份**可以给别人**的副本。
 *
 * ## 为什么不能直接把仓库发出去
 *
 * 有三类东西不能离开这台机器，而且它们的原因各不相同：
 *
 * 1. **`deploy/`** —— 这台机器的运行状态：记忆、修正、主题状态，以及一份把这些
 *    内联进去的技能快照。别人拿到应该是**空白的自己**，不是「记得你的事的昔涟」。
 *
 * 2. **构建产物 `dist`** —— 这一条最容易漏。它是构建产物，但 `build.mjs` 在构建时把
 *    `memory.md` 和 `corrections.md` **内联进 SKILL.md**，所以 `dist/` 里带着你的
 *    私人记忆。**排除 `deploy/` 是不够的** —— 这正是这份脚本存在的理由。
 *
 * 3. **`assets/` `music/` `GIF/` `brand/`，以及 corpus 开头的那些目录** —— 游戏美术、
 *    音频和原作语料。只在本机个人使用，**没有分发权**。仓库声明 MIT 而里面装着这些，
 *    等于声称素材也是 MIT 的，那是错的。
 *
 * ## 给出去的是源码，不是成品
 *
 * 收件人拿到之后自己 build 一次：他的 memory.md 是空的，构建出来的技能里就没有记忆。
 * 「互不相干」这件事不需要额外设计 —— 它就是「发源码而不是发构建产物」的自然结果。
 *
 * ## 导出之后要验导出物
 *
 * 脚本最后对**目标目录**跑一遍 `audit-shareable.mjs`，不是对源目录。验源目录只能
 * 证明「我知道什么该排除」，验导出物才能证明「我真的排除了」。
 *
 * 用法：
 *   node tools/make-share.mjs ../dsh-cyrene-share
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, basename, dirname } from 'node:path';

const target = process.argv[2];
if (target === undefined) {
  console.error('  用法: node tools/make-share.mjs <目标目录>');
  process.exit(2);
}
const OUT = resolve(target);
const SRC = process.cwd();
if (OUT.startsWith(SRC)) {
  console.error('  目标目录不能在源仓库里面 —— 否则下一次导出会把上一次的也带上。');
  process.exit(2);
}

/** 每个包要排除的东西。理由写在上面。 */
const PACKAGES = [
  // ⚠️ `corpus-src` 一开始漏了。
  //
  // 排除清单里写的是 `'corpus'` 和 `'corpus-raw'`，而那个目录叫 `corpus-src` ——
  // **精确匹配一个也拦不住**，6 MB 游戏原文（主线全文、支线、对话 jsonl）就这么
  // 进了分享副本。而 `SHARING.md` 里写的是排除「`corpus*`」，文档和实现对不上。
  //
  // 同一类 bug 在这个文件里出现过三次（另两次见下面 TOP_SKIP_PREFIX 的注释）。
  // 所以这里的匹配改成**前缀**：凡是 `corpus` 开头的目录一律不要。
  // ⚠️ `data/` 也要排除：那是**运行状态**，和 `deploy/\` 同一类。
  //
  // 里面是 `data/logs/worldbook.jsonl`（世界书每轮的注入留痕）。那个日志
  // **不含用户说的话**（字段只有 at/session/turn/hits/sent/dropped/chars），
  // 但它含**命中了哪几条设定** —— 而条目 id 就是话题。别人拿到它能看出
  // 作者问过什么、对什么感兴趣。那是私人材料。
  //
  // ⚠️ 模式那套（Chat/Work/Code/Learn）**刻意不外发**。
  //
  // 2026-10-10，使用者定的：那四个模式**没做完善**，与其带着半成品出去，
  // 不如只发主题、skill、guard 三个成熟的部分。这个判断是对的 ——
  // 排除的是**预设检查器那一套**：判定逻辑、命令行入口、以及它的测试。
  // **去掉之后包仍然装得上也跑得起来** —— 它们不参与构建，只是在开发时查本机预设结构。
  //
  // 2026-10-11 之前这条还列着九个文件（模式生成器、模式正文、模式评测用例…）。
  // 那三档模式（work / code / learn）后来整个去掉了，文件也没了 ——
  // **列表里只剩还在的这三个。** `cyrene` 和 `cyrene-dev` 是本机 preset，
  // 检查器仍然用得上，所以留在仓库里、不进分享副本。
  //
  // ⚠️ 连带后果：测试数会变。README 上原来的 205 是裁剪之前量的，
  //    必须重新量一遍再写 —— 指南里「描述必须属实」查的就是这个。
  { name: 'cyrene-agent', skip: [
    // ⚠️ `docs/` 是**迭代记录**（问题复盘、交接、设想、以及每次的基线），
    //    不是插件的运行必需品。**发出去等于把自己的过程一并发了。**
    'docs',
    'node_modules', 'dist', 'data', '__pycache__',
    'presets-check.mjs', 'presets-check.test.mjs', 'check-presets.mjs',
    // ⚠️ `corpus/` 走**精确匹配**（这个 skip 列表就是精确匹配的），
    //    写成 `'corpus/'` 放进下面那个前缀列表是错的 —— 前缀比的是目录名，
    //    而目录名里没有斜杠，那一条会一条都拦不住。
    'corpus'
    // ⚠️ 2026-10-11 反转：**`corpus-src/` 现在随包发。**
    //
    // 原来这里是 `skipPrefix: ['corpus']`，前缀匹配把 `corpus-src/` 一起拦了 ——
    // 而 `corpus-src/` 正是**剧情检索（RAG）的源材料**。
    //
    // 他 2026-10-11 问：「我们的 RAG 不是基于游戏剧情文本吗，那么这一块是要跟着分发吗。」
    // **问得对，而当时的答案是「不跟」—— 那意味着收件人拿到一个叫得应但答不上话的 RAG。**
    //
    // 他的判据和素材那次一样：**能让别人装上就能用。**
    // 一个查出空结果的检索不算能用。
    //
    // 所以区分开：
    //   `corpus-src/`       **发**。剧情原文，10.8 MB。索引由它建，收件人可重跑、可核对。
    //   `corpus-raw/`       不发。原始抓取中间态，2.2 MB，构建不读它。
    //   `corpus-backup-*`   不发。备份。
    //   `corpus/`           不发。派生缓存 0.4 MB。
    //   `dialogue-corpus.yaml` 见上面 skip 那一列。
    //
    // **保留前缀匹配**（原来那个 bug 的教训还在），只是把前缀收窄到真正该排除的三个。
  ], skipPrefix: ['corpus-raw', 'corpus-backup'] },
  // ⚠️ 2026-10-11 反转：**素材现在随包发。**
  //
  // 原来这里排除 `assets` `music` `GIF` `brand`，理由是那些是游戏美术、
  // 不在本项目的 MIT 范围内。他当时的判断是「宁可不发」。
  //
  // 他改主意了，原话是「**贴纸也要一起发，能让别人装上就能用**」。
  // 理由站得住：**一个装上之后没有小昔涟、没有人像、没有壁纸的主题，
  // 不叫「能用的主题」。** 收件人得自己去 wiki 收贴纸、自己找壁纸 —— 那不叫装上就能用。
  //
  // **这不是把版权问题抹掉，是把声明改对。** `NOTICE.md` 从「不包含素材」
  // 改成「包含素材，但不适用 MIT，仅供个人使用」——**包里装着东西而声明说没有，
  // 那才是真问题。** 声明和内容对得上就行。
  //
  // `docs/` **仍然排除**：那里面是预览图和张贴用的衍生品（头像候选、开场帧预览），
  // 运行时一个都用不到，7.5 MB。**「能跑」不需要它。**
  { name: 'dsh-theme-cyrene', skip: ['node_modules', 'docs', 'dist', 'dist-emotes-edit', '__pycache__'] },
  { name: 'cyrene-guard', skip: ['node_modules', '__pycache__'] }
];

/** 顶层要带上的东西。刻意不含 deploy/。 */
const TOP_FILES = [
  '.gitattributes', '.gitignore', 'LICENSE',
  'NOTICE.zh.md', 'SHARING.zh.md',
  'README.md', 'SECURITY.md', 'UPREPORT.md',
  // ⚠️ 2026-10-12：这两个是**根目录那个合一包**的入口，缺一个别人就装不上。
  //
  // 那张包叫 `cyrene-dsh-plugin`：它自己带 `dsh.bundle`，依赖三个子包，
  // 而它的 `cordis.patch.yml` 把三条 insert 合成一份 —— 「合成配置」正是
  // 插件市场对聚合包唯一放行的行为（纯依赖清单不收）。
  //
  // **而这两行是必须的，不是顺手加的。** `TOP_FILES` 是一张**显式清单**，
  // 根目录新加的文件默认都不在里面 —— 所以不写这两行，导出物里就少两个文件，
  // **而那种错在本地完全看不出来**：源码里它们在，测试也过，包也打得出来，
  // 只有别人 clone 下来才发现没有入口。
  //
  // 同一族的事今天已经撞过一次：`dsh-theme-cyrene/README.md` 引着 `docs/` 里
  // 一张图，而 `docs/` 不随包发 —— 那张图在源码里看得见、在别人那边是碎的。
  'package.json',
  'cordis.patch.yml'
];
const TOP_DIRS = ['setup', 'tools', 'docs'];

/**
 * ⚠️ 顶层目录下还要再跳过的名字（**前缀**匹配）。
 *
 * 2026-10-10：第一次跑这个脚本时，它**自己抓到两处泄露** —— 都在
 * `setup/_backup_20261009-233250/` 里，那是排查行尾问题时留的 profile 补丁备份，
 * 而补丁里内联着使用者的私人记忆。**内容不在这里复述**（理由见下）。
 *
 * 那个目录已经挪出仓库了，但排除清单里也留一条 —— 备份是会再生的，
 * 而下一次不一定有人想起来跑审计。**「已经删了」不是一个能长期成立的保证。**
 *
 * ⚠️ 必须是**前缀**匹配：备份目录的名字带时间戳（`_backup_<时间戳>`），
 * 精确匹配 `'_backup'` 一个也拦不住。第一版就是精确匹配，变异测试当场抓出来了 ——
 * 造一个 `_backup_TEST` 放进去，它照样被带了出去。
 *
 * ⚠️ 还有一件，值得单独记：**别把你正在防的东西原样写进注释。**
 * 这一段的初版为了说明泄露，把那句私人记忆**抄进了注释里** ——
 * 于是脚本自己的源码变成了新的泄露点，审计工具当场报了它。
 * 描述「在哪、什么类型」就够了，**不要复述内容**。
 */
const TOP_SKIP_PREFIX = ['_backup', 'backup', 'mesh-access', 'firewall-mesh', 'phone-bridge'];

console.log(`\n  从 ${SRC}`);
console.log(`  到 ${OUT}\n`);

// ⚠️ **导出目录整个删掉重建 —— 但 `.git` 要留下。**
//
// 2026-10-11：这个脚本一直是 `rmSync(OUT, recursive)`。而分享副本是要
// `git init` 之后推上 GitHub 的 —— **那一推就把它自己删了**：
// 下次导出、`.git` 没了、历史全没，而当下不会报任何错。
//
// 所以先把它挪到一边，重建完再挪回来。
// **只有 `.git`**：其余一切（包括 `.gitignore`、`.gitattributes`）都是**生成物**，
// 每轮都该由源仓库重新写一遍 —— 留它们反而会让导出物和源不一致。
const stash = join(dirname(OUT), `.git-stash-${process.pid}`);
let hadGit = false;
if (existsSync(join(OUT, '.git'))) {
  rmSync(stash, { recursive: true, force: true });
  cpSync(join(OUT, '.git'), stash, { recursive: true });
  hadGit = true;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

if (hadGit) {
  cpSync(stash, join(OUT, '.git'), { recursive: true });
  rmSync(stash, { recursive: true, force: true });
  console.log('  （保留了目标目录里已有的 .git —— 否则 git 历史会跟着没）');
}


let copied = 0;

/**
 * 造一个 cpSync 的 filter。
 *
 * ⚠️ 支持两种匹配，而且**必须支持前缀那种**。
 *
 * 精确匹配（`skip`）拦不住带后缀的同类目录：`corpus` 拦不住 `corpus-src`，
 * `_backup` 拦不住 `_backup_20261009-233250`。这个文件里前后栽过三次。
 * 所以凡是「同类会再生、名字带时间戳或后缀」的，一律走 `skipPrefix`。
 */
const filterFor = (skip, skipPrefix = []) => (from) => {
  const base = from.split(/[\\/]/u).pop();
  if (skip.includes(base)) return false;
  for (const prefix of skipPrefix) if (base.startsWith(prefix)) return false;
  return true;
};

for (const pkg of PACKAGES) {
  const from = join(SRC, pkg.name);
  if (!existsSync(from)) {
    console.log(`  --   ${pkg.name} 不存在，跳过`);
    continue;
  }
  cpSync(from, join(OUT, pkg.name), { recursive: true, filter: filterFor(pkg.skip, pkg.skipPrefix ?? []) });
  copied += 1;
  console.log(`  ✓    ${pkg.name}   排除 ${[...pkg.skip, ...(pkg.skipPrefix ?? []).map((p) => p + '*')].join(', ')}`);
}

for (const file of TOP_FILES) {
  if (existsSync(join(SRC, file))) {
    cpSync(join(SRC, file), join(OUT, file));
    copied += 1;
  }
}
for (const dir of TOP_DIRS) {
  if (existsSync(join(SRC, dir))) {
    // 顶层目录内部也过一遍。过滤的是**名字**，不是路径 ——
    // `setup/_backup_xxx` 那一层的名字就是 `_backup_xxx`。
    // 前缀匹配，不是精确匹配：备份名字带时间戳。
    const skip = new Set([...TOP_SKIP_PREFIX, 'node_modules', '__pycache__']);
    cpSync(join(SRC, dir), join(OUT, dir), {
      recursive: true,
      filter: (source) => {
        const name = basename(source);
        for (const prefix of skip) if (name.startsWith(prefix)) return false;
        return true;
      }
    });
    copied += 1;
    console.log(`  ✓    ${dir}/`);
  }
}

// SHARING.md / SHARING.zh.md / NOTICE.md / NOTICE.zh.md 都由 TOP_FILES 复制过去，
// 不在脚本里生成。第一版是脚本自己写一份 SHARING.md —— 那会把仓库里真正的那份
// 覆盖掉，而且两份内容会各自漂移。现在只有一份真源。

// ---- 把作者的真实路径洗掉 -----------------------------------------------
//
// 源仓库里保留 `<本仓库>` 是有用的 —— 作者要知道东西在哪。导出物不该有：
// 换台机器就失效，而且告诉别人「这是谁的机器、目录怎么排的」。
//
// 放在导出之后、检查之前，所以检查验的是最终形态。
/**
 * ⚠️ 每条路径要配**两套**规则：普通形式，和**源码里的转义形式**。
 *
 * 2026-10-10 发现：有一个脚本里写的是
 *
 *     dir: '<本仓库>',
 *
 * —— 那是 JS 字符串字面量里的转义，**文件里就是两个反斜杠字符**。
 * 而清洗规则写的是 `[A-Z]:[\\/]DSH_Plugins`，只认一个。
 * 于是脚本里那些路径一条都没洗掉，而审计工具报的是「0 处需要处理」。
 *
 * （那个脚本后来去掉了；**这个坑本身还在** —— 任何工具脚本里都可能再出现。）
 *
 * 同一个错误在这个文件里已经出现过四次了 —— `_backup`、`corpus-src`、
 * 大小写的 `LUTISURE`、现在是转义反斜杠。**共同点都是「我以为输入长这样」。**
 * 所以这里不再手写规则，而是从一张路径清单生成两套。
 */
const PATHS = [
  ['新建文件夹\\resources\\app.asar', '<DSH 安装目录>/resources/app.asar'],
  ['新建文件夹', '<DSH 安装目录>'],
  ['DSH_Plugins', '<本仓库>'],
  ['DSH_AI_Learning', '<工作目录>'],
  ['Tools', '<工具目录>']
];
const USER = process.env.USERNAME ?? process.env.USER ?? '';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const SCRUB = [
  // 路径 × 两种反斜杠形式
  ...PATHS.flatMap(([p, to]) => [
    [new RegExp(`[A-Z]:[\\\\/]${esc(p)}`, 'gu'), to],
    // 转义形式：文件里出现的是两个反斜杠
    [new RegExp(`[A-Z]:\\\\\\\\${esc(p)}`, 'gu'), to]
  ]),
  // 用户名：**只在路径里洗**。
  //
  // 大小写三种形态都要洗（以前那条区分大小写，漏掉了 `LUTISURE`）。
  //
  // ## 这条规则收窄过，理由值得记住
  //
  // 原来它按字面全局匹配。撞过五次，每次都是**同一个字符串，两种意思**：
  //
  //   1. `github.com/<用户名>/`        仓库 URL    2026-10-11 洗断，链接全断而报告「干净」
  //   2. `@<用户名>/<包名>`            npm 作用域  2026-10-12 洗成含 `<>` 和中文的**非法包名**，
  //                                                 而且让包名 ≠ 客户端 loader id —— clone 下来装了就崩
  //   3. `"name": "<用户名>"`          author 署名 和 LICENSE 对不上
  //   4. `Copyright (c) 2026 <用户名>` 许可证抬头  同上
  //   5. `name: <用户名>/<仓库>`、`<用户名>__<仓库>.yml`  投稿字段与文件名，CI 报「仓库不存在」
  //
  // 每撞一次就在负向后顾里补一条例外，补到第四条才看明白方向错了：
  // **用户名只在路径里才标识这台机器**，别处它标识的是作者本人 ——
  // 而作者是谁在这份导出物里本来就是公开的，每个 `package.json` 都写着
  // `github.com/Lutisure/`。洗它换不来隐私，只换来一个坏掉的标识。
  //
  // 所以判据从「哪里不洗」翻成「**哪里才洗**」：紧挨着反斜杠的那个才洗。
  // 上面五条身份串一个都不挨着反斜杠，一次全放过，不必再逐条开例外。
  //
  // 代价是「路径外面的用户名一个不洗」，所以下面配了 `IDENTITY_SLOTS` 断言：
  // **占位符绝不许落在身份位置上**，落进去就叫导出失败。
  ...(USER === '' ? [] : [[
    new RegExp(`(?<=[\\\\])${esc(USER)}\\b|\\b${esc(USER)}(?=[\\\\])`, 'giu'),
    '<用户名>'
  ]]),
  [/C:\\Users\\[A-Za-z0-9_.-]+/gu, '%USERPROFILE%'],
  [/[A-Z]:\\\\Users\\\\[A-Za-z0-9_.-]+/gu, '%USERPROFILE%'],

  // ⚠️ **路径的编码形式也要洗。**
  //
  // DSH 把工作目录编码成会话目录名：`<工作目录>` → `<工作目录>`。
  // 上面那几条要求**盘符开头**，所以编码形式一条也匹配不到 ——
  // 于是 `docs/issues/` 的记录里留下了 `<工作目录>`。
  //
  // 它比原路径弱，但仍然告诉别人「这个人的工作目录叫什么、有几个会话」。
  [/--[A-Z]-DSH_AI_Learning--/gu, '<工作目录>'],
  [/--[A-Z]-DSH_Plugins--/gu, '<本仓库>']
];

const { readdirSync, statSync } = await import('node:fs');
const TEXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.json', '.yml', '.yaml', '.md', '.txt', '.ps1', '.cmd', '.bat', '.py']);

/**
 * ⚠️ 读文件前先看 BOM —— **不然 UTF-16 的文件对清洗完全隐形**。
 *
 * 2026-10-10 发现：`eval/samples/drift-report.txt` 和 `probe-report.txt` 是
 * **UTF-16 LE**（前两字节 `FF FE`），而这里原来是 `readFileSync(at, 'utf8')`。
 * UTF-16 的字节读成 UTF-8 就是乱码，上面那条 `C:\Users\<名字>` 一条也匹配不到 ——
 * 于是那份报告带着作者的真实临时路径进了分享副本，**而审计工具报的是「0 处」**。
 *
 * 它没有把文件写坏（内容是乱码、规则匹配不上、`after === before`，于是不写），
 * 但它给了「已经检查过」的错觉。**一个把文件读成乱码的检查器，等于没检查。**
 *
 * 现在按 BOM 解码，并且**统一写回 UTF-8**：分享出去的东西不该混着几种编码。
 */
const readText = (p) => {
  const buf = readFileSync(p);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.toString('utf16le', 2), encoding: 'utf16le' };
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.toString('utf8', 3), encoding: 'utf8bom' };
  }
  return { text: buf.toString('utf8'), encoding: 'utf8' };
};

let scrubbed = 0;
let reencoded = 0;

/**
 * 写回去时要不要带 BOM。
 *
 * ## 这里原来只有一条规则：「统一写回 UTF-8」——而它对 `.ps1` 是错的
 *
 * 2026-10-11 在干净机器上实测：导出物里的 `setup/install.ps1`
 * **在 PowerShell 5.1 下解析失败**（`Unexpected token '}'`）。
 *
 * 原因是两层叠在一起：
 *
 *   1. 源文件是 UTF-8 **带** BOM（`readText` 认出来的 `encoding === 'utf8bom'`）
 *   2. 第 280 行把它当「需要转码」，`writeFileSync(..., 'utf8')` 写回去 —— **BOM 没了**
 *
 * 而 **PowerShell 5.1 读 `.ps1` 时按 ANSI（本机 GBK）解，除非有 BOM**。
 * 无 BOM 的中文被按 GBK 解出半个字节序列，吃掉一个引号或括号，
 * 于是整个脚本起不来。**而 `setup/install.cmd` 调的正是 `powershell`（5.1），不是 `pwsh`。**
 *
 * ## 所以规则按类型分
 *
 *   `.ps1` / `.cmd` / `.bat`  → **带 BOM**。5.1 要有它才认得出这是 UTF-8。
 *   其余（`.js` `.mjs` `.json` `.yml` `.md` …）→ **不带**。
 *     node 读带 BOM 的 `.js` 没问题，但**带 BOM 的 JSON 会被 `JSON.parse` 拒**，
 *     而 `package.json` 正是其中一种。宁可这边保守。
 *
 * @param {string} path - 目标路径。
 * @returns {boolean} 是否要带 BOM。
 */
const wantsBom = (path) => /\.(ps1|cmd|bat)$/iu.test(path);

const writeBack = (at, text) => {
  if (wantsBom(at)) {
    writeFileSync(at, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]));
  } else {
    writeFileSync(at, text, 'utf8');
  }
};

const scrubDir = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const at = join(dir, entry.name);
    if (entry.isDirectory()) { scrubDir(at); continue; }
    if (!TEXT.has(at.slice(at.lastIndexOf('.')))) continue;
    const { text: before, encoding } = readText(at);
    let after = before;
    for (const [pattern, replacement] of SCRUB) after = after.replace(pattern, replacement);
    const wanted = wantsBom(at) ? 'utf8bom' : 'utf8';
    if (after !== before) { writeBack(at, after); scrubbed += 1; }
    else if (encoding !== wanted) { writeBack(at, after); reencoded += 1; }
  }
};
scrubDir(OUT);
console.log(`  ✓    洗掉真实路径 —— ${scrubbed} 个文件${reencoded === 0 ? '' : `，另有 ${reencoded} 个统一了编码`}`);

// ---- 兜底：占位符绝不许落在身份位置上 -----------------------------------
//
// 2026-10-12 撞的就是这个：npm 作用域被洗成 `@<用户名>/dsh-theme-cyrene` ——
// 一个含 `<>` 和中文的**非法包名**，而且让包名 ≠ 客户端 loader id，谁 clone 谁崩。
//
// 上面那条规则已经收窄成「只在路径里洗」，但**收窄本身不该是唯一防线**：
// 规则描述的是意图，这条断言检查的是结果。两者都要有。
//
// 正面表述比反面表述好验：不说「别洗坏身份」，说「身份位置上不许出现占位符」。
const IDENTITY_SLOTS = [
  [/@<用户名>\//u, 'npm 作用域 / 包名'],
  [/"name"\s*:\s*"<用户名>"/u, 'author 署名'],
  [/Copyright \(c\) \d{4} <用户名>/u, '许可证抬头'],
  [/github\.com\/<用户名>/u, '仓库 URL'],
  [/repos\/<用户名>/u, 'gh api 路径'],
  [/name:\s*<用户名>\//u, '投稿的 name 字段'],
  [/<用户名>__/u, '投稿文件名']
];

const slotHits = [];
const walkSlots = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const at = join(dir, entry.name);
    // **`tools/` 不扫。** 检测器必须写出它要检测的那个字面量 —— `audit-shareable.mjs`
    // 和这个文件自己都有 `<用户名>` 的原文，那是规则，不是泄漏。
    //
    // 这一条安全，是因为**身份位置里不可能有工具**：`package.json`、`LICENSE`、
    // `SUBMIT.md` 都在仓库根或包根，没有一个在 `tools/` 下面。
    // （2026-10-12 第一次跑这条断言，7 个命中全是这个文件自己。）
    if (entry.isDirectory()) {
      if (entry.name !== 'tools') walkSlots(at);
      continue;
    }
    if (!TEXT.has(at.slice(at.lastIndexOf('.')))) continue;
    const { text } = readText(at);
    for (const [pattern, what] of IDENTITY_SLOTS) {
      if (pattern.test(text)) slotHits.push(`${at.slice(OUT.length + 1)} — ${what}`);
    }
  }
};
walkSlots(OUT);

if (slotHits.length > 0) {
  console.log(`\n  ✗    占位符落进了 ${slotHits.length} 个身份位置：`);
  for (const hit of slotHits.slice(0, 12)) console.log(`         ${hit}`);
  console.log('         身份位置是给人看的，不是隐私 —— 收窄上一节 `SCRUB` 里那条用户名规则。\n');
  process.exit(1);
}
console.log('  ✓    身份位置上没有占位符');

// ---- 验导出物，不是验源目录 ---------------------------------------------
console.log('\n  对导出物跑一遍分享检查……\n');
let auditFailed = false;
try {
  const out = execFileSync(process.execPath, [join(OUT, 'tools', 'audit-shareable.mjs')], {
    cwd: OUT,
    encoding: 'utf8'
  });
  process.stdout.write(out.replace(/^/gmu, '  '));
} catch (error) {
  auditFailed = true;
  process.stdout.write(String(error.stdout ?? '').replace(/^/gmu, '  '));
}

console.log(
  auditFailed
    ? '\n  ⚠️ 导出物里还有需要处理的东西 —— 见上。\n'
    : '\n  ✓ 导出物干净，可以分享。\n'
);
process.exit(auditFailed ? 1 : 0);
