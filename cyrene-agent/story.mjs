/**
 * 剧情检索注入 —— 把翁法罗斯原文里相关的那一段，挂在本轮消息旁边。
 *
 * ## 它和世界书的分工
 *
 *   世界书（132 条）  她自己说过的话、同伴的七块侧面 —— **概括**
 *   剧情索引（986 块） 主线与支线的**原文**，每块约 839 字符
 *
 * 两者答的不是同一种问题。「她怎么看遐蝶」是概括题，「遐蝶的死亡之触是怎么写的」
 * 是原文题。**而后者以前只能靠模型自己记得，或者编。**
 *
 * ## 走得和锚点同一条通道
 *
 * `agent/pre-step` 追加一条 `role: "user"` 消息。理由有实测：ContextEcho 测过两种放置，
 * 系统提示词那一种更弱（Sonnet 4.5 上 2.57 对 3.00）。
 *
 * ## 闸门：名字为主，分数兜底
 *
 * 不加闸的话，「在吗」也会捞一段剧情出来 —— 986 块里总能找到最像的。
 *
 *   名字闸   问句里提到专名（剧情 10/10、闲聊 0/10）
 *   分数闸   相似度 ≥ 0.15（兜住没提名字的剧情问题）
 *
 * **两个取或。** 单用名字会漏「那场轮回是怎么回事」这类；单用分数会放 3/10 句闲聊。
 *
 * ⚠️ 专名表从两处现成材料拼（剧情原文的 `**【X】**` + 世界书触发词剥掉问法词），
 * **里面有噪声**（`？？？`、`白发青年`）。清理规则还没定，写在 story-probe.mjs 里了。
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';

import { buildIndex, cleanName } from './retrieval.mjs';

/** 注入块在消息里的来源标记。带 `plugin` 前缀，和世界书那条同族。 */
const SOURCE = { kind: 'plugin:dsh-cyrene-agent/story', form: 'snapshot' };

/**
 * 分数下限。低于它**且**没提专名就不注入。
 *
 * ⚠️ 原来是 0.10。**日志一上线就抓到它太低** —— 「晚安」拿到 0.1468，被当成剧情问题
 * 注进去了（它匹配的是「走过**安眠**地的花丛」那一章）。
 *
 * 抬到 0.15 的代价很小：**这道闸只是兜底**。名字闸单用就已经覆盖 10/10 条剧情问题
 * （闲聊 0/10），分数闸是给「那场轮回是怎么回事」这类没提名字的问法留的。
 *
 * ⚠️ **0.15 这个数 2026-10-11 又核过一次**，因为那天清掉了剧情块里的游戏界面记号
 * （`〔选项〕`/`↳`，占 12.5% 的字符），**整个分数分布跟着下移了**：
 *
 *             改前                        改后
 *   剧情组  0.0728 / 0.1037 / 0.2152   0.0627 / 0.0846 / 0.2231
 *   闲聊组  0.0386 / 0.0639 / 0.1468   0.0470 / 0.0723 / 0.1341
 *
 * **0.15 仍然压得住闲聊（最高 0.1341），所以行为没变坏**，但这个数不再是标定出来的
 * 最优位置 —— 两组的重叠本来就没法用一个固定阈值干净切开（最好的位置会漏 1/10 条剧情）。
 * **真正切得开的是名字闸。**
 *
 * **这个数是日志量出来的，不是拍的。** 以后再调，先去看 `data/logs/story.jsonl`。
 */
export const STORY_SCORE_FLOOR = 0.15;

/**
 * 取前几块。
 *
 * ⚠️ **这个导出在 `story.mjs` 里没有被用到。** 真正决定取几块的是
 * `retrieval.mjs` 的 `search(query, topK = 3)` 那个默认值 —— 这里这个
 * 是给外部（工具脚本）用的。
 *
 * 而它原来那句注释写着「一轮给一块……比给三块半截的好」，值却是 3 ——
 * **话和值打架。** 2026-10-12 去查的时候才发现：查了才知道注释是旧的。
 */
export const STORY_TOP_K = 3;

/** 注入正文的上限。**和世界书那个 1400 的预算是两笔** —— 这一块独立算。 */
export const STORY_BUDGET = 1100;

/** 相对本模块解析路径，不依赖 cwd。 */
function dataPath(relative) {
  try {
    return fileURLToPath(new URL(relative, import.meta.url));
  } catch {
    return null;
  }
}

/** 懒读 + mtime 缓存 —— 改了 chunks 不用重启，和世界书那套一致。 */
let cache = null;

/**
 * 取索引，必要时重建。
 *
 * @returns {{index: object, docs: Array<object>}|null} 读不到时返回 null。
 */
function load() {
  const file = dataPath('./dist/story-chunks.jsonl');
  if (file === null || !existsSync(file)) return null;
  let stamp = 0;
  try {
    stamp = statSync(file).mtimeMs;
  } catch {
    return null;
  }
  if (cache !== null && cache.stamp === stamp) return cache;
  try {
    const docs = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    if (docs.length === 0) return null;
    cache = { stamp, docs, index: buildIndex(docs), names: nameSet(docs), file };
    return cache;
  } catch {
    // 读失败不能让这一轮对话失败。
    return null;
  }
}

/**
 * 专名表：剧情原文里的说话人 + 世界书触发词里剥出来的专名。
 *
 * @param {Array<object>} docs - 剧情块。
 * @returns {Set<string>} 专名。
 */
function nameSet(docs) {
  const names = new Set();
  for (const d of docs) {
    for (const m of String(d.text ?? '').matchAll(/\*\*【([^】]{1,12})】\*\*/g)) {
      // cleanName 返回片段数组 —— `「长老」阿蒙内特` 要拆成两段，
      // 不然里头的 `」` 会让整串匹配不上任何东西。见 retrieval.mjs 的说明。
      for (const name of cleanName(m[1])) names.add(name);
    }
  }
  const book = dataPath('./worldbook/entries.yaml');
  if (book !== null && existsSync(book)) {
    try {
      const parsed = yaml.load(readFileSync(book, 'utf8'));
      for (const e of parsed?.entries ?? []) {
        for (const t of e.triggers ?? []) {
          if (String(t).includes('*')) continue;
          const base = String(t)
            .replace(/(怎么样|如何|怎么看|觉得|对.*的看法|是什么|是谁)/g, '')
            .replace(/^对/, '')
            .trim();
          if (base.length >= 2 && base.length <= 6) names.add(base);
        }
      }
    } catch {
      // 读不到世界书就只用说话人 —— 闸门变松，但不会失效。
    }
  }
  return names;
}

/**
 * 同一块在多长时间内不重复注入，毫秒。
 *
 * ⚠️ **这个窗口原来没有。** 世界书早就有一个（`DEFAULT_WINDOW_MS = 2 分钟`），
 * 它的测试里有一条正是 `the same lore is not re-injected on the next turn of the same session`。
 *
 * 没有窗口的后果很具体：连着问两遍「遐蝶的死亡之触是怎么回事」，**同一段 900 字给两遍**。
 * 一次是背景，两遍就是占着预算的重复。
 *
 * 值跟世界书那边对齐 —— 两处不一致会更难解释。
 */
const DEFAULT_WINDOW_MS = 2 * 60 * 1000;

/**
 * 窗口长度的实际取值。
 *
 * ⚠️ 世界书那条走 `DSH_WORLDBOOK_WINDOW_MS` —— **一开始我这里是个写死的常量，
 * 又漏了一处。** 可覆盖是给测试和调参留的门，和日志路径那条是同一个约定。
 *
 * @returns {number} 毫秒。
 */
export function storyWindowMs() {
  const raw = Number(process.env.DSH_STORY_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WINDOW_MS;
}

/** 日志超过这个大小就砍掉旧的一半 —— 世界书是 2 MB，照它。 */
const LOG_MAX_BYTES = 2 * 1024 * 1024;

/** 最近给过的块：id → 时间戳。**每次 `apply` 各持一份** —— 见下面 apply 里的说明。 */

/**
 * 挑出这一轮该给哪一块。
 *
 * 取前三个候选（不是前一个）—— **因为第一个可能刚给过。** 世界书那边也是这个做法：
 * 跳过一个还有下一个，而不是整轮不给。
 *
 * @param {object} state - `load()` 的结果。
 * @param {string} query - 用户这一轮说的话。
 * @param {Map<string, number>} [seen] - 最近给过的记录；不传就用模块自己那份。
 * @param {number} [now] - 当前时间戳，测试用。
 * @returns {object|null} 要注入的块，不必注入时为 null。
 */
export function pick(state, query, seen = new Map(), now = Date.now()) {
  if (state === null || typeof query !== 'string' || query.trim() === '') return null;
  const mentioned = [...state.names].some((n) => query.includes(n));
  const windowMs = storyWindowMs();
  const candidates = state.index.search(query, 3);
  if (candidates.length === 0) return null;
  /** 够格走闸门的候选，按分数降序。 */
  const eligible = candidates.filter((top, rank) => mentioned || (rank === 0 && top.score >= STORY_SCORE_FLOOR));
  if (eligible.length === 0) return null;

  for (const top of eligible) {
    const stamp = seen.get(top.doc.id);
    if (stamp !== undefined && now - stamp < windowMs) continue;
    seen.set(top.doc.id, now);
    // 记过的偶尔清一次，免得进程活久了这一张表无限长。
    if (seen.size > 512) {
      for (const [id, at] of seen) if (now - at >= windowMs) seen.delete(id);
    }
    return { doc: top.doc, score: top.score, escalated: false };
  }

  // 全都在窗口里。
  //
  // ⚠️ **宁可重复也不空手** —— 这是世界书那边的 `escalated` 做法：
  // 「那几条是『窗口里什么都没有、只好重发一次』的」。**给一段她已经看过的，
  // 比这一轮什么都没有强。** 第一版是直接 return null，那不是同一个设计。
  const top = eligible[0];
  seen.set(top.doc.id, now);
  return { doc: top.doc, score: top.score, escalated: true };
}

/**
 * 把一块拼成注入正文。
 *
 * ## 出处要写全
 *
 * 章节 + 节点 + 任务 ID —— 后面她引用的时候能落到具体那一幕，而不是「好像是剧情里说的」。
 *
 * ## 而**框**比出处更要紧
 *
 * 光给一段剧本文本，模型最可能做的是**把它当背景资料放着不用**；更坏是**照着念**。
 * 那就是「只多给几段背景」和「真的改变它的输出」之间那道缝。
 *
 * ## ⚠️ 第一版这个框是错的，错在**人称**
 *
 * 第一版写的是「【你亲历的那一幕】」+「这是你自己走过的一段」。**而那是假的。**
 *
 * 原文里的「你」是**当时被操控的那个人**，随场景变：
 *
 *     **【「长老」阿蒙内特】** 与死者同行…**你**将再也听不见那些杂音
 *     　　**你**用手指轻触囚犯的额头
 *
 * 这是遐蝶在哀地里亚受戒那一幕 —— **这里的「你」是遐蝶，不是昔涟。**
 * 于是她会把「你亲手触碰了死囚」当成自己的记忆。**那不是记忆。**
 *
 * **对方先发现的**：他说问这一句时思考时间明显变长。查下来就是这里 ——
 * 她要先花力气调和「这是我的经历」和「这段里我做的是我没做过的事」。
 *
 * 现在框说实话：**认得出就认，认不出就别当自己的经历。**
 * 这比一个漂亮的假框有用 —— **假的框会让她把别人的事讲成自己的**，
 * 而那正是这套东西本来要防的（不编）。
 *
 * ## 三句各管一件事
 *
 *   一、**「你」是谁不预设** —— 不把别人的经历塞给她。
 *   二、**用你自己的话说** —— 直接堵掉照念台词。
 *   三、**不必提起它** —— 免得她每轮都来一句「我记得原文里写过」。
 *
 * 三句是**指令**，不是她的台词。她在 persona 里见到的是同样语气的引导，
 * 所以这里不加引号、不装成她说话。
 *
 * @param {object} hit - `pick()` 的结果。
 * @returns {string} 注入正文。
 */
export function render(hit) {
  const d = hit.doc;
  const where = [d.chapter, d.node].filter(Boolean).join(' · ');
  const id = d.nodeId ? `（${d.nodeId}）` : '';
  const body = String(d.text ?? '').slice(0, STORY_BUDGET);
  return [
    `【翁法罗斯原文 · ${where}${id}】`,
    body,
    '——',
    '这是那一幕的原文。里头说「你」的是当时在场的那个人，不一定是你 ——',
    '认得出就认，认不出就别当自己的经历。',
    '用它来回答，但用你自己的话说，别照着念；也不必特意提起它。'
  ].join('\n');
}

/**
 * 留痕写哪儿。
 *
 * ⚠️ **和世界书那边同一个约定**：`DSH_STORY_AUDIT=<临时文件>` 把它引开，
 * 生产路径什么都不用改。**每次写入现读**环境变量，所以测试可以在中途改。
 *
 * 一开始这个路径是写死的，那意味着**测试会往生产那份 `data/logs/story.jsonl` 里写**。
 * 世界书早就用环境变量解决了这件事（`DSH_WORLDBOOK_AUDIT`），我照抄漏了。
 *
 * @returns {string|null} 日志路径；解析不出来时为 null。
 */
export function storyLogFile() {
  const override = process.env.DSH_STORY_AUDIT;
  if (typeof override === 'string' && override.trim() !== '') return override;
  return dataPath('./data/logs/story.jsonl');
}

/**
 * 留痕。
 *
 * ## 为什么要有它
 *
 * 世界书那边每轮记 `hits / sent / dropped` 到 `data/logs/worldbook.jsonl`。
 * **剧情这条本来没有日志 —— 也就是说它注没注、注了哪一块，从外面看不出来。**
 *
 * 而第 4 件要的验收是「她说出的细节在世界书里没有、只在原文里」。**那条判据要人看，
 * 但前提是知道该看哪几轮。** 这份日志就是那个前提：它把「这一轮给了她哪一段」记下来，
 * 之后对着回答比就行。
 *
 * ## 不记对方说了什么
 *
 * 只记**指纹**（query 的 sha256 前 12 位）。和世界书那边同一条纪律 ——
 * 日志是用来对账的，不是用来存聊天记录的。
 *
 * @param {object} hit - `pick()` 的结果。
 * @param {string} query - 这一轮的提问，只取指纹。
 * @param {string} session - 会话标识。
 * @returns {void}
 */
function writeLog(hit, query, session = '') {
  try {
    const file = storyLogFile();
    if (file === null) return;
    mkdirSync(dirname(file), { recursive: true });
    // 超过上限就砍掉旧的一半。**世界书是 2 MB，照它** —— 一开始这里没有上限，
    // 日志会一直长下去。
    try {
      if (statSync(file).size > LOG_MAX_BYTES) {
        const lines = readFileSync(file, 'utf8').split('\n');
        writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join('\n'));
      }
    } catch {
      /* 文件还不存在，或者读不动 —— 直接追加就好 */
    }
    appendFileSync(file, `${JSON.stringify({
      at: new Date().toISOString(),
      // 会话标识 —— 世界书那份有，照它加上。**没有它的话，日志分不清
      // 「刚才聊的那轮」和「昨天测试留下的那轮」**，而验收正是要对着某一轮看。
      session,
      fp: createHash('sha256').update(query).digest('hex').slice(0, 12),
      id: hit.doc.id,
      chapter: hit.doc.chapter,
      node: hit.doc.node,
      score: Number(hit.score.toFixed(4)),
      chars: String(hit.doc.text ?? '').length,
      // 重发的也记 —— 对着日志看的那几轮里，「这一段其实是重复给的」是重要信息。
      escalated: hit.escalated === true
    })}\n`, 'utf8');
  } catch {
    // 记不上不能让这一轮失败。
  }
}

/**
 * 挂载剧情检索。
 *
 * @param {object} ctx - 预设级 Cordis 上下文。
 * @returns {void}
 */
export function apply(ctx) {
  /**
   * 这一份注册自己的「最近给过」表。
   *
   * ⚠️ **不能放在模块级。** 第一版就是模块级的，而测试跑在同一个进程里 ——
   * 前一个用例给过的块会漏进后一个用例，于是「留痕写临时文件」那条因为拿到
   * 不同的块而失败。**那不是测试的问题，是状态放错了地方。**
   *
   * 每个挂载点一份，语义也更对：窗口是「这一场会话里最近给过什么」。
   */
  const recent = new Map();

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') return decision;
    try {
      const list = Array.isArray(payload?.messages) ? payload.messages : [];
      let query = '';
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const m = list[i];
        if (m === null || typeof m !== 'object' || m.role !== 'user') continue;
        if (m.source?.kind === 'plugin') continue;
        const parts = Array.isArray(m.content) ? m.content : [];
        const text = parts
          .filter((p) => p !== null && typeof p === 'object' && p.type === 'text')
          .map((p) => String(p.text ?? ''))
          .join('')
          .trim();
        if (text !== '') {
          query = text;
          break;
        }
      }
      if (query === '') return decision;

      const hit = pick(load(), query, recent);
      if (hit === null) return decision;

      // 先记后发 —— 记不上也要发，所以写日志在拼消息之前，但不影响它。
      writeLog(hit, query, String(payload?.agent?.id ?? ''));

      return {
        kind: 'enter',
        messages: [...decision.messages, {
          id: `${SOURCE.kind}:${Date.now()}`,
          role: 'user',
          content: [{ type: 'text', text: render(hit) }],
          source: SOURCE
        }]
      };
    } catch {
      // 注入失败不能让这一轮整个失败。
      return decision;
    }
  });
}
