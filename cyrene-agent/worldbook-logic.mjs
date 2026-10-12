/**
 * Worldbook matching — pure functions, no DSH API.
 *
 * Keeping this layer free of any harness import is deliberate: the matching rules
 * are where the bugs live, and they can be exercised exhaustively in unit tests
 * without a session, a browser or a model. `worldbook.mjs` holds the thin
 * injection layer that does touch DSH.
 *
 * The shape of the problem, and why the two halves are injected differently:
 *
 *  - **Always-on entries** are stable and do not depend on what the user just
 *    said, so they can go through `systemPrompt.context()`.
 *  - **Triggered entries** need the current message. They *cannot* go through
 *    `context()`: assembly runs before the user message is appended to the
 *    session, so a keyword match there reads a conversation that does not yet
 *    contain the question — and when the block comes back empty,
 *    `renderContextSections()` drops the whole section with no error anywhere.
 *    That failure is invisible in snapshots and in the UI. They go through
 *    `agent/pre-step` instead, whose `messages` argument *is* this turn's input.
 */

/** Fallback cap on how much lore one turn may carry, in characters. */
export const DEFAULT_BUDGET = 1400;

/** Fallback cap on how many entries one turn may carry. */
export const DEFAULT_LIMIT = 3;

/**
 * 排序时 `priority` 占的权重（激活度占剩下的 `1 - w`）。
 *
 * ⚠️ **这是我们定的，不是从上游来的。** 上游的 `priority` 只当同分 tiebreaker
 * （见 `worldbook.ts:12`），因为它那边有完整的激活度体系。
 * 而这里 `priority` 是**手工调的**（132 条，30–90），那个分布是知识，不能扔。
 *
 * ## 0.95 是怎么来的（2026-10-11 他定的）
 *
 * 拿 38 条问法**当成一场连续对话**跑（`tools/dmae-qna.mjs --sweep`），
 * 比「带激活度」和「不带」的注入结果差多少：
 *
 *     0.80    10 条变（7 条换内容）
 *     0.90     8 条变（4 条换内容）
 *     0.92     7 条变
 *     0.93     6 条变
 *     **0.935    6 条变   ← 现在这个（他 2026-10-11 定的）**
 *     0.94     6 条变
 *     0.95     4 条变（2 条换内容）
 *     0.98     1 条变
 *     1.00     0 条变   ← 对照档：完全不听激活度，而它真的就不听
 *
 * **1.00 那条是这个扫描的自证** —— 它证明整条链是对的，不是它在乱动。
 *
 * ## 0.935 落在一段**平台**上，不是刀尖上
 *
 * `0.93 / 0.935 / 0.94` **三档都是 6 条** —— 而 `0.92` 是 7、`0.95` 是 4。
 * 所以这个数附近动一点点，行为**不会跳**。**这是选它而不是选 0.932 那类数的理由。**
 *
 * （这一段是量出来的，不是推的。**我原来写注释时是先写后量，那次报给你的数是错的。**）
 *
 * ## 想调它的时候
 *
 * 跑 `tools/dmae-qna.mjs --weight <数>` 看代价 —— **别拿「变了几条」当越小越好**，
 * 那里面有一条是**变好**的（问赛飞儿的预言，关着时冒出缇宝那条）。
 *
 * ## ⚠️ 别拿「变了几条」当越小越好
 *
 * 那些变化里有一条是**变好**的（问赛飞儿的预言，关着时冒出了缇宝那条）。
 * **数不是判据，看具体变了什么才是。**
 *
 * ## 试过但没走通的一条路（别重试）
 *
 * 「命中这条自己的第几个触发词」（`owner`）本来想用来压住跨话题的加权 ——
 * 两个位置都不行：放最后轮不到它，放最前面把 `eval.mjs` 从 63/63 打到 52/63。
 * **详见 `rank` 里那段注释。**
 */
export const ACTIVATION_WEIGHT = 0.935;

/**
 * 默认的「刚说过」窗口 —— **2 分钟**。
 *
 * ⚠️ 这里踩过两轮，都记下来：
 *   ① 最早是「最近 N 条记录」→ 死锁（没新记录窗口就不前进）。
 *   ② 后来是「2 轮」→ 轮号做锚点会在重启/热重载后错乱，
 *      那些条目被**无限期**当成「刚说过」。
 *   ③ 现在是墙上时间。**2 分钟**这个值是有意的：它只用来挡「同一轮对话里
 *      紧接着又问一遍」，而不是挡「五分钟后再聊起同一个人」——
 *      后者本来就该重新给（人也是这样的）。
 *
 * 窗口挡掉之后**不是没有兜底**：一条新的都没进来时，`explainEntries` 会把
 * 窗口里排名最高的两条升上来（见 `ESCALATE_LIMIT`）。
 * 所以「问第二遍拿不到东西」这件事不该再发生。
 */
export const DEFAULT_WINDOW_MS = 2 * 60 * 1000;

/**
 * 窗口耗尽时，最多从窗口里捞几条上来。
 *
 * 比 `DEFAULT_LIMIT` 小是刻意的：留一个位置给真正新的条目，
 * 免得整轮都变成复读。
 */
export const ESCALATE_LIMIT = 2;

/**
 * Normalise for matching: lower case, and full-width forms folded to ASCII.
 *
 * A user typing 星穹鐵道 (traditional) or with full-width punctuation should
 * still hit the same entry as 星穹铁道.
 * @param {unknown} value - the raw text.
 * @returns {string} the normalised text.
 */
export function normalise(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\uff01-\uff5e]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/gu, ' ');
}

/** 通配符 `*` 最多吃掉几个字符（不跨句读）。见 `firstHit` 里的说明。 */
export const WILDCARD_GAP = 12;

/**
 * `*` 允许吃掉的字符：**只挡句末句读，不挡句内停顿**。
 *
 * 归一化会把全角标点折成 ASCII，所以 `。` 到场时已经变成 `.` —— 两种都要挡。
 *
 * ⚠️ 这里踩过一次：第一版把顿号和逗号（`、，`）也挡掉了，于是
 * `白厄*孤独` 匹配不上「白厄**，**好像一直很孤独」—— 而逗号是同一句话内部的停顿，
 * 不是边界。**挡多了和挡少了都是 bug，只是挡多了那种更难发现**：
 * 它表现为「触发词写了却好像不生效」。
 */
const GAP = `[^。．.！!？?；;\\n]{0,${WILDCARD_GAP}}`;

/**
 * 把一条触发词编译成两种形式。
 *
 * 没有 `*` 的走 `indexOf`（快，而且不做任何转义处理 —— 触发词里本来就可能有
 * `.` `(` 这种正则元字符，拿去当正则会静默改变含义）。有 `*` 的才建正则，
 * 其余字符全部转义，这样「怎么写就怎么匹配」。
 *
 * ⚠️ **写坏的触发词返回「永不匹配」，不返回空串。** 空串配 `indexOf` 恒等于 0 ——
 * 也就是**每一句话都命中**。这个 bug 安静得可怕：条目会出现在每一轮里。
 *
 * @param {string} trigger - 原始触发词。
 * @returns {{needle: string|null, pattern: RegExp|null}} 两种形式之一；
 *   写坏时两者都是 null，表示这一条触发词作废。
 */
export function compileTrigger(trigger) {
  const text = String(trigger ?? '');
  // `*` 单独一条、连着写两个、或者整条是空的 —— 那都是「匹配任何东西」，
  // 比没有触发词还糟。作废掉，别让它进选择器。
  if (text === '' || text.includes('**') || text === '*') return { needle: null, pattern: null };
  if (!text.includes('*')) return { needle: text, pattern: null };
  const parts = text.split('*');
  if (parts.some((part) => part === '')) return { needle: null, pattern: null };
  const escaped = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join(GAP);
  try {
    return { needle: null, pattern: new RegExp(escaped, 'u') };
  } catch {
    return { needle: null, pattern: null };
  }
}

/**
 * Validate one entry, dropping the parts that cannot be used.
 *
 * A malformed entry is skipped rather than thrown on: a worldbook is data, and
 * one bad row should not take down every session that touches the preset.
 *
 * @param {unknown} raw - the parsed entry.
 * @param {number} index - its position, for the warning.
 * @returns {{entry: object|null, problem: string|null}} the result.
 */
export function normaliseEntry(raw, index, { requireTriggers = true } = {}) {
  if (raw === null || typeof raw !== 'object') {
    return { entry: null, problem: `entry ${index} is not a mapping` };
  }
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : null;
  if (id === null) return { entry: null, problem: `entry ${index} has no id` };

  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (text === '') return { entry: null, problem: `${id} has no text` };

  const rawTriggers = Array.isArray(raw.triggers) ? raw.triggers : [];
  const triggers = rawTriggers
    .filter((trigger) => typeof trigger === 'string' && trigger.trim() !== '')
    .map((trigger) => trigger.trim());
  // Always-on entries have nothing to trigger on — they ride in the system
  // prompt unconditionally, so demanding triggers of them is a validation bug.
  if (requireTriggers && triggers.length === 0) return { entry: null, problem: `${id} has no triggers` };
  // 触发词里 `*` 用错位置（`*` 单独一条、`甲**乙`）会让它变成「匹配任何东西」——
  // 空串配 `indexOf` 恒等于 0，也就是**每一句话都命中**。报出来，别让它静默污染每一轮。
  // 整条条目作废，不做「丢掉坏的那条触发词、留着好的」那种补救：那两类行为
  // 在报告里长得一样，而它们的严重程度差一个量级。**要人看一眼、改数据。**
  if (triggers.some((trigger) => trigger === '*' || trigger.includes('**'))) {
    return { entry: null, problem: `${id} has a wildcard-only trigger ("*" or "**")` };
  }

  const compiled = triggers.map(compileTrigger);

  // ⚠️ **写了触发词，但没有一条能匹配上任何话。**
  //
  // 这比「没写触发词」坏 —— 没写的那条上面已经拦了，而这一条**看起来是配好的**。
  //
  // 上游 `prompts/worldbook/_glossary.md` 就是这个病：15 组称谓映射，
  // 作者按常驻写的、解析器按不常驻读，**一条都进不去，而中间没有任何东西报错**。
  // 2026-10-11 拿照着解析器写的等价实现跑真文件才发现。
  //
  // **一个文件，两种理解，静默地谁也不知道。**
  if (triggers.length > 0 && compiled.every((item) => item.needle === null && item.pattern === null)) {
    return { entry: null, problem: `${id} has triggers but none of them can match anything` };
  }

  const priority = Number.isFinite(raw.priority) ? Number(raw.priority) : 0;
  return {
    entry: {
      id,
      triggers,
      priority,
      text,
      // Pre-normalised triggers, so matching does not re-normalise on every turn.
      needles: compiled.filter((item) => item.needle !== null).map((item) => normalise(item.needle)),
      // 带 `*` 的那些走正则：名字和方面之间能插进去的东西太多，见 firstHit 的说明。
      patterns: compiled
        .filter((item) => item.pattern !== null)
        .map((item) => new RegExp(item.pattern.source, 'u')),
      // ── 命中归属：命中的是**这条自己的第几个触发词** ──────────────────
      //
      // ⚠️ `needles` 是**过滤过**的（带 `*` 的走 `patterns`），所以它的下标
      //    和 `triggers` 对不上。要还原「第几个」就得另存一份平行的索引 ——
      //    **不能用 `needles.indexOf(...)` 反推**，那会给出一个看着正常、实际错位的数。
      //
      // 为什么需要它（2026-10-11）：问「讲讲那刻夏」时，这七条都被命中：
      //
      //     anaxa-sister   p60   ["**那刻夏**", "阿那克萨戈拉斯", "姐姐", "眼睛"]
      //     castorice-did  p60   ["遐蝶", "督战圣女", "阿蒙内特", "**那刻夏**"]
      //                                            ↑ 第四个才轮到
      //
      // **`anaxa-*` 那几条「那刻夏」都是第一个；而 `castorice-did` 是第四个。**
      // 「这条主要是讲谁的」本来就在数据里 —— **写在触发词的顺序里。**
      //
      // 它和 `priority`（谁先出现）、`intrinsicValue`（忘得多慢）都不是一回事：
      // **这是「归属」** —— 第三个维度。
      needleOwner: compiled
        .map((item, index) => (item.needle === null ? null : index))
        .filter((index) => index !== null),
      patternOwner: compiled
        .map((item, index) => (item.pattern === null ? null : index))
        .filter((index) => index !== null),
      // ── 长期价值基准（可选）────────────────────────────────────────
      //
      // ⚠️⚠️ **这个字段必须显式带过去，漏了它不会报错。**
      //
      // 2026-10-11 往 `entries.yaml` 写了 132 行 `intrinsicValue`，脚本报「写入 132 条」、
      // diff 也是 +132/-0 —— **而它是空的**：这里没把它复制进编译后的条目，
      // 于是 `effectiveValue()` 永远看不到它，底座照样从 `priority` 推。
      //
      // 是**去查底座的实际值**才发现的（`amphoreus` 的 iv 写 90，底座却是 30.0）。
      // **「文件里有那 132 行」不等于「它生效了」。**
      //
      // 这已经是这一趟第三次栽在同一族上（`keywords`/`needles`、`linkTriggers`）。
      // 那一族的共同点：**字段在两头各有各的名字，而中间那一步没人检查。**
      intrinsicValue: Number.isFinite(raw.intrinsicValue) ? Number(raw.intrinsicValue) : undefined,
      linkTriggers: Array.isArray(raw.linkTriggers)
        ? raw.linkTriggers.map((word) => String(word).trim()).filter((word) => word !== '')
        : []
    },
    problem: null
  };
}

/**
 * Build a worldbook from a parsed document.
 * @param {unknown} document - `{ always?: object[], entries?: object[] }`.
 * @returns {{always: object[], entries: object[], problems: string[]}} the book.
 */
export function buildWorldbook(document) {
  const source = document !== null && typeof document === 'object' ? document : {};
  const always = [];
  const entries = [];
  const problems = [];

  for (const [index, raw] of (Array.isArray(source.always) ? source.always : []).entries()) {
    const { entry, problem } = normaliseEntry(raw, index, { requireTriggers: false });
    if (entry === null) problems.push(`always: ${problem}`);
    else always.push(entry);
  }
  for (const [index, raw] of (Array.isArray(source.entries) ? source.entries : []).entries()) {
    const { entry, problem } = normaliseEntry(raw, index);
    if (entry === null) problems.push(`entries: ${problem}`);
    else entries.push(entry);
  }
  // 锚点：每一轮无条件追加，走 `agent/pre-step` 的 `role: "user"` 通道。
  //
  // ⚠️ 它**不放进 `always`**。`always` 由 `persona.mjs` 拼进正文，也就是系统提示词 ——
  // 而 ContextEcho（arXiv:2605.24279v2）测过两种放置，系统提示词那一种更弱
  // （Sonnet 4.5 上 2.57 对 3.00）。它自己的解释是：模型把近期的 user/assistant
  // 交换看得比静态提示词更有行为显著性。所以锚点走 user 通道，和命中块同一条路。
  //
  // 缺这个键时给空串，`worldbook.mjs` 把空串当成「没有锚点」。
  const anchor = typeof source.anchor === 'string' ? source.anchor.trim() : '';
  return { always, entries, anchor, problems };
}

/**
 * Which triggers fire for a message, and where they first appear.
 *
 * Position matters for ranking: an entry whose trigger is mentioned early is
 * more likely to be what the message is about than one name-dropped at the end.
 *
 * ## 通配符：`*`
 *
 * 触发词里可以写 `白厄*孤独` —— `*` 匹配 0~12 个字符，**不跨句读**（`。！？；\n` 都算边界）。
 * 为什么需要它：这个名字 + 那个方面 的问法，中间能插进去的东西太多 ——
 * 实测「白厄是不是很孤独」「白厄真的很孤独吗」「白厄为什么这么孤独」是三种不同的串。
 * 只写 `白厄孤独` 三个变体全漏；而只写 `孤独` 又会在问别人时响（跨角色误伤）。
 *
 * 0~12 这个上限是有意的：`{0,12}` 在一个 30 字的问题里覆盖「是不是很」「为什么这么」
 * 这类插语，但不会一路吃到下一句去。**放宽它等于让触发词变成一个很弱的条件。**
 *
 * @param {object} entry - a normalised entry.
 * @param {string} haystack - the already-normalised message.
 * @returns {number} the earliest index, or -1 when nothing matched.
 */
export function firstHit(entry, haystack) {
  let best = -1;
  for (const needle of entry.needles) {
    const at = haystack.indexOf(needle);
    if (at !== -1 && (best === -1 || at < best)) best = at;
  }
  if (best !== -1) return best;
  for (const pattern of entry.patterns ?? []) {
    const match = pattern.exec(haystack);
    if (match !== null && (best === -1 || match.index < best)) best = match.index;
  }
  return best;
}

/**
 * 和 `firstHit` 一样，但**多告诉我们命中的是这条自己的第几个触发词**。
 *
 * ## 它回答的是「这条主要是讲谁的」
 *
 * 问「讲讲那刻夏」，七条都被命中 —— 里面的差别不在 `priority`
 * （`anaxa-sister` 和 `castorice-did` 都是 60），也不在「触发词在问题里的位置」
 * （三条都在「那刻夏」那两个字上）：
 *
 *     anaxa-sister   ["**那刻夏**", "阿那克萨戈拉斯", "姐姐", "眼睛"]      第 1 个
 *     castorice-did  ["遐蝶", "督战圣女", "阿蒙内特", "**那刻夏**"]        第 4 个
 *
 * **「这条是为了谁写的」写在触发词的顺序里。** 越靠前，越是专门为它写的。
 *
 * ## 和另外两个维度不是一回事
 *
 *     priority        谁先出现在候选里
 *     intrinsicValue  忘得多慢
 *     **归属**        这条主要是讲谁的        ← 这个
 *
 * @param {object} entry - 一条条目。
 * @param {string} haystack - 已经归一化过的消息。
 * @returns {{at: number, owner: number}} `at` 同 `firstHit`；`owner` 是第几个触发词
 *   （从 0 数），没命中时是 -1。
 */
export function hitDetail(entry, haystack) {
  let best = -1;
  let owner = -1;

  const needles = entry.needles ?? [];
  const needleOwner = entry.needleOwner ?? [];
  for (const [i, needle] of needles.entries()) {
    const at = haystack.indexOf(needle);
    if (at === -1) continue;
    // 比的是**位置**（谁在问题里出现得更早）；位置打平才看谁的触发词更靠前。
    const mine = needleOwner[i] ?? i;
    if (best === -1 || at < best || (at === best && mine < owner)) {
      best = at;
      owner = mine;
    }
  }

  const patterns = entry.patterns ?? [];
  const patternOwner = entry.patternOwner ?? [];
  for (const [i, pattern] of patterns.entries()) {
    const match = pattern.exec(haystack);
    if (match === null) continue;
    const mine = patternOwner[i] ?? needles.length + i;
    if (best === -1 || match.index < best || (match.index === best && mine < owner)) {
      best = match.index;
      owner = mine;
    }
  }

  return { at: best, owner: best === -1 ? -1 : owner };
}

/**
 * Work out which entries fire for this message, and why the rest did not.
 *
 * This is the single source of truth for selection: `selectEntries` is a thin
 * wrapper over it. Splitting them was deliberate — the audit log has to say the
 * same thing the selector did, and two implementations of the same ranking would
 * drift apart the first time one of them was edited.
 *
 * ## ⚠️ 窗口耗尽的兜底（2026-10-10 加）
 *
 * 去重窗口从「几轮」改成「几分钟」之后，多出一个失效方式：**窗口里全被挡住，
 * 这一轮就什么都不给。** 而「一个人拆 6 条、分两轮给完」这个设计本意就是
 * 让人连问同一个话题时**总有东西可给**（见 entries.yaml 表头）。
 * 「十分钟内问第二遍 → 一个字都不给」把那条设计弄成了空话。
 *
 * 所以：如果**窗口内一条都没放进来**，就把窗口里那批**排名最高的
 * `ESCALATE_LIMIT` 条**放进去，并在 `dropped` 里标成 `window-exhausted`
 * 而不是 `recent` —— 留痕要能分辨「因为刚说过而没给」和
 * 「因为刚说过、但没别的可给了，只好再说一次」。
 *
 * 上限比 `limit` 小（2 < 3）是刻意的：留下一个位置给真正新的条目，
 * 免得整轮都变成复读。
 *
 * @param {object[]} entries - normalised entries.
 * @param {string} message - the current user message, raw.
 * @param {{limit?: number, budget?: number, skip?: Set<string>}} [options] - caps and already-sent ids.
 * @returns {{chosen: object[], hits: object[], dropped: object[], escalated: object[]}} the decision and its reasoning.
 *   `hits` is every entry whose trigger fired, in rank order; `dropped` records the
 *   ones that were not injected and the rule that stopped each of them.
 *   `escalated` is the subset that got in **because** the window left nothing else.
 */
export function explainEntries(entries, message, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : DEFAULT_LIMIT;
  const budget = Number.isFinite(options.budget) ? options.budget : DEFAULT_BUDGET;
  const skip = options.skip instanceof Set ? options.skip : new Set();
  const haystack = normalise(message);
  if (haystack.trim() === '') return { chosen: [], hits: [], dropped: [], escalated: [] };

  // 命中的分两组：还在去重窗口里的，和可以进的。前者也记下来 ——
  // 「问了她却没提」最常见的原因就是它，不记就没法回答。
  const recent = [];
  const hits = [];
  for (const entry of entries) {
    const detail = hitDetail(entry, haystack);
    if (detail.at === -1) continue;
    // `owner` = 命中的是这条自己的第几个触发词。**越靠前，这条越是专门为它写的。**
    const hit = { entry, at: detail.at, owner: detail.owner };
    if (skip.has(entry.id)) recent.push({ ...hit, reason: 'recent' });
    else hits.push(hit);
  }

  // ── 连带触发 ──────────────────────────────────────────────────────
  //
  // 有些关联是**「顺便」，不是「这次聊到了」**：提到甲的时候顺带知道乙 ——
  // 而乙不该因此被记成「对方问了乙」。
  //
  // 上游 `worldbook.ts:16` 把它叫「连带触发词（One-Shot 一次性）」。
  //
  // ## 三条规矩
  //
  // **一、一层封顶。** 只看**被直接命中的**那些（`hits` + `recent`），
  //     带出来的那些**不再往下带** —— 否则一条链能滚出整个世界书。
  //
  // **二、它不占「对方聊到了」的名额。** 所以单独返回 `linked`，
  //     **不混进 `hits`** —— 调用方要把它们排除在 `hitIds` 之外
  //     （见 `worldbook.mjs` 里那一段），否则一次顺带就把它养熟了。
  //
  // **三、已经命中的不再算连带。** 免得同一条既在 `hits` 又在 `linked`，
  //     而两边的「算不算聊到」正好相反。
  //
  // ⚠️ **一条条目都没写 `linkTriggers` 时，这一段整个跳过 —— 行为逐字不变。**
  //    那份 39 条问法的注入基线靠这个原地不动。
  // ⚠️ **不假定这个字段一定在。** `buildWorldbook` 编译出来的条目一定有，
  //    但 `explainEntries` 是个公开函数，手搓的条目（测试、工具）可能没有 ——
  //    而直接读 `.length` 会炸。
  //
  //    2026-10-11 就这么炸的，5 条测试红。**和 `keywords` / `needles` 那次
  //    是同一个家族：假定某个字段一定在。** 那一族的错都不报错，或者报在很远的地方。
  const linksOf = (entry) => (Array.isArray(entry.linkTriggers) ? entry.linkTriggers : []);

  const linked = [];
  if (entries.some((entry) => linksOf(entry).length > 0)) {
    const taken = new Set([...hits, ...recent].map((item) => item.entry.id));
    for (const { entry, at } of [...hits, ...recent]) {
      for (const word of linksOf(entry)) {
        const needle = normalise(word);
        if (needle === '') continue;
        for (const other of entries) {
          if (taken.has(other.id)) continue;
          if (!other.needles.some((own) => own.includes(needle))) continue;
          taken.add(other.id);
          linked.push({ entry: other, at, via: entry.id });
        }
      }
    }
  }

  // Higher priority first; ties broken by the earlier mention, then by id so the
  // order is stable rather than dependent on document order.
  //
  // ── 2026-10-11：激活度接进来 ──────────────────────────────────────
  //
  // 原来这里只有 `priority`。现在多一维：**一条设定「最近有没有被聊到」。**
  //
  // 要解决的那类问题：问「那刻夏是谁」，`anaxa-creed`（他不信泰坦那条）
  // 内容对得上，却因为 `priority` 排不到前三而没被注入。
  // **一条设定该不该想起来，和它「重不重要」是两件事。**
  //
  // ## 为什么是「加权」而不是「替换」
  //
  // 本地的 `priority` 是**手工调的**（132 条，30–90，中位 60）——
  // 那个分布本身就是知识。替换掉它等于把那部分知识扔了。
  //
  // 所以两个维度都留，`ACTIVATION_WEIGHT` 定谁说话大声：
  //
  //     score = priority 归一化 × w  +  activation 归一化 × (1 - w)
  //
  // **`w` 默认 0.8 —— 先让激活度只当边缘情况的偏置。**
  // 一上来就一半，等于同时改了两件事、出了问题分不清是谁。
  // 跑一阵看数据再放开，那才是可调的。
  //
  // ## ⚠️ 不传 `activations` 时行为**逐字不变**
  //
  // 这是刻意的：那份 39 条问法的注入基线（`tools/dmae-baseline.mjs`）
  // 必须原地不动，否则改动前后没法对照。**没有状态 = 退回纯 priority 排序。**
  const weights = options.activations instanceof Map ? options.activations : null;
  const w = Number.isFinite(options.activationWeight) ? options.activationWeight : ACTIVATION_WEIGHT;
  const score = (hit) => {
    if (weights === null) return 0;
    const a = weights.get(hit.entry.id);
    if (!Number.isFinite(a)) return 0;
    const p = Number.isFinite(hit.entry.priority) ? hit.entry.priority : 0;
    return (p / 100) * w + (a / 100) * (1 - w);
  };

  const rank = (left, right) => {
    // 有状态才比这一层；没状态时 `score` 两边都是 0，等于不存在。
    const sl = score(left);
    const sr = score(right);
    if (sl !== sr) return sr - sl;
    if (right.entry.priority !== left.entry.priority) return right.entry.priority - left.entry.priority;
    if (left.at !== right.at) return left.at - right.at;

    // ── 归属（命中的是这条自己的第几个触发词）—— ⚠️ 这里**放不住** ────
    //
    // 2026-10-11 试过两个位置，**两个都不行**：
    //
    //   **放最后**（这里）：一件事没改。因为 `score` 排在前面，两条分数不同时
    //     它根本轮不到 —— 放开到 0.98 权重，串味那条照样挤进来，扫描数字一个没动。
    //     **一个「加了但没生效」的排序层，和「没加」在报告里长得一样。**
    //
    //   **放最前面**：`eval.mjs` 从 **63/63 掉到 52/63**，红的是这些 ——
    //     「问『你觉得怎么样』给看法那条」「问白厄和你有什么不同」
    //     「追问『其他黄金裔呢』名单仍然在」「每条条目都有触发词能把它检索出来」…
    //     **它把一堆「专门写的条目」压到了「顺带提到的条目」后面。**
    //
    // 所以它现在**只是一个记录**：`owner` 照算、`hitDetail` 照给，
    // **但不参与排序**。要让它真的起作用，得先想清楚它和 `priority` 到底谁大 ——
    // 而数据说「不一定」：`view-*` 那十五条的触发词就是问题本身的措辞，
    // owner 永远是 0；而 `goldens-roster` 那种名单型条目 owner 也低。
    // **两个方向都有反例，所以不该由这一层一刀切。**
    if (left.owner !== right.owner) return left.owner - right.owner;

    return left.entry.id.localeCompare(right.entry.id);
  };
  hits.sort(rank);
  recent.sort(rank);
  linked.sort(rank);

  const chosen = [];
  const dropped = [...recent];
  let spent = 0;
  const take = (hit, reason) => {
    if (chosen.length >= limit) { dropped.push({ ...hit, reason: `over-limit${reason === undefined ? '' : `-after-${reason}`}` }); return false; }
    if (spent + hit.entry.text.length > budget) { dropped.push({ ...hit, reason: 'over-budget' }); return false; }
    spent += hit.entry.text.length;
    chosen.push(hit.entry);
    return true;
  };
  for (const hit of hits) take(hit);

  // 连带带出来的排**直接命中的后面**：它们是「顺便」，不该挤掉「对方真说了的」。
  // 没进去的记 `linked-*` 那个理由 —— 留痕要能分辨
  // 「对方提到了但没给」和「顺带带出来但没给」。
  for (const hit of linked) take(hit, 'linked');

  // 窗口耗尽：一条新的都没进来，只好从窗口里挑（见函数头）。
  const escalated = [];
  if (chosen.length === 0 && recent.length > 0) {
    for (const hit of recent.slice(0, ESCALATE_LIMIT)) {
      if (take(hit, 'escalated')) escalated.push(hit.entry);
    }
    // 升上来的那几条，理由从 `recent` 换成 `window-exhausted`：留痕要能分辨
    // 「因为刚说过而没给」和「因为刚说过、但没别的可给了，只好再说一次」。
    for (const entry of escalated) {
      const row = dropped.find((item) => item.entry.id === entry.id);
      if (row !== undefined) row.reason = 'window-exhausted';
    }
  }

  return { chosen, hits: hits.map((h) => h.entry), dropped, escalated, linked: linked.map((h) => h.entry) };
}

/**
 * Pick the entries worth injecting this turn.
 *
 * Ranked by priority, then by how early the trigger appears. Two caps apply,
 * because lore is paid for on every turn it rides along: a count cap and a
 * character budget.
 *
 * @param {object[]} entries - normalised entries.
 * @param {string} message - the current user message, raw.
 * @param {{limit?: number, budget?: number, skip?: Set<string>}} [options] - caps and already-sent ids.
 * @returns {object[]} the chosen entries, in rank order.
 */
export function selectEntries(entries, message, options = {}) {
  return explainEntries(entries, message, options).chosen;
}

/**
 * Render one block of lore.
 * @param {object[]} entries - the entries to render.
 * @param {string} [heading] - the block heading.
 * @returns {string} the text, or an empty string when there is nothing.
 */
export function assembleBlock(entries, heading) {
  const usable = (Array.isArray(entries) ? entries : []).filter(
    (entry) => entry !== null && typeof entry.text === 'string' && entry.text !== ''
  );
  if (usable.length === 0) return '';
  const lines = [heading ?? '【设定】'];
  for (const entry of usable) lines.push('', `· ${entry.text}`);
  return lines.join('\n');
}

/**
 * A session-scoped record of what has already been injected.
 *
 * Triggered lore is appended to the conversation every turn, so without this the
 * same paragraph accumulates once per mention. Only the *triggered* half is
 * remembered: the always-on half is stable by definition and rides in the system
 * prompt, where repetition costs nothing extra.
 *
 * ⚠️ **The window is measured in MINUTES now, and both halves of that are bug fixes.**
 *
 * **第一次修（第 1 轮）**：窗口原来是「最近 N 条记录」。那个版本**死锁** ——
 * 记录只在有东西被选中时才写，而没写记录窗口就不前进，于是同一批 id 永远留在窗口里。
 * 同一个人连问两次之后**永远返回空**，而且一声不响。
 *
 * **第二次修（2026-10-10）**：改成「第几轮」之后，锚点换成了**会话内轮号**，
 * 而它会漂：进程重启/插件重载之后，同一个会话的 `state.turn` 从 1 重新开始，
 * 可 `sent` 里还记着旧编号（比如 8）。一减就是负数，`turn - at > recent` 永远不成立 ——
 * 那几条就被无限期地当成「刚说过」。实测（`data/logs/worldbook.jsonl`，会话 792ca586）：
 * 重启后第 1、2 轮里，`aglaea-who` 一直被标 `recent` 挡着。
 *
 * 现在锚点是**墙上时间**：记下「什么时候发出去的」，看「离现在多久」。
 * 轮号只用来写留痕，不参与判断 —— 于是重启、重载、会话被复用，都不再影响去重，
 * 而且窗口的含义也变回人话：**十分钟内说过的话，不再重复**。
 *
 * 为什么不用「会话历史里有没有这条标记」那种更聪明的办法：那要求把标记文本反解回 id，
 * 多一处协议耦合；而且这个文件是**纯函数层**，不该去读会话。
 *
 * @param {{windowMs?: number, recent?: number, now?: () => number}} [options]
 *   `windowMs` 是「多久之内算已说过」，默认 10 分钟；
 *   `now` 只给测试用，好让时间可以被推着走。
 * @returns {object} the log.
 */
export function createInjectionLog({ windowMs = DEFAULT_WINDOW_MS, now = Date.now } = {}) {
  const sessions = new Map();
  const stateOf = (sessionId) => {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      state = { turn: 0, sent: new Map() };
      sessions.set(sessionId, state);
    }
    return state;
  };
  /** Drop entries that have fallen out of the window, so the map cannot grow forever. */
  const prune = (state) => {
    const edge = now() - windowMs;
    for (const [id, when] of state.sent) {
      if (when < edge) state.sent.delete(id);
    }
  };
  return {
    /**
     * Advance to the next turn. **Call this once per turn, unconditionally** —
     * including turns where nothing ends up being injected. Skipping the call on
     * empty turns is exactly what latched the first version.
     *
     * ⚠️ 它现在**只**负责两件事：记轮号（写留痕用）+ 顺带清理过期条目。
     * 去重判断不再看它 —— 那正是第二个 bug 的来源。
     *
     * @param {string} sessionId - the session key.
     * @returns {number} the new turn number, counting from 1.
     */
    nextTurn(sessionId) {
      const state = stateOf(sessionId);
      state.turn += 1;
      prune(state);
      return state.turn;
    },
    /**
     * The current turn number, for tests and logs.
     * @param {string} sessionId - the session key.
     * @returns {number} the turn.
     */
    turn(sessionId) {
      return sessions.get(sessionId)?.turn ?? 0;
    },
    /**
     * Has this entry already been sent within the window?
     * @param {string} sessionId - the session key.
     * @param {string} id - the entry id.
     * @returns {boolean} true when it should be skipped.
     */
    seen(sessionId, id) {
      const state = sessions.get(sessionId);
      if (state === undefined) return false;
      const when = state.sent.get(id);
      if (when === undefined) return false;
      if (when < now() - windowMs) {
        state.sent.delete(id); // 过期就地清掉，免得 map 一直挂着
        return false;
      }
      return true;
    },
    /**
     * Record the entries sent this turn.
     * @param {string} sessionId - the session key.
     * @param {string[]} ids - the entry ids.
     * @returns {void}
     */
    record(sessionId, ids) {
      if (!Array.isArray(ids) || ids.length === 0) return;
      const state = stateOf(sessionId);
      const at = now();
      for (const id of ids) state.sent.set(id, at);
    },
    /** Drop a session's record, so a reopened conversation can trigger again. */
    forget(sessionId) {
      sessions.delete(sessionId);
    },
    /** How many sessions are being tracked; the tests assert this does not grow. */
    size() {
      return sessions.size;
    }
  };
}
