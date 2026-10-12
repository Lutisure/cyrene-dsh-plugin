/**
 * 报账 —— 世界书给了什么，她到底用没用上。纯函数层。
 *
 * ## 这一步要回答的问题
 *
 * 世界书每轮注入两三条设定，但**没有任何东西知道它们有没有起作用**。
 * 没有它，淘汰「给了但从没用上」的条目只能靠感觉 —— 而一百多条里
 * 哪些是死的、哪些是白给，感觉不出来。（条数别写死：现在 122 条，
 * 每加一条这里就会过期一次。）
 *
 * ## 三道关，一道比一道虚，所以要分开报
 *
 * | 层 | 断言 | 可信度 |
 * |---|---|---|
 * | ① 有没有命中 | `hits` 里有它 | **确定**（选择器自己的记录） |
 * | ② 有没有送出去 | `sent` 里有它 | **确定** |
 * | ③ 有没有被用上 | 她说的和条目里有长串重合 | **估计**，见下 |
 *
 * 第①②层永远可信，因为那是同一份日志里的字面内容。
 * 第③层是代理指标，不是事实 —— 「没检测到引用」**不等于**没用上：
 * 一条讲「关系基调」的条目本来就不含任何会出现在回复里的词。
 *
 * ## 第③层怎么算，以及为什么不是 n-gram 重合率
 *
 * 短 n-gram 重合率在这类文本上没用：中文里「白厄」「她」这种词满篇都是，
 * 扣掉停用词还剩下一堆结构性重合，测出来的是「两段中文长得像」，不是「她在引用」。
 *
 * 这里找的是**最长公共子串（LCS）的连续长度**，并且只认**足够长**的那些：
 * 中文里 8 个字连续撞车基本不可能是巧合。阈值分档，报告里写清用了哪一档。
 *
 * 所以输出是「有证据 / 没证据」，不是「用了 / 没用」。
 * 调用方把它当证据用，别当判决用。
 */

/** 分档阈值：连续多少个汉字才算「引用了这一条」。 */
export const CITATION = {
  /** 长串照搬 —— 基本可以当引用看。 */
  quoted: 8,
  /** 中等长度 —— 「像是在说同一件事」。 */
  echoed: 6,
  /** 短串 —— 只是同话题，不算证据。 */
  topical: 4
};

/** 只统计汉字，标点和英文不参与比较（她的条目里有引号、书名号、破折号）。 */
/** 去掉标点、空白、引号，留下可以比较的字符流。 */
export function skeleton(text) {
  return String(text ?? '').replace(/[^\u3400-\u4dbf\u4e00-\u9fffA-Za-z0-9]/gu, '');
}

/**
 * 最长公共**连续**子串 —— 长度和那一段本身一起返回。
 *
 * 一次 DP 同时给 `length` 和 `text`，因为报告里要印出来给人看
 * （「重合的是这 9 个字」比「重合长度 9」有用得多）。
 *
 * 用滚动数组做到 O(min(n,m)) 空间。条目 200 字、回复 2000 字这种量级，
 * 朴素 DP 的 (n+1)×(m+1) 表也撑得住，但没必要。
 *
 * @param {string} a - 已 skeleton 化的串。
 * @param {string} b - 已 skeleton 化的串。
 * @returns {{length: number, text: string}} 最长连续重合。
 */
export function longestCommonSubstring(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (left === '' || right === '') return { length: 0, text: '' };
  // 短的那个做列 —— 记住它在哪一边，最后好切片
  const swapped = left.length > right.length;
  const cols = swapped ? right : left;
  const rows = swapped ? left : right;

  let previous = new Uint32Array(cols.length + 1);
  let current = new Uint32Array(cols.length + 1);
  let best = 0;
  let endAt = 0;

  for (let i = 1; i <= rows.length; i += 1) {
    for (let j = 1; j <= cols.length; j += 1) {
      current[j] = rows[i - 1] === cols[j - 1] ? previous[j - 1] + 1 : 0;
      if (current[j] > best) { best = current[j]; endAt = j; }
    }
    const swap = previous; previous = current; current = swap;
    current.fill(0);
  }
  return { length: best, text: best === 0 ? '' : cols.slice(endAt - best, endAt) };
}

/** 只要长度时的薄封装（热路径上少建一个字符串）。 */
export function longestCommonRun(a, b) {
  return longestCommonSubstring(a, b).length;
}

/**
 * 一条条目在一段回复里的引用证据。
 *
 * @param {string} entryText - 条目正文。
 * @param {string} replyText - 她的回复。
 * @returns {{level: string, run: number, sample: string}} 证据。
 *   `level` 是 `quoted` / `echoed` / `topical` / `none` 之一。
 */
export function citationOf(entryText, replyText) {
  const hit = longestCommonSubstring(skeleton(entryText), skeleton(replyText));
  const level = hit.length >= CITATION.quoted ? 'quoted'
    : hit.length >= CITATION.echoed ? 'echoed'
      : hit.length >= CITATION.topical ? 'topical' : 'none';
  return { level, run: hit.length, sample: hit.text };
}

/**
 * 把审计日志按条目聚合。
 *
 * @param {object[]} records - `data/logs/worldbook.jsonl` 里解析出来的记录。
 * @param {{entries?: object[]}} [book] - 世界书（为了拿到触发词和正文）。
 * @returns {{perEntry: object[], totals: object}} 聚合结果。
 */
export function aggregate(records, book = { entries: [] }) {
  const texts = new Map((book.entries ?? []).map((entry) => [entry.id, entry]));
  const seen = new Map();

  const touch = (id) => {
    if (!seen.has(id)) {
      const known = texts.get(id);
      seen.set(id, {
        id,
        known: known !== undefined,
        triggers: known?.triggers ?? [],
        priority: known?.priority ?? null,
        text: known?.text ?? '',
        hits: 0,
        sent: 0,
        drops: {}
      });
    }
    return seen.get(id);
  };

  let turns = 0;
  let turnsWithSend = 0;
  let turnsWithHit = 0;
  let droppedRecent = 0;
  let droppedOver = 0;
  /** 窗口耗尽的那几轮：这一轮没有新东西可给，只好把刚说过的那批再给一次。 */
  const escalatedTurns = [];
  for (const record of Array.isArray(records) ? records : []) {
    turns += 1;
    const hits = Array.isArray(record?.hits) ? record.hits : [];
    const sent = Array.isArray(record?.sent) ? record.sent : [];
    const dropped = Array.isArray(record?.dropped) ? record.dropped : [];
    const escalated = Array.isArray(record?.escalated) ? record.escalated : [];
    if (sent.length > 0) turnsWithSend += 1;
    if (hits.length > 0) turnsWithHit += 1;
    if (escalated.length > 0) escalatedTurns.push({ turn: record?.turn ?? null, ids: escalated });
    for (const id of hits) touch(id).hits += 1;
    for (const id of sent) touch(id).sent += 1;
    for (const item of dropped) {
      const id = item?.entry?.id ?? item?.id;
      if (typeof id !== 'string') continue;
      const why = String(item?.why ?? item?.reason ?? 'unknown');
      const row = touch(id);
      row.drops[why] = (row.drops[why] ?? 0) + 1;
      if (why === 'recent') droppedRecent += 1;
      else droppedOver += 1;
    }
  }

  // 命中过但从没送出去 —— 这是最该看的那一类：触发了，却永远进不去。
  // 常见成因两个：窗口（刚说过）和阶梯（同优先级被更高的挤掉）。
  const firedNeverSent = [];
  const neverFired = [];
  const sent = [];
  for (const row of seen.values()) {
    if (row.hits > 0 && row.sent === 0) firedNeverSent.push(row);
    else if (row.hits === 0) neverFired.push(row);
    else sent.push(row);
  }

  // 库里存在、但一次都没见过的条目（连命中都没有）
  for (const entry of book.entries ?? []) {
    if (!seen.has(entry.id)) {
      neverFired.push({
        id: entry.id,
        known: true,
        triggers: entry.triggers ?? [],
        priority: entry.priority ?? null,
        text: entry.text ?? '',
        hits: 0,
        sent: 0,
        drops: {}
      });
    }
  }

  const byWeight = (left, right) => right.hits - left.hits || left.id.localeCompare(right.id);
  return {
    perEntry: [...seen.values()],
    sent: sent.sort(byWeight),
    firedNeverSent: firedNeverSent.sort(byWeight),
    neverFired: neverFired.sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0)),
    totals: {
      turns,
      turnsWithHit,
      turnsWithSend,
      entriesInBook: (book.entries ?? []).length,
      entriesSeen: seen.size,
      droppedRecent,
      droppedOver,
      escalatedTurns,
      unknownIds: [...seen.values()].filter((row) => !row.known).map((row) => row.id)
    }
  };
}

/**
 * 把「哪些轮次送了什么」和「那一轮她说了什么」对上。
 *
 * ⚠️ **首选对内容指纹，不是对序号。**
 *
 * 第一版是纯序号对齐（留痕第 N 条配会话里第 N 段回复），而它错得很安静 ——
 * 错的样子正是「所有条目都显示没被引用」。实测（2026-10-10 那个真会话）：
 * 会话里 18 段回复 / 16 条用户文本，留痕只有 6 轮。两个来源的「轮」不是同一个计数，
 * 而且连「谁是用户消息」都不止一种：`source.kind` 有 `user`、`time-context`
 * （框架注入的时间上下文）、`plugin:…`（设定块）三种，后两种都不算「这一轮」。
 * 序号一旦错开一格，后面全部错位。
 *
 * 所以留痕里记下当时那条用户消息的指纹（`fp`，不是原文），这里按同一份规则
 * 从会话日志重算，两边相等的才是同一轮。任何一边多加或少加轮次，
 * 代价只是**那一条对不上**，不会波及别的。
 *
 * 旧留痕没有 `fp`，只能退回序号对齐 —— 那件事会被记在 `stats.fpMissing` 里，
 * 报账的报告要把这个数字印出来。**否则「看起来在工作」和「其实对错位了」
 * 在输出上长得一模一样。**
 *
 * @param {object[]} records - 审计记录（同一会话，按时间顺序）。
 * @param {{turns?: string[], replies?: Map<string, string>, list?: string[]}} replies
 *   - `turns` 是每个「有文本的用户轮」的指纹（按顺序），`replies` 是指纹 → 她说了什么；
 *     兼容旧的 `list`（纯回复数组）。
 * @returns {{rows: object[], stats: object}} 带 `reply` 的记录，和对齐统计。
 */
export function joinReplies(records, replies) {
  const list = Array.isArray(replies) ? replies
    : (Array.isArray(replies?.list) ? replies.list : null);
  const map = replies instanceof Map ? replies : (replies?.replies ?? null);
  const turns = Array.isArray(replies?.turns) ? replies.turns : null;

  const rows = [];
  const stats = { total: 0, byFingerprint: 0, positional: 0, unmatched: 0, fpMissing: 0 };

  (Array.isArray(records) ? records : []).forEach((record, index) => {
    stats.total += 1;
    const fp = typeof record?.fp === 'string' ? record.fp : '';
    let reply = null;

    if (fp !== '') {
      // ⚠️ **有指纹时不许退回序号。** 指纹对不上只说明「这一条没接上」，
      // 而序号接出来的很可能是**别的一轮的话** —— 那比空着糟得多：
      // 它看起来是一份证据，而证据是会被拿去做决定的东西。
      if (map !== null && map.has(fp)) { reply = map.get(fp); stats.byFingerprint += 1; }
      else stats.unmatched += 1;
    } else {
      // 旧留痕没有 fp，只能按顺序对。这件事要记在 stats 里并被报告印出来 ——
      // 「看起来在工作」和「其实对错位了」在输出上长得一模一样。
      stats.fpMissing += 1;
      const positional = list !== null
        ? list[index]
        : (turns !== null && map !== null ? map.get(turns[index]) : undefined);
      if (typeof positional === 'string') { reply = positional; stats.positional += 1; }
      else stats.unmatched += 1;
    }
    rows.push({ ...record, reply });
  });

  return { rows, stats };
}

/** 引用证据按条目聚合：这条被送出去过的那些轮里，有几轮留下了引用痕迹。 */
export function scoreUsage(records, book) {
  const texts = new Map((book.entries ?? []).map((entry) => [entry.id, entry.text ?? '']));
  const rows = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const reply = record?.reply;
    for (const id of Array.isArray(record?.sent) ? record.sent : []) {
      if (!rows.has(id)) rows.set(id, { id, sentWithReply: 0, quoted: 0, echoed: 0, topical: 0, none: 0, samples: [] });
      const row = rows.get(id);
      if (typeof reply !== 'string' || reply.trim() === '') continue;
      row.sentWithReply += 1;
      const evidence = citationOf(texts.get(id) ?? '', reply);
      row[evidence.level] += 1;
      if ((evidence.level === 'quoted' || evidence.level === 'echoed') && row.samples.length < 3) {
        row.samples.push(evidence.sample);
      }
    }
  }
  return [...rows.values()].sort((left, right) => right.quoted + right.echoed - (left.quoted + left.echoed));
}
