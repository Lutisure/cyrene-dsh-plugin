/**
 * L0 · 材料。
 *
 * 扫**源文件本身**，不扫她的输出：混合行尾、她自己不该用的写法。
 * 这一层管的是写她材料的那个，不是她。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import zlib from 'node:zlib';
import { scanEntries, describeFindings } from '../worldbook-injection.mjs';
import {
  ROOT, REPO_ROOT, yaml, PATCH_SCHEMA,
  buildWorldbook, explainEntries, createInjectionLog, DEFAULT_LIMIT, DEFAULT_BUDGET,
  readSession, newestSession
} from './shared.mjs';

/**
 * @param {{record: Function, argv: string[]}} ctx
 */
export function runL0(ctx) {
  const { record, argv } = ctx;

// ── L0 材料 ─────────────────────────────────────────────────────────────
//
// 扫**源文件本身**，不扫她的输出。
//
// 为什么需要这一层：文风规则一直只管她，不管写她材料的那个。而后者写的东西
// 会渗进世界书、soul、语料、文档 —— 2026-10-09 就渗进了 docs/README.md（12 处），
// 而工具当时明明报过这个模式，被一句「工程模式本来就该用」解释掉了。
//
// 跟「原话是」那一条是同一件事：**世界书怎么写她就怎么说**，
// 反过来也成立 —— **写材料的人怎么写，她也怎么说**。

if (argv.includes('--sources')) {
  // 行尾：一个文件里不许混着两种。
  //
  // 2026-10-09 第 4-5 轮：一个「改九个条目触发词」的小脚本**悄悄把九行从 CRLF
  // 改成了 LF**，而且没有任何东西发现 —— 直到下一轮去数行尾才看出来
  // （CRLF 从 880 降到 871，正好等于改过的条目数）。
  //
  // 这里不规定该用哪种行尾，只要求别混。理由：这个仓库是备份，工作区就是正在
  // 运行的那份插件（.gitattributes 里是 `* -text`），工具没有立场去改整体风格，
  // 它只该不要在编辑的时候顺手改掉。
  {
    const packages = ['cyrene-agent', 'cyrene-guard', 'dsh-theme-cyrene'];
    const repoRoot = `${ROOT}/..`;
    const textExtensions = new Set(['.mjs', '.js', '.json', '.yaml', '.yml', '.md', '.txt', '.css', '.ts', '.html']);
    const skipDirs = new Set(['node_modules', '.git', 'dist', 'GIF', 'assets', 'music', 'brand', '.data', 'deploy']);
    const mixed = [];
    let scanned = 0;
    const walk = (dir) => {
      let items;
      try { items = readdirSync(dir); } catch { return; }
      for (const item of items) {
        if (skipDirs.has(item)) continue;
        const full = `${dir}/${item}`;
        let info;
        try { info = statSync(full); } catch { continue; }
        if (info.isDirectory()) { walk(full); continue; }
        if (!textExtensions.has(item.slice(item.lastIndexOf('.'))) || info.size > 4e6) continue;
        const body = readFileSync(full, 'utf8');
        const crlf = (body.match(/\r\n/g) ?? []).length;
        const lf = (body.match(/(?<!\r)\n/g) ?? []).length;
        if (crlf === 0 && lf === 0) continue;
        scanned += 1;
        if (crlf > 0 && lf > 0) mixed.push(`${full.slice(repoRoot.length + 1)}（CRLF ${crlf} / LF ${lf}）`);
      }
    };
    for (const pkg of packages) walk(`${repoRoot}/${pkg}`);
    record('L0', '文本文件里没有混合行尾', mixed.length === 0,
      mixed.length ? `${mixed.length} 个：${mixed.slice(0, 3).join('；')}` : `${scanned} 个文件，行尾各自一致`);
  }

  const SOURCE_FILES = [
    'persona-soul.md',
    'worldbook/entries.yaml',
    'corpus/line-samples.yaml',
    'docs/README.md',
    'docs/STORY-EXTRACTION.md'
  ];
  const style = yaml.load(readFileSync(`${ROOT}/eval/style.yaml`, 'utf8'));
  const found = [];
  for (const relative of SOURCE_FILES) {
    const full = `${ROOT}/${relative}`;
    if (!existsSync(full)) continue;
    const body = readFileSync(full, 'utf8');
    for (const rule of style) {
      // 只有标了 sources: true 的规则也约束写材料的人。
      // 输出规则不全都适用：条文要引用被禁的模式，世界书要逐字引游戏原文。
      if (rule.sources !== true) continue;
      for (const pattern of (rule.forbid ?? [])) {
        const hit = new RegExp(pattern, 'gm').exec(body);
        if (hit) found.push(`${relative}  「${hit[0].slice(0, 20)}」  来自规则：${rule.name}`);
      }
    }
  }
  record('L0', '源文件里没有她自己不该用的写法', found.length === 0,
    found.length === 0 ? `${SOURCE_FILES.length} 个文件干净` : `${found.length} 处：${found.slice(0, 3).join('；')}${found.length > 3 ? ' …' : ''}`);
}
}
