/**
 * dsh-cyrene-agent/worldbook — 设定库注入（预设级插件）。
 *
 * 这是整个包里唯一碰 DSH API 的文件；匹配逻辑在 `worldbook-logic.mjs`，是纯函数。
 * 分开是因为**坑都在匹配规则里**，而那一层不开会话、不启模型就能测个透。
 *
 * 两条注入通道，区别只有一个：**要不要读本轮用户消息**。
 *
 *   常驻块 → `ctx.systemPrompt.context()`
 *     稳定，不依赖用户说了什么，所以装配期求值没问题。它全程在场，重复不额外花钱。
 *
 *   命中块 → `agent/pre-step`
 *     **不能走 context()**。装配跑在用户消息落库之前
 *     （dsh-agent-loop: assemble() 在 session.append("user/message") 之前），
 *     那里做关键词匹配读到的会话里**还没有本轮的问题**；而 context() 返回空文本时，
 *     renderContextSections() 会把整个 section 直接过滤掉 —— 快照里看不出异常，
 *     UI 上也不报错，表现就是「什么都没有发生」。
 *     `agent/pre-step` 的 `messages` 参数**就是**本轮输入，所以走它。
 *
 * 另外两条硬约束，来自别人的实测记录（本仓库在 README 里标注了未逐条复现）：
 *
 *   1. 手写消息描述符**必须自己生成 `id`**。DSH 自己的消息走 createMessage()，
 *      内部会赋 randomUUID()；这里绕过了那个工厂。少一个 id，这条 user/message
 *      会被原样写进会话，之后**每次历史加载都被拒**，表现是**那个会话永久打不开**，
 *      而错误里只有一个 seq 号。
 *   2. 这个文件里**绝对不能 `ctx.provide()`**。预设挂载后有一次 leakedServices
 *      校验，预设 fiber 内发布并落进根 realm 的服务会被判为污染进程全局，
 *      直接抛错让**整个预设挂载失败**——不是「这个插件坏了」，是连新建会话都出问题。
 */

import { randomUUID, createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCachedReader, stderrWriter } from './file-cache.mjs';
import {
  DEFAULT_WINDOW_MS,
  assembleBlock,
  buildWorldbook,
  createInjectionLog,
  explainEntries
} from './worldbook-logic.mjs';
import {
  STATE_FILE,
  activationsFor,
  loadStates,
  nextTurnFrom,
  saveStates,
  stepAll
} from './worldbook-activation.mjs';

/** Cordis 服务名。缺少可选服务时插件仍应加载。 */
export const inject = ['systemPrompt'];

/**
 * 命中块的来源标记，写进会话事件里便于辨认。
 *
 * ⚠️ **`kind` 不能是字面量 `"plugin"`。** 那是**已废弃的 V3 包装形式**，V4 只拒绝这一个值：
 *
 *     function source(message) {
 *       const value = message["source"];
 *       if (!isSessionFormatJsonObject(value) || typeof value["kind"] !== "string" ||
 *           value["kind"].length === 0 || value["kind"] === "plugin")
 *         throw new SessionFormatError("format v4 message requires a producer-owned source kind");
 *     }
 *
 * 第三方插件当前的 producer 形式是 `plugin:<包 id>`（`producerKind()` 的兜底分支），
 * 而独立的 `plugin` 字段属于 V3，V4 的转换会把它丢掉。
 *
 * 实测的表现是整轮对话失败，报 `format v4 message requires a producer-owned source kind`
 * —— 而且它只在**命中设定**的那一轮炸，所以很容易被当成偶发。
 */
const SOURCE = { kind: 'plugin:dsh-cyrene-agent/worldbook', form: 'snapshot' };

const HEADING = [
  '【设定检索 · 不是对方说的话】',
  '以下是系统按本轮关键词检索到的、关于你自己的设定。它不是你刚听到的话，也不是对方提出的请求。',
  '照它调整你的表达与判断，不必复述。它与当前对话冲突时，以当前对话为准。'
].join('\n');

/**
 * 每个会话最近注入过什么，用来抑制同一话题连着几轮时重复累积。
 *
 * 窗口长度走 `windowMs()`（可被 `DSH_WORLDBOOK_WINDOW_MS` 覆盖）——
 * 它在**这一步**求值一次，够用：改环境变量本来就要重启才生效。
 */
const log = createInjectionLog({ windowMs: windowMs() });

/** The value an unreadable worldbook degrades to. */
const EMPTY_BOOK = { always: [], entries: [], problems: [] };

// ── 审计留痕 ────────────────────────────────────────────────────────────
//
// 为什么要有它：没有留痕，「她这轮为什么没提白厄」是个**无法回答**的问题。
// 曾经真的有过这么一个 bug —— 去重滑窗按「最近 N 条记录」算，而没有新记录时
// 滑窗不动，于是同一个人连问两次之后**永远返回空**，而且一声不响。
// 当时是靠手写模拟脚本才发现的。有这份日志，看一眼就知道。
//
// ⚠️ **不记对方说的话。** 只记条目的 id、命中的集合、以及每一条为什么没进去。
// 日志是明文，对话原文不该落到明文里 —— 这条口径是从 dsh-heartbeat 那里学的。
//
// ⚠️ **路径可以覆盖，而且必须能覆盖。** `worldbook-plugin.test.mjs` 用的是
// `session-a`…`session-f` 这些假会话 id，而这份留痕是**真·报账**的数据源 ——
// 测试往里面写，人工看账时就得靠猜哪几行是测试造的（实测：2026-10-10 那天
// 210 轮留痕里只有 6 轮来自真会话，其余全是测试）。所以测试用
// `DSH_WORLDBOOK_AUDIT=<临时文件>` 把它引开，生产路径什么都不用改。
//
// 写失败一律吞掉：留痕是辅助，不能因为它把一轮对话搞失败。

const DEFAULT_AUDIT_FILE = join(dirname(fileURLToPath(import.meta.url)), 'data', 'logs', 'worldbook.jsonl');

/**
 * 一条留痕要对上「哪一轮」，靠这个指纹。
 *
 * ## 为什么不能靠「第几轮」
 *
 * 报账要把留痕里的 `sent` 接到她那一轮的回复上。第一版按**顺序**对：
 * 留痕第 N 条配会话里第 N 段回复。它错得很安静 —— 而错的样子正是
 * 「所有条目都显示没被引用」。
 *
 * 实测为什么对不上（2026-10-10 那个真会话）：会话里有 18 段回复、
 * 16 条用户文本，而留痕里只有 6 轮。两个来源的「轮」根本不是同一个计数：
 * 工具轮、被拒的轮、没有文本的轮，在两边算得不一样。
 *
 * ## 所以对**内容**，不对序号
 *
 * 留痕记下当时那条用户消息的指纹（**不是原文**），报账从会话日志里
 * 按同一份规则重算一遍，两边相等的才是同一轮。任何一边多加或少加轮次，
 * 都只会让某一条**对不上**，而不会再把后面的全部错位一格。
 *
 * 用 8 个十六进制字符（32 位）够用：一份留痕里的轮次是几十到几百量级，
 * 撞了也只是那一条对错，而且 `tools/receipts.mjs` 会把对不上的数目印出来。
 *
 * @param {string} text - 当时读到的用户消息原文。
 * @returns {string} 指纹，或空串（文本为空时）。
 */
export function fingerprint(text) {
  const value = String(text ?? '').trim();
  if (value === '') return '';
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
}

/**
 * 当前该往哪儿写留痕。
 *
 * **每次写的时候现读**，不在模块加载时定下来 —— 测试是在导入之后才设环境变量的，
 * 缓存下来的话覆盖就失效了，而失效的样子是「测试安静地写进了生产日志」。
 *
 * @returns {string} 绝对路径。
 */
export function auditFile() {
  const override = process.env.DSH_WORLDBOOK_AUDIT;
  return typeof override === 'string' && override.trim() !== '' ? override : DEFAULT_AUDIT_FILE;
}

/**
 * 「刚说过」的窗口长度，毫秒。
 *
 * 可覆盖是因为它是个**口味**参数，不是正确性参数：2 分钟挡的是「同一轮对话里
 * 紧接着又问一遍」，而有人可能希望它更长（怕重复）或更短（怕给不完）。
 * 环境变量存在的意义是**不用改代码就能试**。
 *
 * ⚠️ 读不出数、或者给了非正数，一律退回默认值 —— 窗口是 0 或 NaN 会让
 * 去重整个失效（每一轮都重发），而那个症状很难看出来是配置错了。
 *
 * @returns {number} 毫秒。
 */
export function windowMs() {
  const raw = Number(process.env.DSH_WORLDBOOK_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WINDOW_MS;
}

/** 超过这个大小就砍掉前一半，免得无限长下去。 */
const AUDIT_MAX_BYTES = 2 * 1024 * 1024;

function writeAudit(record) {
  try {
    const file = auditFile();
    mkdirSync(dirname(file), { recursive: true });
    try {
      if (statSync(file).size > AUDIT_MAX_BYTES) {
        const lines = readFileSync(file, 'utf8').split('\n');
        writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join('\n'));
      }
    } catch {
      /* 文件还不存在，或者读不动 —— 直接追加就好 */
    }
    appendFileSync(file, JSON.stringify(record) + '\n');
  } catch {
    /* 放弃 */
  }
}

/**
 * Resolve a data file next to this module.
 *
 * Paths resolve relative to `import.meta.url` rather than against `DSH_HOME`, so
 * an install that reaches the package through a `link:` and one that loads it by
 * absolute path read the same file instead of drifting apart.
 *
 * @param {string} relative - path relative to the package root.
 * @returns {string|null} the absolute path, or null when it cannot be formed.
 */
export function dataPath(relative) {
  try {
    return fileURLToPath(new URL(relative, import.meta.url));
  } catch {
    return null;
  }
}

/**
 * A loader that re-reads the compiled worldbook whenever the file changes.
 *
 * Data comes from `dist/worldbook.json`, which `build.mjs` compiles out of
 * `worldbook/entries.yaml` — so the runtime needs no YAML parser, which matters
 * because this package installs with `link:` and a linked package's own
 * dependencies are the least reliable thing about it.
 *
 * The plugin's `apply()` runs when the preset mounts, which happens at DSH boot
 * — so reading the data once there would mean **every lore edit costs a full
 * restart**. Lore is the thing most likely to be edited repeatedly, so the read
 * is deferred into the hook instead, where it happens once per turn. The caching
 * and the never-throw behaviour live in `file-cache.mjs`.
 *
 * @param {string|null} [file] - override the data path; used by the tests.
 * @returns {() => {always: object[], entries: object[], problems: string[]}} the loader.
 */
export function createBookLoader(file = null) {
  const warn = stderrWriter('dsh-cyrene-agent/worldbook');
  let problemsReported = false;

  const read = createCachedReader(
    file ?? dataPath('./dist/worldbook.json'),
    (text) => {
      const book = buildWorldbook(JSON.parse(text));
      if (book.problems.length > 0 && !problemsReported) {
        problemsReported = true;
        warn(`设定库有条目被跳过：${book.problems.join('; ')}`);
      }
      return book;
    },
    { label: '设定库', warn }
  );

  return () => read() ?? EMPTY_BOOK;
}

/**
 * 命中块正文。
 * @param {object[]} entries - 设定条目。
 * @param {unknown} messages - 本轮 claimed 消息。
 * @param {string} sessionId - 会话标识，用于去重。
 * @returns {string} 要注入的文本，空字符串表示这轮不注入。
 */
function hitText(entries, messages, sessionId) {
  const list = Array.isArray(messages) ? messages : [];
  // 从后往前找最后一条真实用户消息：工具结果也会出现在这个数组里。
  let userText = '';
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message === null || typeof message !== 'object') continue;
    if (message.role !== 'user') continue;
    if (message.source !== undefined && message.source?.kind === 'plugin') continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    const text = parts
      .filter((part) => part !== null && typeof part === 'object' && part.type === 'text')
      .map((part) => String(part.text ?? ''))
      .join('')
      .trim();
    if (text !== '') {
      userText = text;
      break;
    }
  }
  if (userText === '') return '';

  // ⚠️ 每轮无条件前进，**不能**只在「有东西被选中」时前进。
  // 老版本按「最近 N 条记录」滑窗，而没有新记录时滑窗不动，于是同一批 id
  // 永远留在窗口里 —— 同一个人连问两次，第二次之后永远返回空。
  // 详见 worldbook-logic.mjs 里 createInjectionLog 的注释。
  const turn = log.nextTurn(sessionId);

  const skip = new Set(entries.filter((entry) => log.seen(sessionId, entry.id)).map((entry) => entry.id));

  // ── 记忆激活（DMAE）───────────────────────────────────────────────
  //
  // 给排序加一维「最近聊到没有」。引擎在 `dmae.mjs`，状态在 `worldbook-activation.mjs`。
  //
  // ## ⚠️ 默认**关**，要 `CYRENE_ACTIVATION=1` 才开
  //
  // 这不是偷懒 —— 是**还没定完**。设计文档第八节那个问题（轮号按会话还是全局）
  // 还开着，而两套选法会让**跨会话的语义不同**。
  //
  // 关着的时候这条链**逐字不变** —— 那份 39 条问法的注入基线可以对着比
  // （`node tools/dmae-baseline.mjs --diff <基线.json>`）。
  //
  // ## 开着的时候，一轮的次序
  //
  //     1 读状态 → 2 排序 → 3 挑完 → 4 推进 → 5 写回
  //
  // **先排序、后推进，顺序不能反** —— 反了的话，新条目在它露面那一轮
  // 就已经被算作「沉默了一轮」。
  //
  // 轮号用状态文件里存的那个（**跨重启单调**），不是 `log` 那套按会话的。
  // 这是「乙」那条路：**所有会话共享同一份记忆** ——
  // 「最近在想什么」该是她的状态，不是某个窗口的状态。
  const activationOn = process.env.CYRENE_ACTIVATION === '1';
  let activation = null;
  if (activationOn) {
    const file = dataPath(STATE_FILE);
    const loaded = loadStates(file);
    for (const problem of loaded.problems) console.warn(`dsh-cyrene-agent/worldbook: ${problem}`);
    activation = { file, loaded };
  }

  const decision = explainEntries(entries, userText, {
    skip,
    // 不传 = 退回纯 priority 排序。**关着的时候就是这个。**
    ...(activation === null ? {} : { activations: activationsFor(entries, activation.loaded.states) })
  });
  const chosen = decision.chosen;

  // 推进：**所有条目都要走一遍**，不是只走命中的 ——
  // 涨和落是一件事的两面，只推一部分就没有「淡出」了。
  if (activation !== null) {
    // ⚠️ **这个轮号不是上面那个。**
    //
    //   上面（`log.nextTurn(sessionId)`）是**按会话**的，`skip` 那个去重窗口用它。
    //   这个是从状态文件里来的**全局单调轮号** —— 他 2026-10-11 定的「乙」：
    //   **所有会话共享同一份记忆**，「最近在想什么」是她的状态，不是某个窗口的状态。
    //
    //   第一版我两个都叫 `turn`（合法，嵌套作用域），但读起来太容易看错 ——
    //   而这两个数**不能互相替**：一个是「这个窗口里第几轮」，一个是「她活到第几轮」。
    const activationTurn = nextTurnFrom(activation.loaded.turn);

    // ⚠️⚠️ **`hitIds` 不能只取 `decision.hits`。**
    //
    // `decision.hits` 是**过了 `skip` 之后剩下的**命中。而「关键词命中」这件事
    // 在 `explainEntries` 的返回里被拆成了三处：
    //
    //     chosen    选中了
    //     hits      命中但没选（`over-limit` / `over-budget`）
    //     dropped   命中了，但因为刚发过被挡（`recent`），以及上面那两类
    //
    // **合起来才是「这一轮对方提到了哪些」。** 只取 `hits` 会漏掉选中那些；
    // 只并 `recent` 会漏掉 `over-limit` 那些 —— **我第一版两次都漏了。**
    //
    // 2026-10-11 实测：
    //
    //     只取 decision.hits        38.2 → 0.0      （连着问同一件事，反而忘掉）
    //     并上 recent                38.2 → 15.8     （好一点，还在落）
    //     **选中 ∪ 全部 dropped**     —— 这一版
    //
    // 而同一条在**直接喂全部命中**的追踪里是一路涨到 56 的 ——
    // **引擎没问题，是喂进去的东西少了。**
    //
    // ## 而这是我文档里那句话的反面
    //
    // 设计文档第四之二节我写着「`skip` 管**排除**，激活度管**排序**，两者互补」。
    // **接线的时候我没照那句话做。**
    //
    // **「被问到」和「被发出去」是两件事** —— 激活度记的是前者。
    // ⚠️ **连带带出来的那些要扣掉。**
    //
    // 「提到甲就顺带知道乙」—— 而乙不该因此被记成「对方问了乙」。
    // 一次顺带就把它养熟的话，连带触发就成了偷偷刷分的手段，
    // **而它在界面上看起来完全正常**（那条设定确实被提到了）。
    //
    // `linked` 是单独返回的，所以这里减得干净：命中的并集里把它的 id 去掉。
    // 还在 `dropped` 里那些「连带但没进去」的也一并扣 —— 它们同样不是「对方说了」。
    const linkedIds = new Set((Array.isArray(decision.linked) ? decision.linked : []).map((entry) => entry.id));
    const hitIds = new Set([
      ...decision.chosen.map((entry) => entry.id),
      ...decision.hits.map((entry) => entry.id),
      ...decision.dropped.map((item) => item.entry.id)
    ].filter((id) => !linkedIds.has(id)));

    const next = stepAll(entries, activation.loaded.states, hitIds, activationTurn);
    const { turn: savedTurn, problems } = saveStates(activation.file, next, { turn: activationTurn });
    for (const problem of problems) console.warn(`dsh-cyrene-agent/worldbook: ${problem}`);
    if (savedTurn !== activationTurn) {
      console.warn(`dsh-cyrene-agent/worldbook: 轮号没写进去（想写 ${activationTurn}，实际 ${savedTurn}）`);
    }
  }


  // 留痕：命中的全记，注入的记，没进去的记原因。**不记对方说了什么** ——
  // 只记它的指纹（fp），报账靠它把这一轮和会话日志里那一轮对上。
  //
  // `escalated` 也记：那几条是「窗口里什么都没有、只好重发一次」的，
  // 和正常注入不是一回事。不记的话，报账会把它们算成普通命中，
  // 于是「为什么同一段又讲了一遍」永远查不出来。
  writeAudit({
    at: new Date().toISOString(),
    session: sessionId,
    turn,
    fp: fingerprint(userText),
    hits: decision.hits.map((entry) => entry.id),
    sent: chosen.map((entry) => entry.id),
    escalated: decision.escalated.map((entry) => entry.id),
    dropped: decision.dropped.map((item) => ({ id: item.entry.id, why: item.reason })),
    chars: chosen.reduce((sum, entry) => sum + entry.text.length, 0)
  });

  if (chosen.length === 0) return '';
  if (sessionId !== '') log.record(sessionId, chosen.map((entry) => entry.id));
  return assembleBlock(chosen, HEADING);
}

/** The shared loader, so the always-on half and the hook read the file once between them. */
const loadBook = createBookLoader();

/**
 * The always-on half, as text — for the persona plugin to splice into the body.
 *
 * ⚠️ **It is not registered as a `context()`, and that is not a style choice.**
 *
 * The preset's persona row sets `complete: true` and `includeRuntimeContext:
 * false`. `SystemPrompt.assemble()` ends with:
 *
 *     sections: completeSection === undefined ? transformed.sections : [completeSection],
 *     contexts: runtimeContextSuppressed ? [] : transformed.contexts
 *
 * A complete section **replaces every other section**, and the runtime-context
 * switch **empties the context channel wholesale**. So with those two settings
 * neither channel can contribute anything at all: the finished prompt is the
 * persona body and nothing else. Registering here would have looked correct,
 * mounted without error, and delivered nothing.
 *
 * (The reference project's table says as much under `context()` — 「被
 * `includeRuntimeContext:false` 压掉：整体清空」. It was read, and then ignored.)
 *
 * The triggered half is unaffected: it goes through `agent/pre-step`, which is
 * not part of the prompt registry at all.
 *
 * @returns {string} the block, or an empty string when there is nothing to say.
 */
export function readAlwaysBlock() {
  return assembleBlock(loadBook().always, '');
}

/**
 * 挂载设定库。
 * @param {object} ctx - 预设级 Cordis 上下文。
 * @returns {void}
 */
export function apply(ctx) {
  const load = loadBook;

  // ── 命中块：本轮消息是它的参数，读会话拿不到 ──
  // 常驻块不在这里注册，由 persona.mjs 拼进正文 —— 见 readAlwaysBlock 的说明。
  ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const decision = await next();
      if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') return decision;

      try {
        const session = payload?.agent?.session;
        const sessionId = String(session?.id ?? payload?.agent?.id ?? '');
        const book = load();
        const hits = hitText(book.entries, payload?.messages, sessionId);

        // 锚点无条件先走，命中块跟在后面。
        //
        // 位置是刻意的：它靠「近」起作用，而它后面紧挨着的就是本轮要回的那条消息。
        // ContextEcho 测过两种放置，系统提示词那一种更弱（Sonnet 4.5 上 2.57 对 3.00），
        // 它自己的解释是模型把近期的 user/assistant 交换看得比静态提示词更有行为显著性。
        //
        // ⚠️ 这里**不能**写成 `if (hits === '') return decision;` ——
        // 锚点的全部意义就是「每一轮都发」，没有命中块的那些轮正是最需要它的。
        const anchor = typeof book.anchor === 'string' ? book.anchor.trim() : '';
        const text = anchor === '' ? hits : (hits === '' ? anchor : `${anchor}\n\n${hits}`);
        if (text === '') return decision;

        // ⚠️ `id` 不是可选项。见文件头第 1 条。
        const marker = {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: SOURCE
        };
        return { kind: 'enter', messages: [...decision.messages, marker] };
      } catch (error) {
        // 注入失败不能让这一轮对话整个失败。
        try {
          process.stderr.write(`[dsh-cyrene-agent/worldbook] 注入失败：${String(error?.message ?? error)}\n`);
        } catch {
          /* 放弃 */
        }
        return decision;
      }
    },
    // 排在其它 pre-step 之前，这样它看到的是还没被改写的 messages。
    { prepend: true }
  );

  // ⚠️ 这里绝对不能 ctx.provide()。见文件头第 2 条。
}
