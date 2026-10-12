/**
 * 幻觉包检查 —— 从代码里找出包名，看它们是不是编出来的。
 *
 * 这是 DeepSec 里最有价值、也最难替代的一件：向量嵌入做不到、正则也做不到，它需要
 * 一张「真实存在」的名单加上一个存在性查询。原版只在 TypeScript 侧实现，Python 侧
 * 的 `HALLUCINATED_PACKAGE` 只是个没人用的枚举值。
 *
 * ## 「不知道」不等于「不存在」
 *
 * 这是整个检查里最要紧的一条，原版为此写了一行关键代码和一条测试：
 *
 *   > if (data.packages.has(name)) return true;
 *   > return data.coverage === "full" ? false : undefined;
 *
 * 只有覆盖完整的索引才允许判定「不存在」；不完整时返回 `undefined`，也就是**不知道**。
 * 同样的道理也适用于网络：**404 才是「不存在」，429 和 5xx 是「没查成」**。原版的注释
 * 写着，把瞬时网络失败写进缓存「would suppress verification after connectivity recovers」
 * —— 一次断网就能让某个包在 24 小时里被错误地记成不存在。
 *
 * 所以这里的返回有三个值，不是一个：
 *
 *   'exists'     查到了
 *   'missing'    确定不存在
 *   'unknown'    没查到 / 没查
 *
 * 只有前两个能变成发现。把 'unknown' 当成 'missing'，规则就变成一台误报机器。
 */

import { HALLUCINATED, KNOWN, REGISTRY_URLS, escapeGoModulePath, normaliseName } from './packages.mjs';

/** 查询超时。原版是 3000 ms。 */
const TIMEOUT_MS = 3000;

/** 未验证结果**不**进缓存 —— 这正是原版那行注释的意思。 */
const cache = new Map();

/**
 * 从源码里找出被引用的包名。
 *
 * 只认 import / require / 清单文件，不去猜别的东西。原版为此写了两个状态机把注释和
 * 字符串标出来，理由是不遮的话注释里写一句 `import "foo"` 就会误报。
 *
 * @param {string} text - 源码或清单文件内容。
 * @param {string} path - 文件路径，用来决定怎么解析。
 * @param {Set<string>} langs - 语言集合。
 * @param {string} masked - 已经遮掉注释与字符串的同一份文本。
 * @returns {Array<{name: string, registry: string}>} 候选包名。
 */
export function packagesIn(text, path, langs, masked) {
  const source = String(text ?? '');
  const base = String(path ?? '').split(/[\\/]/u).pop() ?? '';
  const out = [];
  const push = (name, registry) => {
    const clean = String(name ?? '').trim();
    if (clean === '' || clean.startsWith('.') || clean.startsWith('/') || clean.startsWith('#')) return;
    if (clean.startsWith('node:') || clean.startsWith('@/')) return;
    out.push({ name: clean, registry });
  };

  // package.json —— 跟着 JSON 走，不接受注释，所以不需要遮罩。
  if (base === 'package.json') {
    try {
      const json = JSON.parse(source);
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const name of Object.keys(json[field] ?? {})) push(name, 'npm');
      }
    } catch {
      // 读不动就当没有。一个坏掉的 package.json 不是安全发现。
    }
    return out;
  }

  // requirements.txt —— 每行一个，去掉版本约束和选项。
  if (/^requirements.*\.txt$/u.test(base) || base === 'constraints.txt') {
    for (const line of source.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
      push(trimmed.split(/[<>=!~[;\s]/u)[0], 'pypi');
    }
    return out;
  }

  // pyproject.toml —— 只在依赖段里找引号包起来的名字。
  if (base === 'pyproject.toml') {
    for (const m of source.matchAll(/^\s*"?([A-Za-z][\w.-]*)"?\s*[<>=!~]/gmu)) push(m[1], 'pypi');
    return out;
  }

  // 源码 import。跑在遮罩上，所以注释里的示例不算。
  if ([...langs].some((l) => ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx'].includes(l))) {
    for (const m of masked.matchAll(/(?:import\s[^'"`]*?from\s*|require\s*\(\s*|import\s*\(\s*)['"`]([^'"`]+)['"`]/gu)) {
      const spec = m[1];
      if (spec.startsWith('.')) continue;
      // scoped 包取两段，其余取第一段。
      const parts = spec.split('/');
      push(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0], 'npm');
    }
    return out;
  }

  if ([...langs].some((l) => l === 'py')) {
    // `[\w., \t]` and not `[\w.,\s]`: `\s` matches newlines, so an `import a` with
    // nothing after it swallowed the following lines and reported them as part of the
    // module name. Spaces and tabs are the only separators that belong here.
    for (const m of masked.matchAll(/^[ \t]*(?:from[ \t]+([\w.]+)[ \t]+import|import[ \t]+([\w., \t]+))/gmu)) {
      const list = (m[1] ?? m[2] ?? '').split(',');
      for (const raw of list) {
        const name = raw.trim().split(/\s+as\s+/u)[0].split('.')[0];
        if (name !== '') push(name, 'pypi');
      }
    }
  }
  return out;
}

/**
 * 查一个包在它那个 registry 里存不存在。
 *
 * 只有明确的 404 才算「不存在」。其余任何非 2xx —— 429、5xx、超时、DNS 失败 ——
 * 都是「没查成」，返回 `unknown` 并且**不写缓存**。
 *
 * @param {string} name - 包名。
 * @param {string} registry - registry 名。
 * @param {typeof fetch} [fetchImpl] - 便于测试注入。
 * @returns {Promise<'exists'|'missing'|'unknown'>} 三态结果。
 */
export async function verifyPackage(name, registry, fetchImpl = fetch) {
  const template = REGISTRY_URLS[registry];
  if (template === undefined) return 'unknown';

  const normalised = normaliseName(name, registry);
  const key = `${registry}:${normalised}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const url = registry === 'gomod'
    ? template.replace('{name}', escapeGoModulePath(normalised))
    : template.replace('{name}', encodeURIComponent(normalised));

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'cyrene-guard/0.1' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch {
    // 网络问题不是「包不存在」。不缓存，下次还能重试。
    return 'unknown';
  }

  if (response.status === 404) {
    cache.set(key, 'missing');
    return 'missing';
  }
  if (!response.ok) return 'unknown';

  // maven 返回 200 但可能一个都没匹配上，得看 body。
  if (registry === 'maven') {
    try {
      const json = await response.json();
      const found = Number(json?.response?.numFound ?? 0);
      const verdict = found > 0 ? 'exists' : 'missing';
      cache.set(key, verdict);
      return verdict;
    } catch {
      return 'unknown';
    }
  }

  cache.set(key, 'exists');
  return 'exists';
}

/**
 * 用种子表离线判一次。
 *
 * 两张表回答两个不同的问题，表外一律是 `unknown` —— **不是 `missing`**。
 *
 * @param {string} name - 包名。
 * @param {string} registry - registry 名。
 * @returns {{verdict: 'exists'|'missing'|'unknown', replacements?: string[]}} 结论。
 */
export function seedLookup(name, registry) {
  const normalised = normaliseName(name, registry);
  const known = KNOWN[registry] ?? [];
  if (known.some((k) => normaliseName(k, registry) === normalised)) return { verdict: 'exists' };

  const fake = (HALLUCINATED[registry] ?? []).find((h) => normaliseName(h.name, registry) === normalised);
  if (fake !== undefined) return { verdict: 'missing', replacements: fake.replacements };

  return { verdict: 'unknown' };
}

/** 清空缓存。测试用。 */
export function clearPackageCache() {
  cache.clear();
}
