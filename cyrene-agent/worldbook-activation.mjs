/**
 * 世界书记忆状态的落盘与读回。
 *
 * ## 它管什么
 *
 * `dmae.mjs` 是纯函数 —— 它只算，不记。这个文件管**记**：
 *
 *     读   data/worldbook-activation.json  →  Map<id, EntryState>
 *     写   Map<id, EntryState>             →  那个文件
 *
 * ## 四条规矩（设计文档第五节）
 *
 * **一、只存有状态变化的条目。** 132 条里大部分是 0 —— 全写盘没必要，
 *     而且那个文件会变得没法读。
 *
 * **二、消失的条目不删。** 世界书会改，某条今天没了不代表它不会回来。
 *     留着不花什么，删了就得重学。
 *
 * **三、坏文件退兜底，不抛。** 读到坏 JSON 就当「什么都没有」——
 *     **一个记不住东西的昔涟，比一个起不来的昔涟好。**
 *
 * **四、`data/` 是每台机器自己的。** 它已经在 `make-share.mjs` 的排除表里，
 *     所以激活状态不会随包走 —— 这是对的，那是**这台机器上聊出来的**。
 *
 * ## 为什么做成独立的模块，而不是塞进 worldbook.mjs
 *
 * `worldbook-logic.mjs` 是纯的、被大量测试直接调。**别让它沾上文件系统。**
 * 这个模块只被插件那一层用 —— 那里本来就在读写 `data/logs/`。
 *
 * @module worldbook-activation
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  DEFAULT_PARAMS,
  baseFromPriority,
  effectiveValue,
  emptyState,
  resistanceFromPriority,
  step
} from './dmae.mjs';

/** 相对仓库根的状态文件。 */
export const STATE_FILE = join('data', 'worldbook-activation.json');

/** 写盘时的版本号 —— 形状以后变了要靠它认出来。 */
const SCHEMA = 1;

/**
 * 一个激活度到了多少就值得记下来。
 *
 * **比 0 大一点点就记**：只要它动过，就说明这条被聊到过，
 * 而「被聊到过」这件事本身是信息。真正要滤掉的是**从来没动过的**。
 */
const WORTH_SAVING = 0.01;

/**
 * 读状态。
 *
 * ⚠️ **任何问题都退到空 Map，不抛。** 见文件头规矩三。
 *
 * @param {string} file - 状态文件的路径。相对路径按当前工作目录解。
 * @returns {{states: Map<string, object>, turn: number, problems: string[]}}
 *   状态、里面记着的轮号、以及遇到的问题。
 *   **`turn` 是加出来的字段** —— 老调用方只看 `states` 和 `problems`，不受影响。
 */
export function loadStates(file) {
  const problems = [];
  // 读不出来的时候 `turn` 一律给 0 —— 那是安全的：`nextTurnFrom(0)` 会给 1，
  // 从头开始数。**比给一个猜的值好。**
  if (!existsSync(file)) return { states: new Map(), turn: 0, problems };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    // 坏 JSON：当没有。**不删那个文件** —— 它是唯一的线索，
    // 直接覆盖掉会让人永远查不出当时发生了什么。
    problems.push(`${file} 读不了（${String(error?.message ?? error).slice(0, 60)}），当空的处理`);
    return { states: new Map(), turn: 0, problems };
  }

  if (parsed === null || typeof parsed !== 'object' || parsed.states === undefined) {
    problems.push(`${file} 的形状不对，当空的处理`);
    return { states: new Map(), turn: 0, problems };
  }
  if (parsed.schema !== SCHEMA) {
    // 版本不认识：**不猜**，退到空。旧的那份留着。
    problems.push(`${file} 的版本是 ${parsed.schema}，这边只认 ${SCHEMA}，当空的处理`);
    return { states: new Map(), turn: 0, problems };
  }

  const turn = turnFrom(parsed);

  const states = new Map();
  for (const [id, raw] of Object.entries(parsed.states)) {
    if (raw === null || typeof raw !== 'object') continue;
    const activation = Number(raw.activation);
    if (!Number.isFinite(activation)) continue;
    states.set(id, {
      activation,
      userSilence: Number.isFinite(Number(raw.userSilence)) ? Number(raw.userSilence) : 0,
      modelSilence: Number.isFinite(Number(raw.modelSilence)) ? Number(raw.modelSilence) : 0,
      recentUserHits: Array.isArray(raw.recentUserHits)
        ? raw.recentUserHits.filter((t) => Number.isFinite(t))
        : []
    });
  }
  return { states, turn, problems };
}

/**
 * 写状态。**默认是合并，不是覆盖。**
 *
 * ## 为什么默认合并
 *
 * 第一版是整份覆盖，而我在测试里写了一句「消失的条目由调用方负责带上」。
 * **那是把责任推出去。** 调用方只要有一次只传了「这一轮参与的条目」，
 * 其余条目的记忆就全没了 —— **而这件事不会报错。**
 *
 * 所以默认合并：传进来的更新，**没传的保留**。
 *
 * **要删一条，用 `forget` 显式说。** 那样「删除」是一次有意的动作，
 * 而不是某次调用忘了带上的副作用。
 *
 * ## 原子性
 *
 * **先写临时文件再改名。** 直接覆盖的话，写到一半断了会留下半个 JSON，
 * 而那个文件下次读会退兜底 —— **等于把全部记忆丢掉。**
 *
 * @param {string} file - 状态文件的路径。
 * @param {Map<string, object>} states - 这一轮的状态（会被并进已有的）。
 * @param {object} [options] - 选项。
 * @param {string[]} [options.forget] - 要显式删掉的条目 id。
 * @param {number} [options.turn] - 要记下的轮号。省了就沿用文件里那个。
 *   **轮号必须存下来**：进程重启后它从 0 重来的话，「最近提过几次」那个窗口
 *   会把旧值当成「未来」，**和会话交错是同一个病**（见 `nextTurnFrom` 的注释）。
 * @returns {{saved: number, turn: number, problems: string[]}} 最终存了几条、
 *   记下的轮号、有没有出问题。
 */
export function saveStates(file, states, options = {}) {
  const problems = [];

  // 先读已有的 —— 合并的基础，也是轮号的基础。
  const existing = loadStates(file);
  problems.push(...existing.problems);
  const merged = new Map(existing.states);

  for (const [id, st] of states) {
    if (!Number.isFinite(st?.activation)) continue;
    merged.set(id, {
      activation: Number(st.activation.toFixed(3)),
      userSilence: st.userSilence ?? 0,
      modelSilence: st.modelSilence ?? 0,
      recentUserHits: st.recentUserHits ?? []
    });
  }

  // 显式删除
  for (const id of Array.isArray(options.forget) ? options.forget : []) merged.delete(id);

  // 规矩一：只存动过的。
  // ⚠️ 注意这一层是**在合并之后**做的 —— 否则已有的条目会被这里滤掉。
  //
  // ⚠️⚠️ **而「动过」不能只看 `activation`。** 第一版就是这么写错的：
  //
  //     if (Math.abs(st.activation) < WORTH_SAVING && (st.recentUserHits ?? []).length === 0) continue;
  //
  // **一个已归档的条目：`activation` 是 0、窗口也空了 —— 于是被当成「没动过」滤掉。**
  // 而它下一轮不在文件里，`stepAll` 就当成「没见过的新条目」，**从底座重新进场**。
  //
  // 2026-10-11 实测到的曲线就是这么个五轮循环：
  //
  //     view-aglaea   40 35 26 13 0 | 40 35 26 13 0 | 40 …
  //
  // **「忘掉」这件事被存档策略撤销了。**
  //
  // 静默计数是区分「真没动过」和「动过之后归档了」的那个东西 ——
  // `emptyState()` 三个计数都是 0，而归档的条目 `userSilence` 一定大于 0。
  const out = {};
  for (const [id, st] of merged) {
    const quiet =
      Math.abs(st.activation) < WORTH_SAVING &&
      (st.recentUserHits ?? []).length === 0 &&
      (st.userSilence ?? 0) === 0 &&
      (st.modelSilence ?? 0) === 0;
    if (quiet) continue;
    out[id] = st;
  }

  // 轮号：给了就用给的，没给就沿用文件里那个。**只增不减** ——
  // 倒退的轮号会让窗口错乱，而那是这套东西最难查的一类坏法。
  const want = Number.isFinite(options.turn) ? Math.floor(options.turn) : existing.turn;
  const turn = Math.max(existing.turn, want);

  const payload = { schema: SCHEMA, turn, savedAt: new Date().toISOString(), states: out };
  const tmp = `${file}.tmp`;
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch (error) {
    problems.push(`写不了 ${file}：${String(error?.message ?? error).slice(0, 80)}`);
  }
  return { saved: Object.keys(out).length, turn, problems };
}

/**
 * 把一批条目和一份状态合起来，交给 `explainEntries` 用。
 *
 * ⚠️ **没状态的条目从 `A_base` 进场，而不是 0。**
 *
 * 这一条接上的是「底座只是醒来时的高度」那个决定（`wake`）：
 * 新条目第一次出现时，我们只知道它的 `priority` —— 而 `priority` 说它「醒来该在哪个高度」。
 * 从 0 进的话，一条 `priority: 90` 的设定第一次被问到会排到最后。
 *
 * @param {object[]} entries - 世界书条目（要带 `id` / `priority`）。
 * @param {Map<string, object>} states - 已存的状态。
 * @param {object} [params] - 参数，需要 `promptThreshold`。
 * @returns {Map<string, number>} `id → 激活度`。
 */
export function activationsFor(entries, states, params = DEFAULT_PARAMS) {
  const out = new Map();
  for (const entry of entries) {
    const saved = states.get(entry.id);
    if (saved !== undefined) {
      out.set(entry.id, saved.activation);
      continue;
    }
    // 没见过它 —— 从底座进场。**不是 0。**
    // ⚠️ 用 `effectiveValue`：条目写了 `intrinsicValue` 就用它，没写才退回 `priority`。
    //    **「重要」和「难忘」该是两个字段**（见那个函数的注释）。
    out.set(entry.id, baseFromPriority(effectiveValue(entry), params));
  }
  return out;
}

/**
 * 一条条目的当前状态；没存过就返回空状态。
 *
 * @param {Map<string, object>} states - 已存的状态。
 * @param {string} id - 条目 id。
 * @returns {object} 那个条目的状态。
 */
export function stateOf(states, id) {
  return states.get(id) ?? emptyState();
}

/**
 * 推进一轮：把所有条目都走一遍 `step`，返回新的状态。
 *
 * ## 为什么要把**所有**条目都走一遍，而不是只走命中的
 *
 * 因为**涨和落是一件事的两面**。只推命中那些的话，
 * 没命中的条目永远停在原地 —— **那就没有「淡出」了，整套东西也就没意义了。**
 *
 * 132 条的算术很便宜（每轮几百次浮点运算），不值得为它做增量。
 *
 * ## ⚠️ `turn` 必须是单调递增的
 *
 * `step` 用它维护「最近提过几次」的窗口（`repeatWindow`）。
 * 传一个回退的轮号会让窗口错乱。
 *
 * ## 没存过的条目从底座进场
 *
 * 和 `activationsFor` 同一条规矩，理由也一样 ——
 * 从 0 进的话，一条 `priority: 90` 的设定头次被问到会排到最后。
 *
 * @param {object[]} entries - 世界书条目（要带 `id` / `priority` / `keywords`）。
 * @param {Map<string, object>} states - 上一轮的状态。
 * @param {Set<string>|string[]} hitIds - 这一轮被关键词命中的条目 id。
 * @param {number} turn - 当前轮次，单调递增。
 * @param {object} [params] - 参数。
 * @returns {Map<string, object>} 新的状态。
 */
export function stepAll(entries, states, hitIds, turn, params = DEFAULT_PARAMS) {
  const hits = hitIds instanceof Set ? hitIds : new Set(hitIds ?? []);
  const next = new Map();

  for (const entry of entries) {
    if (typeof entry?.id !== 'string') continue;

    // ⚠️⚠️ **`keywords` 和 `needles` 不是同一个字段，踩过。**
    //
    // `dmae.mjs` 的 `step` 有一句「没有触发词的条目不参与」，它看的是 `entry.keywords`。
    // 而世界书条目在 `worldbook-logic.mjs` 归一化之后带的是 **`needles`**。
    //
    // **于是每一条都被判成「没有触发词」，`step` 一律原样返回 —— 整套东西一直没在算。**
    // 而它不报错：数值停在底座上，看起来就像「刚好平衡」。
    //
    // 2026-10-11 是拿二十轮的曲线才看出来的：
    //
    //     anaxa-who     32.0 32.0 32.0 … 32.0     ← 一直是底座
    //     view-aglaea   42.0 42.0 42.0 … 42.0
    //
    // **平的曲线不等于收敛，也可能是根本没动。** 那两种在数字上长得一样。
    const entryForStep = {
      ...entry,
      keywords: Array.isArray(entry.keywords) && entry.keywords.length > 0
        ? entry.keywords
        : (Array.isArray(entry.needles) ? entry.needles : []),
      // 抗遗忘能力 `I`。⚠️ **它和 `intrinsicValue` 不是一个量纲** ——
      // 前者 1~4，后者 30~90。所以这里要过一道 `resistanceFromPriority`，
      // 不能把 `intrinsicValue` 直接塞进来（那正是 2026-10-11 差点犯的错）。
      resistance: resistanceFromPriority(effectiveValue(entry))
    };

    const before = states.get(entry.id) ?? emptyState();
    // 从底座进场 —— **不是 0**。同样按 `effectiveValue`。
    const base = baseFromPriority(effectiveValue(entry), params);
    const seeded = before.activation === 0 && before.userSilence === 0 && before.recentUserHits.length === 0
      ? { ...before, activation: base }
      : before;

    const after = step(seeded, {
      entry: entryForStep,
      base,
      userHit: hits.has(entry.id),
      // 模型侧先不接 —— 「她回复里提到」不等于「那条设定有用」。
      // 见设计文档第七节第三问。**先砍，少一个调不准的输入。**
      modelHit: false,
      turn
    }, params);

    next.set(entry.id, after);
  }

  // 已经不在世界书里的条目：**原样带过去，不删。**
  // 世界书会改，某条今天没了不代表它不会回来；留着不花什么，删了就得重学。
  for (const [id, st] of states) {
    if (!next.has(id)) next.set(id, st);
  }

  return next;
}

/**
 * 从一堆状态里取出给 `explainEntries` 用的激活度表。
 *
 * 和 `activationsFor` 的区别：那个是「知道有哪些条目、去查状态」，
 * 这个是「手里已经有一份完整状态、只要激活度」。
 *
 * @param {Map<string, object>} states - 状态。
 * @returns {Map<string, number>} `id → 激活度`。
 */
export function activationsOf(states) {
  const out = new Map();
  for (const [id, st] of states) {
    if (Number.isFinite(st?.activation)) out.set(id, st.activation);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 轮号 —— 它从哪来，是个要定的问题（设计文档第八节）
 * ------------------------------------------------------------------ */

/**
 * 逼出下一个轮号，并保证它**跨重启单调**。
 *
 * ## 为什么轮号得存在状态文件里
 *
 * `stepAll` 拿 `turn` 维护「最近提过几次」的窗口：
 *
 *     recentUserHits.filter((t) => t > turn - repeatWindow)
 *
 * **如果轮号在重启后从 0 重来**，那窗口里的旧值（比如 200）就变成了「未来」——
 * 和会话交错那件事是同一个病，只是换了个触发条件：
 *
 *     ⚠️ 进程重启 → 轮号归零 → 窗口里留着一堆比当前轮号大的值 → 永久失效
 *
 * **这个坑和 `DEFAULT_WINDOW_MS` 注释里记的第二个坑同源** ——
 * 那时用「轮号做锚点」在重启后错乱，于是改成了墙上时间。
 * **现在轮到我们踩同一个了，所以这次一开始就把轮号存下来。**
 *
 * @param {number} saved - 文件里存着的轮号（可能是 0 或坏值）。
 * @returns {number} 可以安全使用的下一个轮号。
 */
export function nextTurnFrom(saved) {
  const n = Number(saved);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) + 1 : 1;
}

/**
 * 状态文件的读写要不要带上轮号。
 *
 * ⚠️ `schema` 不变（还是 1）—— **加一个字段不是换形状**。
 * 老文件里没有 `turn`，`nextTurnFrom(undefined)` 会给 1，那是安全的下界。
 *
 * @param {object} payload - 从文件里读出来的整份。
 * @returns {number} 里面记着的轮号；没有或坏掉就给 0。
 */
export function turnFrom(payload) {
  const n = Number(payload?.turn);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
