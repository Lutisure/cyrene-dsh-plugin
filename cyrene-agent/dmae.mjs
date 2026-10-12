/**
 * 世界书的记忆激活与遗忘。
 *
 * ## 这是什么
 *
 * 每一条世界书设定有一个**激活度** `A`，随对话涨落：
 *
 *   聊到了      → 涨（但有闸门压制）
 *   久没聊到    → 落（而且越久落得越快）
 *   落到 0      → 归档；再聊到会被「唤醒」，一次拉回线上
 *
 * **要解决的那类问题**：问「那刻夏是谁」，`anaxa-creed`（他不信泰坦那条）
 * 内容是对得上的，却因为 `priority` 排不到前三而没被注入。
 * 一条设定该不该想起来，和它「重不重要」是两件事。
 *
 * ## 上游出处
 *
 * 算法来自 Cyrene-Agent v1.3.3（`src/main/rag/worldbook.ts` 的 `DmaeManager`），
 * 公式在它的 `docs/specs/2026-08-08-dmae-v5-upgrade-and-l2-working-memory.md` 里
 * 标着 `[V5 §x.y]`。**上游定义的部分，下面每条都标了出处。**
 *
 * ## 一处**没有**跟着上游的
 *
 * 上游的 `A = A_base + A_burst` 在 V5 里存在，但它自己标了
 * 「不作为 5.0 默认实现」（§4.9）。**这里把它实现了**，因为本地世界书
 * 本来就有一个 `priority`（手工调的 30–90），而那正是 `A_base` 该接的东西。
 * 见 `baseFromPriority()`。
 *
 * ## 这个文件里没有 I/O
 *
 * 纯函数。状态存在外面，这个文件只负责算。**所以它可以被单独测透。**
 *
 * @module dmae
 */

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */

/**
 * 一套参数。默认值取自上游 `L2_DMAE_PARAMS` 与 `DEFAULT_DMAE_PARAMS`。
 *
 * ⚠️ **那些数是上游按它那边的对话密度调的，不是推出来的。**
 * 本地一轮的间隔和它不一样，所以这些值应当视作「起点」而不是「定论」——
 * 改动它们要留下记录。
 *
 * @typedef {object} DmaeParams
 * @property {number} maxScore - 激活度上限。
 * @property {number} promptThreshold - 过这条线才算「想起来了」。
 * @property {number} userRewardBase - 用户提到时的基础奖励 B_u。
 * @property {number} wakeGamma - 唤醒增益 γ：静默越久，再被提到时涨得越多。
 * @property {number} modelRewardBase - 模型提到时的基础奖励 B_m。
 * @property {number} wakeLambda - 模型奖励的衰减 λ。
 * @property {number} decayAlpha - 用户静默的衰减系数 α。
 * @property {number} decayBeta - 模型静默的衰减系数 β。
 * @property {number} repeatRho - 重复抑制强度 ρ。
 * @property {number} satPower - 饱和曲线的幂次 p。
 * @property {number} repeatWindow - 重复窗口的轮数。
 * @property {number} wakeBonus - 唤醒时拉到阈值之上多少。
 */

/**
 * 默认参数：**世界书那一套**（上游 `DEFAULT_DMAE_PARAMS`，`worldbook.ts:75-88`）。
 *
 * ⚠️ **别和 L2 那套混。** 上游有两组值，长得像但不一样：
 *
 *     worldbook  DEFAULT_DMAE_PARAMS   userRewardBase 20  modelRewardBase 8  α 1.5  β 0.3
 *     L2         L2_DMAE_PARAMS        userRewardBase 10  modelRewardBase 4  α 1.0  β 0.2
 *
 * **我第一版就混了**：拿 L2 的 10/4，又拿 V5 白皮书的 1.0/0.2，凑出一组
 * 上游任何一处都不存在的数。**这属于「照着抄还抄错」，而且它不会报错** ——
 * 只是行为和你以为的不一样。
 *
 * 而 `decayAlpha` 那 1.5 有个来历值得知道（上游附录 B）：它是**从「8 轮跌破」
 * 反推**出来的，而 §6.4 里那次反推算出来是 1.58，不是 1.5 —— **差额文档没解释。**
 * 所以这个数**本身就不是精确的**，改成 1.0 也没有更对。
 *
 * 上游自己两次强调这些不是结论（`worldbook.ts:43`）：
 *
 *   > 任何参数都只是默认值，不是结论。所有参数以后都通过 Simulator 调整
 *
 * **所以我们沿用上有的值，但在自己的模拟器上重新调一遍** —— 那边的对话密度
 * 和这边不一样。调完把数字和依据写回来。
 *
 * @type {DmaeParams}
 */
export const DEFAULT_PARAMS = {
  maxScore: 100,
  promptThreshold: 30,
  userRewardBase: 20,
  wakeGamma: 0.5,
  modelRewardBase: 8,
  wakeLambda: 0.3,
  decayAlpha: 1.5,
  decayBeta: 0.3,
  repeatRho: 0.5,
  satPower: 2,
  repeatWindow: 6,
  wakeBonus: 5,
  // ⚠️ 这一项**不是上游的**，是我们这里要定的一个语义。
  //    `baseFromPriority` 算出来的 `A_base` 到底管什么，两条路完全不同：
  //       'wake'       它只是**醒来时的高度** —— 没聊到就归档（上游选的）
  //       'permanent'  它是**永久地板** —— 永远掉不到它以下，于是永远在线
  //    详见 `baseFromPriority` 的注释。**两边都实现了，改这一行就换。**
  floorMode: 'wake'
};

/**
 * 一个条目可以携带的、与激活有关的那部分。
 *
 * @typedef {object} DmaeEntry
 * @property {string} id - 条目 id。
 * @property {string[]} keywords - 命中检测用的触发词。空数组 = 不参与。
 * @property {number} [intrinsicValue] - 长期价值基准（**30–90**）。
 *   驱动两样：进场底座 `A_base`（`baseFromPriority`）和抗遗忘能力 `I`
 *   （`resistanceFromPriority`）。**缺省时退回 `priority`。**
 *   上游 `worldbook.ts:15` 的原话是它「参与 Floor 和 Resistance，不参与 Reward」。
 * @property {number} [resistance] - 抗遗忘能力 `I`，**1~4**。`step` 从这儿读，
 *   缺省 1。⚠️ 和 `intrinsicValue` **不是一个量纲** —— 见 `effectiveValue` 的注释。
 * @property {boolean} [enabled] - 关掉的条目不参与。
 * @property {boolean} [permanent] - 常驻条目不参与（它每轮都在，无所谓想起来）。
 */

/**
 * 一个条目的激活状态。
 *
 * @typedef {object} EntryState
 * @property {number} activation - 当前激活度 A。
 * @property {number} userSilence - 用户连续多少轮没提到它。
 * @property {number} modelSilence - 模型连续多少轮没提到它。
 * @property {number[]} recentUserHits - 窗口内用户提到的轮次。
 */

// ── 几个数 ──
//
// `EPSILON` 用在上游那行夹子里，避免 modelReward 恰好等于 decay 时把净变化抹成 0。
// `MIN_INTRINSIC` 是除法的保护：I 为 0 时 sqrt 是 0，会算出 Infinity。
const EPSILON = 1e-9;
const MIN_INTRINSIC = 1;

/**
 * 一个条目的空状态。
 *
 * @returns {EntryState} 三个计数都归零。
 */
export function emptyState() {
  return { activation: 0, userSilence: 0, modelSilence: 0, recentUserHits: [] };
}

/* ------------------------------------------------------------------ *
 * A_base：priority 进场
 * ------------------------------------------------------------------ */

/**
 * 把世界书的 `priority` 换算成激活度的底座 `A_base`。
 *
 * ## 为什么要底座
 *
 * 纯动态的激活度会让「重要但久没提」的条目和「不重要也没提」的条目**长得一样**
 * —— 两条都是 0。而本地的 `priority` 是**手工调的**（132 条，30–90，中位 60），
 * 那个分布本身就是知识，丢掉可惜。
 *
 * ## ⚠️ 它**不是**永久地板（我第一版写错过，模拟器跑出来才发现）
 *
 * 我原来在这段里写的是「聊到了能涨上去，没聊到也掉不到底座以下」——
 * **那句话和实现不符。** `step()` 第一件事是：
 *
 *     if (before === 'archived' && !userHit && !modelHit) return state;
 *
 * 归档的条目**原样返回**，下面所有计算（包括底座那几行）都走不到。
 * 所以一次都没聊到的条目是 **0**，不是 `A_base`。
 *
 * 于是「底座是永久地板，还是只是唤醒的起点」**成了一个要人定的问题**：
 *
 *     永久地板    priority 90 那条永远在线 —— 但那和现在的行为没区别
 *     唤醒起点    冷掉就真想不起来 —— 上游选这个（V5 的 `A_init = 30 + 5`）
 *
 * **现在实现的是后者**，按上游的语义。**改哪一边都是改一行。**
 *
 * ## 映射
 *
 * 本地的 `priority` 实测在 30–90。这里线性映到 `[0.6, 1.4] × promptThreshold`：
 *
 *     30 → 18     总在阈值之下，要被聊到才上得来
 *     90 → 42     醒来就在阈值之上
 *
 * **30 那条故意压在阈值下面** —— 最低优先级的东西本来就不该自己冒出来。
 * **90 那条故意抬到阈值上面** —— 有一条 `priority: 90`，它该是最容易想起来的那个。
 *
 * ⚠️ 那两个倍数（0.6 / 1.4）是**我定的**，不是从上游来的。理由写在上面，
 * 但它们是可调的，而且应当按实际观察再调。
 *
 * @param {number} priority - 条目的 priority。
 * @param {object} [params] - 需要 `promptThreshold`。
 * @returns {number} 底座激活度。
 */
export function baseFromPriority(priority, params = DEFAULT_PARAMS) {
  const p = Number.isFinite(priority) ? priority : 60;
  // 30–90 → 0–1，夹住两端
  const t = Math.min(1, Math.max(0, (p - 30) / 60));
  const factor = 0.6 + t * 0.8;
  return params.promptThreshold * factor;
}

/**
 * 把 `priority` 换算成抗遗忘能力 `I`。
 *
 * 上游那句注释是这么说的：
 *
 *   > 价值决定忘得多慢，而不是爱得多深
 *
 * **`I` 只出现在衰减里，不出现在奖励里** —— 上游特意留了注释解释为什么：
 * 两头都管的话，高价值条目会既涨得快又忘得慢，天然霸榜。
 *
 * 映到 `[1, 4]`：差距不取太大，否则高 priority 的条目几乎永不下线。
 *
 * @param {number} priority - 条目的 priority。
 * @returns {number} 抗遗忘能力。
 */
export function resistanceFromPriority(priority) {
  const p = Number.isFinite(priority) ? priority : 60;
  const t = Math.min(1, Math.max(0, (p - 30) / 60));
  return 1 + t * 3;
}

/**
 * 一条条目的「长期价值基准」—— 驱动**底座**和**抗遗忘**的那个数。
 *
 * ## 为什么不是一个字段就够
 *
 * 上游 `worldbook.ts:15` 把两件事分开：
 *
 *   > `intrinsicValue` —— 长期价值基准（固定）；v3.4 参与 **Floor**（首次激活基线）
 *   > 和 **Resistance**（遗忘抵抗），**不参与 Reward**
 *
 * 而 `priority` 只做排序 tiebreak（`worldbook.ts:12`）。
 *
 * **我们原来是底座和阻力都从 `priority` 推**，于是：
 *
 *     一条「权重很高、但你从不提起」的设定
 *       priority 高 → 底座高 **并且** 阻力大 → **忘得慢**
 *
 * **「重要」和「难忘」成了同义词。** 而上游那句「价值决定忘得多慢，
 * 而不是爱得多深」，说的正是这两个字段分开。
 *
 * ## 名字的来历（踩过，记着）
 *
 * `intrinsicValue` 这个名字在 2026-10-11 之前**被 `I` 占着**（量纲 1~4），
 * 而上游那个 `intrinsicValue` 是 30~90 量纲。同一个名字两种量纲，
 * **接错了不会报错** —— 条目写 `intrinsicValue: 3`，`step` 读它当 `I` ✓，
 * 而 `baseFromPriority(3)` 夹到 30 算出 18 ✗。
 *
 * 所以先把 `I` 那个改名成 **`resistance`**，把名字让出来。
 *
 * ## 不填就退回老行为
 *
 * 132 条现有条目**一条都不用改**：没写 `intrinsicValue` 时拿 `priority` 顶上，
 * 和改动前算出来的数一模一样。哪条该分出来，慢慢填就行。
 *
 * @param {object} entry - 一条条目。
 * @returns {number|undefined} `intrinsicValue`，没写就是 `priority`。
 */
export function effectiveValue(entry) {
  if (entry !== null && typeof entry === 'object' && Number.isFinite(entry.intrinsicValue)) {
    return entry.intrinsicValue;
  }
  return entry?.priority;
}

/* ------------------------------------------------------------------ *
 * 涨与落
 * ------------------------------------------------------------------ */

/**
 * 饱和闸门 `G_sat`（上游 [V5 §5.4]）。
 *
 * `(1 - A/A_max)^p` —— 越接近满分，再提它涨得越少。
 *
 * **没有这个**，一条被反复提起的记忆会一路顶到上限，然后停在那儿不掉，
 * 而那看起来像「它很在意这件事」，其实是算法没刹车。
 *
 * @param {number} activation - 加奖励之前的激活度。
 * @param {DmaeParams} params - 需要 `satPower` 与 `maxScore`。
 * @returns {number} 0–1 的闸门系数。
 */
export function gateSaturation(activation, params = DEFAULT_PARAMS) {
  const ratio = 1 - activation / params.maxScore;
  return Math.pow(Math.max(0, ratio), params.satPower);
}

/**
 * 重复闸门 `G_rep`（上游 [V5 §5.5]）。
 *
 * `1 / (1 + ρ·n_w)` —— 窗口内已经提过 `n_w` 次，这一次的收益打折。
 *
 * **和饱和的区别**：饱和管「它总体多热」，这个管「刚才有没有连着提」。
 * 连着追问同一个话题时，第二条的效果本来就该小一些。
 *
 * @param {number} recentHitCount - 窗口内的提起次数。
 * @param {DmaeParams} params - 需要 `repeatRho`。
 * @returns {number} 0–1 的闸门系数。
 */
export function gateRepeat(recentHitCount, params = DEFAULT_PARAMS) {
  return 1 / (1 + params.repeatRho * Math.max(0, recentHitCount));
}

/**
 * 用户提起时的有效奖励 `Ru*`（上游 [V5 §5.6]）。
 *
 * `B_u × (1 + γ·ln(1 + U_old)) × G_sat × G_rep`
 *
 * 中间那一项是**唤醒增益**：`U_old` 是它被冷落了多少轮。
 * **冷落越久，再被提起时涨得越多** —— 这是「久别重逢」那一笔。
 *
 * @param {object} ctx - 上下文。
 * @param {number} ctx.activation - 加奖励前的激活度。
 * @param {number} ctx.userSilence - 加奖励前它被用户冷落的轮数。
 * @param {number} ctx.recentHitCount - 窗口内的提起次数。
 * @param {DmaeParams} [params] - 参数。
 * @returns {number} 奖励值，加到激活度上。
 */
export function userReward({ activation, userSilence, recentHitCount }, params = DEFAULT_PARAMS) {
  const base = params.userRewardBase * (1 + params.wakeGamma * Math.log(1 + userSilence));
  return base * gateSaturation(activation, params) * gateRepeat(recentHitCount, params);
}

/**
 * 模型提起时的原始奖励 `Rm`（上游 [V5 §5.3]）。
 *
 * `B_m × e^(−λ·U_old)` —— **它随「被用户冷落多久」指数衰减。**
 *
 * @param {number} userSilence - 被用户冷落的轮数。
 * @param {DmaeParams} [params] - 参数。
 * @returns {number} 原始奖励值。
 */
export function modelRewardRaw(userSilence, params = DEFAULT_PARAMS) {
  return params.modelRewardBase * Math.exp(-params.wakeLambda * userSilence);
}

/**
 * 衰减 `Decay`（上游，v3.4 默认策略）。
 *
 * `(α·US² + β·MS²) / sqrt(I)`
 *
 * **两句注释把意图说透了**（上游原文）：
 *
 *   > 平方 → 累计加速遗忘
 *   > 除以 sqrt(I) → 「价值决定忘得多慢，而不是爱得多深」
 *
 * **平方是关键**：不是线性淡出，是加速的。**所以「掉下去」会来得比较突然。**
 *
 * @param {object} ctx - 上下文。
 * @param {number} ctx.userSilence - 加完之后的用户静默轮数。
 * @param {number} ctx.modelSilence - 加完之后的模型静默轮数。
 * @param {number} [ctx.resistance] - 抗遗忘能力 I（**1~4**）。
 * @param {DmaeParams} [params] - 参数。
 * @returns {number} 衰减值，从激活度里减。
 */
export function decay({ userSilence, modelSilence, resistance }, params = DEFAULT_PARAMS) {
  const i = Math.max(MIN_INTRINSIC, Number.isFinite(resistance) ? resistance : MIN_INTRINSIC);
  const raw = params.decayAlpha * userSilence * userSilence + params.decayBeta * modelSilence * modelSilence;
  return raw / Math.sqrt(i);
}

/**
 * 三档状态（上游 `deriveState`，纯函数）。
 *
 * @param {number} activation - 当前激活度。
 * @param {DmaeParams} [params] - 需要 `promptThreshold`。
 * @returns {"archived"|"dormant"|"active"} 状态。
 */
export function deriveState(activation, params = DEFAULT_PARAMS) {
  if (activation <= 0) return 'archived';
  if (activation >= params.promptThreshold) return 'active';
  return 'dormant';
}

/**
 * 一条设定在同一轮里该不该被算作「提到过」。
 *
 * ⚠️ **上游用 `String.includes`**，本地也照做 —— 但本地世界书的触发词是中文，
 * 而 `includes` 在中文上没有分词问题（不像英文的 `art` 会命中 `start`）。
 * **这是本地比上游省事的一处。**
 *
 * @param {DmaeEntry} entry - 条目。
 * @param {string} text - 要搜的文本。
 * @returns {boolean} 是否命中。
 */
export function hits(entry, text) {
  if (!Array.isArray(entry.keywords) || entry.keywords.length === 0) return false;
  const haystack = typeof text === 'string' ? text : '';
  if (haystack === '') return false;
  return entry.keywords.some((kw) => haystack.includes(kw));
}

/* ------------------------------------------------------------------ *
 * 一轮
 * ------------------------------------------------------------------ */

/**
 * 推进一轮，返回新的状态。
 *
 * **不改传进来的东西** —— 返回新对象，方便测、方便回退。
 *
 * ## 顺序照上游（`updateActivation`）
 *
 *   1. 关掉的、常驻的、没有触发词的 → 跳过
 *   2. 算命中（用户 / 模型）
 *   3. **未命中且已归档的 → 跳过**（省算力，而且它本来就不会被想起来）
 *   4. 唤醒判定：曾归档 + 用户提到 → 一次拉到阈值之上
 *   5. 更新静默计数
 *   6. 维护重复窗口
 *   7. 算：`aInit + userReward + modelReward - decay`，夹住
 *
 * @param {EntryState} state - 旧状态。
 * @param {object} input - 这一轮的输入。
 * @param {DmaeEntry} input.entry - 条目。
 * @param {number} [input.base] - 底座 `A_base`（来自 `baseFromPriority`）。
 * @param {boolean} [input.userHit] - 用户这一轮提到它没有。
 * @param {boolean} [input.modelHit] - 模型这一轮提到它没有。
 * @param {number} [input.turn] - 当前轮次。
 * @param {DmaeParams} [params] - 参数。
 * @returns {EntryState} 新状态；跳过时原样返回。
 */
export function step(state, { entry, base = 0, userHit = false, modelHit = false, turn = 0 }, params = DEFAULT_PARAMS) {
  // ── 1. 不参与的条目 ──
  if (entry.enabled === false || entry.permanent === true) return state;
  if (!Array.isArray(entry.keywords) || entry.keywords.length === 0) return state;

  const before = deriveState(state.activation, params);
  const permanentFloor = params.floorMode === 'permanent';

  // ── 3. 已归档且没命中 → 不动 ──
  //
  // ⚠️ **这一句是 `floorMode` 起作用的地方。**
  //
  //    'wake'（上游）：归档的直接原样返回 —— 包括底座那几行也走不到，
  //                    所以「一次都没聊到」的条目是 **0**，不是 `A_base`。
  //    'permanent'：    **不能**在这里返回 —— 底座是地板，它每轮都得把
  //                    条目抬到 `A_base` 上，于是它永远在线。
  //
  //    两种语义下 `A_base` 的含义完全不同，而**改的就是这一行**。
  if (!permanentFloor && before === 'archived' && !userHit && !modelHit) return state;

  // ── 4. 唤醒 ──
  //
  // 上游 [V5 §7.4]：一个沉到底的记忆被重新提到，**不是慢慢涨，是一次拉过线**。
  // 这里比上游多一处：拉过线之后仍不低于底座 —— 否则一条 priority: 90 的条目
  // 被唤醒后反而比它平时还低。
  let activation = state.activation;
  let woke = false;
  if (userHit && before === 'archived') {
    activation = Math.min(params.maxScore, Math.max(base, params.promptThreshold + params.wakeBonus));
    woke = true;
  }
  // 底座是那个唤醒落点的下限
  if (activation < base) activation = base;

  // 'wake' 那条路这里是**唯一**一次用到 `base` —— 归档早退那一步把它挡在了外面。
  // 'permanent' 那条路则每轮都会走到这儿。

  // ── 5. 静默计数 ──
  //
  // 两个计数器是分开的：**模型提起不重置「用户静默」。**
  // 她自己念叨一件事，不会让它变得「最近被这个人提起过」。
  const userSilenceOld = state.userSilence;
  const modelSilenceOld = state.modelSilence;
  const userSilence = userHit ? 0 : userSilenceOld + 1;
  const modelSilence = (userHit || modelHit) ? 0 : modelSilenceOld + 1;

  // ── 6. 重复窗口 ──
  const kept = state.recentUserHits.filter((t) => t > turn - params.repeatWindow);
  const recentUserHits = userHit ? [...kept, turn] : kept;
  const recentHitCount = recentUserHits.length;

  // ── 7. 结算 ──
  //
  // ⚠️ 奖励用**加之前**的快照（含旧静默），衰减用**加之后**的静默 —— 上游这么排的。
  //    直觉是：奖励看你「之前被冷落多久」，衰减看你「现在还在被冷落」。
  const snap = { activation, userSilence: userSilenceOld, recentHitCount };
  const gain = userHit ? userReward(snap, params) : 0;
  const loss = decay({ userSilence, modelSilence, resistance: entry.resistance }, params);

  // 模型给的那份，被夹在「小于衰减」—— 上游那行：
  //     modelReward = Math.max(0, Math.min(rawRm, decay - EPSILON))
  //
  // **模型自己提起，最多抵消一点衰减，永远不足以让它涨。**
  // 不写这个，她自说自话就能把一条设定喂成永久活跃 —— 而那和你们聊了什么无关。
  let modelGain = 0;
  if (modelHit && before === 'active') {
    const raw = modelRewardRaw(userSilenceOld, params);
    modelGain = Math.max(0, Math.min(raw, loss - EPSILON));
  }

  let next = activation + gain + modelGain - loss;
  let clamped = Math.max(0, Math.min(params.maxScore, next));

  // ⚠️ **地板要加在结算之后。**
  //
  //    第一版我把它加在了结算**前**（`if (activation < base) activation = base;`），
  //    而衰减照样从那儿往下减 —— 于是「永久地板」照样会掉到 0。
  //    模拟器跑出来一眼就看见：
  //
  //        permanent · priority 90 · 一次都没聊到
  //          41  38  34  28  20  10   0   0   0   0   → archived
  //
  //    **「地板」的意思是「掉不到它以下」，那就只能在掉完之后兜。**
  //
  //    ⚠️ 而地板自己也要夹住上限 —— 第一版写成 `if (clamped < base) clamped = base;`，
  //       于是 `base` 比 `maxScore` 高的那一刻就把值顶出去了。
  //       **那条是测试抓出来的**（`floorMode 不会越过上限`），不是我想起来的。
  if (permanentFloor && clamped < base) clamped = Math.min(params.maxScore, base);

  return {
    activation: clamped,
    userSilence,
    modelSilence,
    recentUserHits,
    // 只给调试用：这一轮为什么变了
    ...(woke ? { lastWake: true } : {})
  };
}

/**
 * 从一组条目里挑出「想起来了」的那些。
 *
 * 按激活度降序 —— 和上游的 `getActiveEntries` 一致，**它不认 priority**
 * （因为那是通用引擎）。本地要 priority 参与排序的话，在调用处合成。
 *
 * @param {Array<{entry: DmaeEntry, state: EntryState}>} items - 条目与状态。
 * @param {DmaeParams} [params] - 参数。
 * @returns {object[]} 激活度降序的条目。
 */
export function activeEntries(items, params = DEFAULT_PARAMS) {
  return items
    .filter(({ entry, state }) => {
      if (entry.enabled === false || entry.permanent === true) return false;
      return deriveState(state.activation, params) === 'active';
    })
    .sort((a, b) => b.state.activation - a.state.activation)
    .map(({ entry }) => entry);
}
