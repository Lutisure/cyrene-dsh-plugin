/**
 * cyrene-guard — 本地安全扫描插件（宿主侧）
 *
 * 规则来自 `Unclecheng-li/DeepSec` 的 Shield（MIT），引擎在 `scanner.mjs`。
 *
 * ## 挂在哪、为什么
 *
 * `dsh-tool-fs` 的写入路径是：
 *
 *     const intent = await ctx.waterfall("fs/write-intent", target, exec, …);
 *     outcome = await ctx.fs.writeText(target, input.content, intent, …);
 *     ctx.emit("fs/observed", target, { kind: "present", version: outcome.version }, exec);
 *
 * `fs/write-intent` 是 waterfall，看上去适合拦 —— 但它**只拿到 (target, exec)**，
 * 拿不到要写的内容。写之前检查内容这条路走不通。
 *
 * `fs/observed` 在写完之后触发，那时可以解析目标、读回内容、扫描。**所以这一层
 * 是事后检，不是事前拦。** 说清楚比假装是闸门好：它能让错误在同一轮就被看见并
 * 改掉，但它拦不住任何东西。
 *
 * ## 为什么挂在预设外面
 *
 * 记忆那几个插件挂在 `preset-cyrene` 里面，因为它们的提示词要跟着人设走。这个
 * 插件的目的正相反 —— **不管挂哪个预设、开哪个会话，它都该在**。所以它挂在这一层，
 * 用 `context()` 直接进系统提示。
 *
 * ## 这个文件不是安全边界
 *
 * 见 `scanner.mjs` 顶部。真正的边界是权限范围和人工确认。
 */

import { existsSync, readFileSync } from 'node:fs';

import { packagesIn, seedLookup } from './packages-scan.mjs';
import { languagesOf, maskCommentsAndStrings, scanText } from './scanner.mjs';

export const name = 'cyrene-guard';

/** `tools` 是可选的：没有工具服务时仍然扫描，只是没有手动入口。 */
export const inject = ['fs', 'systemPrompt'];

/** 单次扫描读入的上限，超过就不读。源码文件不会到这个量级。 */
const MAX_SCAN_BYTES = 512 * 1024;

/** 扫描记录保留的条数。一轮会话里写的文件是有限的。 */
const MAX_RECORDS = 40;

/** 报告里最多列几条发现。防止一次报几十条把上下文挤掉。 */
const MAX_REPORTED = 12;

/**
 * 只扫这些后缀。刻意不含 `.md` —— 结构说明和文档里的示例代码会被规则误伤，
 * 而那不是需要修的东西。（DeepSec 的扫描后缀表里也没有 `.md`，同样的理由。）
 */
const SCANNABLE = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'kt', 'kts',
  'go', 'rb', 'php', 'cs', 'rs', 'yml', 'yaml', 'json', 'toml', 'env', 'sh', 'ps1',
  // requirements.txt is where a hallucinated pypi name lands, so it has to get past
  // this filter for the manifest check to ever run.
  'txt'
]);

/**
 * 依赖清单。幻觉包只会出现在这些文件里 —— 源码里的 import 是「用了什么」，
 * 清单才是「要装什么」，而装下去才会执行。
 */
const MANIFEST = /(?:^|[\\/])(?:package\.json|package-lock\.json|requirements[^\\/]*\.txt|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml)$/u;

/**
 * 这个路径该不该扫。
 * @param {string} path - 展示路径。
 * @returns {boolean} 该扫则为 true。
 */
function worthScanning(path) {
  const text = String(path ?? '');
  if (text === '') return false;
  // 依赖目录和产物不扫：它们不是这个人写的，报出来也没法改。
  // The separator is optional on the left: a path can begin with the directory.
  if (/(?:^|[\\/])(?:node_modules|\.git|dist|build|out|coverage|\.venv|venv|__pycache__)[\\/]/u.test(text)) return false;
  const ext = /\.([A-Za-z0-9]+)$/u.exec(text)?.[1]?.toLowerCase();
  return ext !== undefined && SCANNABLE.has(ext);
}

/**
 * 扫描结果缓存：展示路径 → 该文件当前的发现。
 *
 * 以路径为键而不是追加，因为同一个人反复改同一个文件时，关心的是它**现在**怎么样，
 * 不是它历史上错过几次。写一次覆盖一次。
 */
class Ledger {
  #records = new Map();

  /**
   * 记一次扫描。
   * @param {string} path - 展示路径。
   * @param {import('./scanner.mjs').Finding[]} findings - 发现。
   */
  record(path, findings) {
    // Map 保持插入顺序，删了再插就是「最近写的排在最后」。
    this.#records.delete(path);
    this.#records.set(path, { findings, at: Date.now() });
    while (this.#records.size > MAX_RECORDS) {
      const oldest = this.#records.keys().next().value;
      this.#records.delete(oldest);
    }
  }

  /** 清空。 */
  clear() {
    this.#records.clear();
  }

  /**
   * 渲染成给模型看的块，没有发现时返回空串。
   * @returns {string} 报告。
   */
  render() {
    const dirty = [...this.#records.entries()].filter(([, r]) => r.findings.length > 0);
    if (dirty.length === 0) return '';

    const total = dirty.reduce((sum, [, r]) => sum + r.findings.length, 0);
    const out = [
      '【安全扫描 —— 你刚写下的文件里有这些，请自己看一眼再往下走】',
      ''
    ];

    let shown = 0;
    for (const [path, record] of dirty) {
      if (shown >= MAX_REPORTED) break;
      out.push(`${path}`);
      for (const f of record.findings) {
        if (shown >= MAX_REPORTED) break;
        out.push(`  · 第 ${f.line} 行「${f.evidence}」— ${f.message}`);
        out.push(`    ${f.suggestion}`);
        shown += 1;
      }
    }
    if (total > shown) out.push(`（另外还有 ${total - shown} 条没有列出来。）`);
    out.push('');
    out.push(
      '这是本地正则扫描，**不是安全边界**：它按公开样本里的写法匹配，换个说法就漏，' +
        '也分不出这段代码到底会不会被跑到。判断权在你。'
    );
    return out.join('\n');
  }
}

/**
 * 挂载。
 * @param {any} ctx - 插件上下文。
 */
export function apply(ctx) {
  const ledger = new Ledger();
  ctx.effect(() => () => ledger.clear(), 'cyrene-guard ledger teardown');

  /**
   * 「我试了，但没扫成」的文件。
   *
   * ## 为什么要有它
   *
   * 原来这四处都是**安静 `return`**：文件太大、读回来不是文本、读的时候抛了 ——
   * 一律不留痕。于是报告看起来是「扫过了，没问题」，**而实际是「有几个没扫」**。
   *
   * 这条不是新发现，是 README 的 `Known Limitations` 自己写着的最后一条：
   *
   *   > 上限之外没有兜底：路径不在白名单、文件超 512 KB、目标读不回来 ——
   *   > 都是**安静跳过**，不会有「我没能扫这个文件」的记录。
   *
   * **它合到这个项目自己的价值观上**：这个包存在的理由是「写完之后看一眼」，
   * 而「看没看成」和「看成了没发现问题」是两件事 —— 混在一起就会让人误以为覆盖完整。
   *
   * ## 不记哪一种
   *
   * **不记「不在白名单」那种。** 跳过 `node_modules`、构建产物是**设计如此**，
   * 每一轮都报一遍就是噪音，而且会把真正该看的挤掉。
   * **该报的是「我以为该扫、但没扫成」。**
   */
  const skips = [];

  /** 最多记这么多条 —— 和 ledger 同一个思路：超出以计数收尾。 */
  const MAX_SKIPS = 20;

  const noteSkip = (path, why) => {
    if (skips.length < MAX_SKIPS) skips.push({ path, why });
    else if (skips.length === MAX_SKIPS) skips.push({ path: '', why: '' });
  };

  /**
   * 读回一个刚被写过的目标并扫描。
   * @param {any} target - fs 目标。
   */
  const scanTarget = async (target) => {
    const path = String(target?.displayPath ?? '');
    if (!worthScanning(path)) return;
    try {
      if (!existsSync(path)) return;
      const info = await ctx.fs.stat(target);
      if (info !== undefined && Number(info.size ?? 0) > MAX_SCAN_BYTES) {
        noteSkip(path, `超过 ${Math.round(MAX_SCAN_BYTES / 1024)} KB`);
        return;
      }
      const text = await ctx.fs.readText(target);
      const body = typeof text === 'string' ? text : text?.text;
      if (typeof body !== 'string') {
        noteSkip(path, '读回来不是文本');
        return;
      }

      /** @type {import('./scanner.mjs').Finding[]} */
      const findings = [];

      // 幻觉包检查是离线的那一半。
      //
      // 种子表之外的名字一律是「不知道」，**不是「不存在」** —— 只有表里明确记着是
      // 编出来的那些才会变成发现。这一点不守住，一次断网或者一个新包就会让整个依赖
      // 清单报成幻觉包，而误报的规则会被关掉，关掉之后它一条都拦不住。
      //
      // 联网查询刻意不在这里做：写文件是高频动作，不该顺带发起网络请求。
      if (MANIFEST.test(path)) {
        // 包名住在字符串里，所以用只遮注释的那一层，不能用全遮罩。
        const langs = languagesOf(path);
        const masked = maskCommentsAndStrings(body, langs, { strings: false });
        const lines = body.split('\n');
        for (const pkg of packagesIn(body, path, langs, masked)) {
          const verdict = seedLookup(pkg.name, pkg.registry);
          if (verdict.verdict !== 'missing') continue;
          findings.push({
            rule: `hallucinated_package_${pkg.registry}`,
            severity: 'critical',
            line: lines.findIndex((line) => line.includes(pkg.name)) + 1,
            message: `「${pkg.name}」这个包是编出来的，${pkg.registry} 里没有。`,
            evidence: pkg.name,
            suggestion:
              '这可能是 slopsquatting：AI 写的代码经常编出看起来合理的包名，而攻击者' +
              '正好可以注册它。' +
              (verdict.replacements.length > 0 ? `多半想要的是 ${verdict.replacements.join(' 或 ')}。` : '') +
              '装之前先确认一下。'
          });
        }
      }

      // 一次记完，不要记两次 —— record 是覆盖语义，第二次会把上面那些冲掉。
      ledger.record(path, [...findings, ...scanText(body, path)]);
    } catch (error) {
      // 读不回来不是错误：文件可能已经被删了，或者这个后端不支持读。
      // 扫描器出问题绝不该影响正常的写文件流程。
      //
      // ⚠️ **但「没扫成」要留痕** —— 见 `skips` 的说明。抛异常也不改变流程，
      // 只是多记一条：报告上会写清「这个文件没扫」，而不是让它看起来扫过了。
      noteSkip(path, `读取时出错（${String(error?.message ?? error).slice(0, 40)}）`);
    }
  };

  // 写完 / 编辑完就看一眼。这是「每一次都跑」的落点。
  ctx.on('fs/observed', (target) => {
    void scanTarget(target);
  });

  /**
   * 把「没扫成的」渲染成一行。
   *
   * 措辞上刻意和「扫过、没问题」分开 —— **这两件事被混起来才是真正的危险**：
   * 报告上什么都没有，读的人会当成覆盖完整。
   *
   * @returns {string} 一行说明；没有跳过时为空白。
   */
  const renderSkips = () => {
    if (skips.length === 0) return '';
    const shown = skips.filter((s) => s.path !== '');
    const over = skips.length > shown.length;
    const lines = shown.map((s) => `- ${s.path} —— ${s.why}`);
    return [
      '【有文件没能扫到 —— 不代表它们是干净的】',
      ...lines,
      over ? '- （另外还有几个没列出来。）' : '',
      '【以上未扫】'
    ].filter((l) => l !== '').join('\n');
  };

  // 给模型看的那一块。
  //
  // 用 `section` 而不是 `context`：`context()` 是追加型，内容一变就插一条新的、
  // 旧的不会消失 —— 而这份报告每写一个文件就变一次，用它会堆出一串过期版本。
  // `section` 同名即替换（源码注释：「section shadows a global section with the
  // same name」），注册一次、`text` 每次装配时求值，永远只有一块。
  //
  // `order` 必须是自己给的数：`getSectionOrder(name)` 只认内核注册过的名字，
  // 给不认识的名字返回 undefined，而 `section()` 见到非有限数会直接抛。
  // 9500 落在工具说明之后、STRUCTURED_OUTPUT（9900）之前 —— 报的是她刚做的事，
  // 放在她准备继续做事的位置。
  ctx.systemPrompt.section({
    name: 'cyrene-guard/scan',
    order: 9500,
    text: () => {
      const report = ledger.render();
      const skipped = renderSkips();
      if (skipped === '') return report;
      return report === '' ? skipped : `${report}\n\n${skipped}`;
    }
  });
}

export { worthScanning, Ledger };
