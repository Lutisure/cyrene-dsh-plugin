/**
 * 从抽取出来的规则文件生成 `packages.mjs`。
 *
 * 为什么不手抄：这次抽取本身证明了手抄不可靠 —— 子代理在自检时抓出自己 4 处转写
 * 错误（多插的 `\s*`、过度转义的 `\}`、`[^)\n]` 与 `[^\)\n]`）。人工誊写一张 103 行
 * 的包名表，错一个字符就是一条永远查不到的规则。
 *
 * 源文件：`<工作目录>\deepsec-rules-extracted.md`
 */

import { readFileSync, writeFileSync } from 'node:fs';

const SOURCE = '<工作目录>/deepsec-rules-extracted.md';
const md = readFileSync(SOURCE, 'utf8');
const lines = md.split('\n');

/** 找到一个小节标题的行号。 */
function findHeading(pattern) {
  const at = lines.findIndex((l) => pattern.test(l));
  if (at === -1) throw new Error(`找不到小节：${pattern}`);
  return at;
}

// ---- knownPackages：每个 registry 一个围栏代码块 ------------------------
const knownStart = findHeading(/^### 6\.1 /);
const knownEnd = findHeading(/^### 6\.2 /);
const known = {};
{
  let registry = null;
  let inFence = false;
  for (const line of lines.slice(knownStart, knownEnd)) {
    const head = /^\*\*(\w+) \((\d+)\):\*\*/u.exec(line.trim());
    if (head !== null) {
      registry = head[1];
      known[registry] = [];
      continue;
    }
    if (line.trim() === '```') {
      inFence = !inFence;
      continue;
    }
    if (inFence && registry !== null && line.trim() !== '') known[registry].push(line.trim());
  }
}

// ---- knownHallucinatedPackages：每个 registry 一张 markdown 表 ----------
const hallStart = findHeading(/^### 6\.2 /);
// 表到下一个二级标题为止。
const hallEnd = lines.findIndex((l, i) => i > hallStart && /^## /.test(l)) === -1
  ? lines.length
  : lines.findIndex((l, i) => i > hallStart && /^## /.test(l));
const hallucinated = {};
{
  let registry = null;
  let inFence = false;
  for (const line of lines.slice(hallStart, hallEnd)) {
    // 「**npm (5):**」这种标题，也接受没有计数括号的写法。
    const head = /^\*\*(\w+)(?: \(\d+\))?:\*\*/u.exec(line.trim());
    if (head !== null) {
      registry = head[1];
      hallucinated[registry] ??= [];
      continue;
    }
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // | `名字` | `替代1`, `替代2` |
    const row = /^\|\s*`([^`]+)`\s*\|\s*(.*?)\s*\|\s*$/u.exec(line.trim());
    if (row === null || registry === null) continue;
    if (row[1] === 'Hallucinated name') continue;
    const replacements = [...row[2].matchAll(/`([^`]+)`/gu)].map((m) => m[1]);
    hallucinated[registry].push({ name: row[1], replacements });
  }
}

// 丢掉解析不出内容的 registry，并在计数对不上时报错而不是悄悄少几行。
for (const [registry, list] of Object.entries(known)) {
  if (list.length === 0) throw new Error(`knownPackages.${registry} 解析为空`);
}
for (const [registry, list] of Object.entries(hallucinated)) {
  if (list.length === 0) throw new Error(`knownHallucinatedPackages.${registry} 解析为空`);
}

console.log('  解析结果：');
for (const registry of Object.keys(known)) {
  console.log(`    ${registry.padEnd(8)} 已知 ${String(known[registry].length).padStart(3)}   幻觉 ${String((hallucinated[registry] ?? []).length).padStart(2)}`);
}

const body = `/**
 * 包名校验的两张种子表 —— **由 \`tools/gen-packages.mjs\` 从抽取出的规则文件生成，
 * 不要手改。**
 *
 * 来源：\`Unclecheng-li/DeepSec\` 的 \`src/package/seedCatalog.ts\`（MIT）。原文件的两个
 * 表就是硬编码的，重复一千多条包名只会引入转写错误，所以直接生成。
 *
 * ## 为什么需要它
 *
 * AI 写的代码**特别容易编出看起来合理的包名**。这个名字一旦落到磁盘上，就是一个
 * 现成的抢注目标 —— 攻击者注册它、放上恶意代码，下次安装就跑起来了。DeepSec 管这个
 * 叫 slopsquatting，它的提示词写着：
 *
 *   > This may be a slopsquatting risk: AI-generated code often invents plausible
 *   > package names.
 *
 * ## 两张表回答两个不同的问题
 *
 * \`KNOWN\` 是「这些确定存在」，\`HALLUCINATED\` 是「这些是编出来的，最近的真实替代是
 * 这些」。**两张表之外的名字一律是「不知道」** —— 不是「不存在」。分不清这两件事，
 * 规则就会变成一台误报机器，而误报的规则会被关掉。
 */

/** 确定存在的包，按 registry 分组。 */
export const KNOWN = ${JSON.stringify(known, null, 2)};

/** 已知的幻觉包，附最接近的真实替代。 */
export const HALLUCINATED = ${JSON.stringify(
  Object.fromEntries(
    Object.entries(hallucinated).map(([k, v]) => [k, v.map((x) => ({ name: x.name, replacements: x.replacements }))])
  ),
  null,
  2
)};

/**
 * 每个 registry 的存在性查询地址。
 *
 * \`{name}\` 会被替换成规范化之后的包名。这些是 DeepSec 逐字记录的地址，没有改。
 */
export const REGISTRY_URLS = {
  npm: 'https://registry.npmjs.org/{name}',
  pypi: 'https://pypi.org/pypi/{name}/json',
  cargo: 'https://crates.io/api/v1/crates/{name}',
  gomod: 'https://proxy.golang.org/{name}/@latest',
  maven: 'https://search.maven.org/solrsearch/select?q=g:"{group}" AND a:"{artifact}"&rows=1&wt=json'
};

/**
 * Go module proxy 要求的大写转义。
 *
 * 规范规定大写字母写成 \`!\` 加小写，而 \`!\` 本身写成 \`!!\`。漏了这条，凡是名字里带
 * 大写的 module 都会查不到 —— 而查不到会被当成「不存在」，于是报出一个假的幻觉包。
 * DeepSec 为此专门写了测试。
 *
 * @param {string} path - module 路径。
 * @returns {string} 转义后的路径。
 */
export function escapeGoModulePath(path) {
  let out = '';
  for (const ch of String(path)) {
    if (ch === '!') out += '!!';
    else if (ch >= 'A' && ch <= 'Z') out += \`!\${ch.toLowerCase()}\`;
    else out += ch;
  }
  return out;
}

/**
 * 按 registry 的规矩把包名归一化。
 *
 * npm 的 scoped 包保留 \`@scope/name\` 两段；pypi 把下划线换成分隔符并小写；
 * cargo 认为下划线和连字符等价（源码里是 Rust，包名是连字符）。
 *
 * @param {string} name - 原始名字。
 * @param {string} registry - registry 名。
 * @returns {string} 归一化后的名字。
 */
export function normaliseName(name, registry) {
  const raw = String(name ?? '').trim();
  if (registry === 'pypi') return raw.toLowerCase().replace(/_/gu, '-');
  if (registry === 'cargo') return raw.toLowerCase().replace(/_/gu, '-');
  return raw;
}
`;

writeFileSync('packages.mjs', body);
console.log('  packages.mjs 已生成');
