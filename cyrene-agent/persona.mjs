/**
 * dsh-cyrene-agent/persona — 人设正文（预设级插件）。
 *
 * 人设本来是**内联在补丁的 preset 行里**的一段 3 KB 中文。那意味着改一句话要：
 * 重新构建 → 重写 profile 补丁 → **重启 DSH**。而人设的语气、规则、边界，正是最需要
 * 反复调的东西。所以正文改由这里提供，补丁里只留一个 `{{cyrene_persona}}` 占位符。
 *
 * 为什么这样就能热改：
 *   `dsh-persona` 把 `prefix` 注册成一个 **section**（`text: config.prefix`，静态字符串），
 *   而 `dsh-system-prompt` 在**每次装配时**对 section 做插值
 *   （`sections.map(s => s.interpolate === false ? s.text : interpolate(s, ...))`）。
 *   于是 `{{cyrene_persona}}` 每轮都会调用这里的 provider —— 读的是文件，所以改完下一轮生效。
 *
 * ⚠️ **这个 provider 永远不能返回 `undefined`。**
 * 本机 `dsh-system-prompt` 的实测行为：
 *
 *     throw new Error(`unknown prompt variable "{{${name}}}" ...`)   ← 没注册就抛
 *     if (value === void 0) throw new Error(`prompt variable "{{${name}}}" has no value ...`)
 *
 * 两条都会让**整次装配失败** —— 不是降级，是硬失败，这个预设的每一轮对话都完蛋。
 * 所以最坏情况返回一个短兜底串，绝不返回 `undefined`。
 *
 * 另外补丁里那个占位符和这里的注册必须**同生共死**，`build.test.mjs` 有一条测试盯着。
 */

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';

import { createCachedReader, stderrWriter } from './file-cache.mjs';
import { readCorrectionsBlock } from './corrections.mjs';
import { readMemoryBlock } from './memory.mjs';
import { dataPath, readAlwaysBlock } from './worldbook.mjs';

/**
 * 这个预设读哪一份人设正文。
 *
 * `file` 这一项现在**两个预设都不配** —— 两个都走默认那份完整人格：
 *
 *     （不配）    dist/system-prompt.md   完整人格
 *
 * 而**这个机制还在**：配了 `file` 就读那一份（相对 `dist/`）。原来有三档模式
 * 靠它各读各的提示词，那些在 2026-10-11 去掉了，但读文件这条路留着 ——
 * 以后要再分档，还是这个口子。
 *
 * ⚠️ **配错文件名必须吵，不能安静地退回 Chat。**
 *
 * 这是人家在这里做检查的原因：如果 `file` 指的文件不存在，而这个插件悄悄加载了
 * 默认那份，几档预设会**全跑同一份人格** —— 界面上看着是几个，点进去
 * 一模一样，而且没有任何地方报错。今晚已经撞过三次同类静默失效：
 *
 *   · worldbook 在 `context()` 里做关键词匹配永远匹配不到，整段被丢掉
 *   · dsh-proactive 装到旧版宿主上会被 peer 检查跳过，插件根本不加载
 *   · 严格模式的路径校验写错了 id，只发一条 warn，那行被静默忽略
 *
 * @param {unknown} file - 配置里的文件名（相对 dist/）或 dist/ 内的绝对路径。
 * @returns {{path: string|null, problem: string|null}} 解析出的路径，以及问题。
 */
export function resolvePromptFile(file) {
  const root = dataPath('./dist');
  if (root === null) return { path: null, problem: 'dist/ 的路径解析不出来' };

  // ⚠️ 判断必须用**真实路径**，不能只用字面路径。
  //
  // 2026-10-09 第 7 轮实测：在 `dist/` 里建一个指向仓库根的 junction，然后
  // `file: zz-link/persona-soul.md` —— 字面检查通过（前缀确实是 dist\）、
  // `existsSync` 也通过，于是它**读到了 dist 外面的文件**（15473 字符）。
  //
  // 严重性：能造 junction 的人本来就能直接改人设文件，所以这不是远程漏洞。
  // 但那道守卫宣称「收窄在这一个目录里」，而在这一点上它说了假话 ——
  // 一个说了假话的守卫比没有更糟。
  //
  // 顺带修掉一个不一致：`startsWith` 是大小写敏感的，而 Windows 不是。
  // 于是 `system-prompt.other.md`（文件名）放行、`DIST/system-prompt.other.md`
  // （目录名）被拒 —— 同一个文件两种结果。realpath 会规范化大小写，两边就一致了。
  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    // dist 还不存在（没构建过）。退回字面路径 —— 后面的 existsSync 会拒绝一切。
    realRoot = root;
  }

  const wanted = file === undefined || file === null ? '' : String(file).trim();
  if (wanted === '') return { path: join(realRoot, 'system-prompt.md'), problem: null };

  const candidate = normalize(isAbsolute(wanted) ? wanted : join(realRoot, wanted));

  // 先做字面检查。便宜，而且能把明显的越界挡在文件系统调用之前。
  if (!candidate.startsWith(realRoot + sep)) {
    return { path: null, problem: `file 必须指向 dist/ 里面的文件，收到的是 ${wanted}` };
  }
  if (!existsSync(candidate)) {
    return { path: null, problem: `file 写的是 ${wanted}，但 ${candidate} 不存在` };
  }

  // 再做一次真实路径检查 —— 这一步是拦 junction / 符号链接的。
  let real;
  try {
    real = realpathSync(candidate);
  } catch (error) {
    return { path: null, problem: `file 写的是 ${wanted}，但解析不出它的真实路径：${error.message}` };
  }
  if (!real.startsWith(realRoot + sep)) {
    return { path: null, problem: `file 写的是 ${wanted}，但它经由链接指向了 dist/ 外面（${real}）` };
  }

  return { path: real, problem: null };
}

/** Cordis 服务名。 */
export const inject = ['systemPrompt'];

/**
 * 设定的兜底正文。
 *
 * 只在人设文件从未成功读到时使用。**刻意写成一句话而不是空串**：空串会让
 * `dsh-system-prompt` 把整个 section 丢掉，她就退化成没有任何人设的通用助手，
 * 而那是**静默**的 —— 用户只会觉得「她今天怎么怪怪的」。
 * 一句话兜底至少让身份还在，同时 stderr 上有一条明确的报错。
 */
const FALLBACK = '你是「昔涟」。人设文件没能载入，请提醒使用者检查 cyrene-agent/dist/system-prompt.md。';

/**
 * 造一个读人设正文的 reader。
 *
 * ⚠️ 它同时是**唯一**能把设定和记忆送进模型的地方，所以它返回的不只是正文。
 *
 * 原因在 `SystemPrompt.assemble()` 的最后两行：
 *
 *     sections: completeSection === undefined ? transformed.sections : [completeSection],
 *     contexts: runtimeContextSuppressed ? [] : transformed.contexts
 *
 * 本预设同时开了 `complete: true`（替换掉所有其它 section）和
 * `includeRuntimeContext: false`（清空整个 context 通道），于是**提示词注册表里
 * 除正文之外任何东西都进不去**。四块内容因此都拼在这里：
 *
 *     正文 → 修正 → 常驻设定 → 长期记忆
 *
 * 修正在正文之后，因为它改的就是正文描述的说话方式，两段挨着读才成立。
 * 记忆在最后，因为它变得最勤 —— 每次 `remember` 都会让提示词尾部变一次，
 * 前缀缓存不受影响。
 *
 * 而**命中块**不受影响 —— 它走 `agent/pre-step`，根本不属于提示词注册表。
 *
 * @param {string|null} [file] - 覆盖路径；测试用。
 * @param {(message: string) => void} [warn] - 诊断输出。
 * @returns {() => string} 永远返回字符串的 reader。
 */
export function createPersonaReader(
  file = null,
  warn = stderrWriter('dsh-cyrene-agent/persona'),
  bodyText = null
) {
  // bodyText 不为 null 时**不读任何文件**。配错 file 的时候用它把一段写明问题的
  // 正文顶上去 —— 那种情况下读默认文件正是要避免的事（四个预设会长得一模一样）。
  const readBody = bodyText !== null ? () => bodyText : createCachedReader(
    file ?? dataPath('./dist/system-prompt.md'),
    (text) => {
      const body = text.trim();
      // 一个空的或只剩空白的人设文件等同于没有。当作读取失败处理，走兜底 ——
      // 但不要缓存它，否则修好文件后这一轮之前都不会重读。
      if (body === '') throw new Error('人设文件是空的');
      return body;
    },
    { label: '人设', warn }
  );

  return () => {
    const body = readBody();
    const base = typeof body === 'string' && body !== '' ? body : FALLBACK;
    const parts = [base.trimEnd()];
    // Every block is re-read per assembly, so an edit to the lore, a `correct`, or
    // a `remember` shows up on the very next turn without a restart.
    //
    // Corrections sit immediately after the body because they amend the speaking
    // style the body describes; lore and memory are content and follow.
    for (const block of [readCorrectionsBlock(), readAlwaysBlock(), readMemoryBlock()]) {
      if (typeof block === 'string' && block.trim() !== '') parts.push(block.trim());
    }
    return parts.join('\n\n');
  };
}

/**
 * 挂载人设。
 * @param {object} ctx - 预设级 Cordis 上下文。
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const { path, problem } = resolvePromptFile(config?.file);
  if (problem !== null) {
    // 吵，而且不读任何文件。
    process.stderr.write(`[dsh-cyrene-agent/persona] ${problem}\n`);
  }
  const readPersona = problem === null
    ? createPersonaReader(path)
    : createPersonaReader(null, undefined, `你是「昔涟」，但这个会话的模式提示词没有载入：${problem}。请提醒使用者检查 profile 补丁里 cyrene-agent/persona 的 file 配置。`);
  // 每轮现取：补丁里的 {{cyrene_persona}} 由 dsh-persona 的 section 在装配时插值。
  ctx.systemPrompt.variable('cyrene_persona', () => readPersona());

  // ⚠️ 这里绝对不能 ctx.provide()：预设作用域里发布服务会让整个预设挂载失败。
}
