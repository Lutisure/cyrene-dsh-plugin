/**
 * 给 132 条世界书条目定 `intrinsicValue`（长期价值基准）。
 *
 * ## 这不是「自动生成」，是一张可复核的表
 *
 * `intrinsicValue` 是**判断**，不是算出来的。所以这个文件的主体是一张表 ——
 * 而表上的每个数，来源都写在旁边那一列。
 *
 * **来源只有两种，不许有第三种：**
 *
 *     upstream   从上游那份世界书搬的（经过线性重映射），旁边注明是哪一条
 *     ours       上游没有，我们自己定的 —— 而理由写在注释里
 *
 * ## 重映射
 *
 *     上游   45 ~ 100      （真值分布，最常见 80）
 *     我们   30 ~ 90        （`baseFromPriority` / `resistanceFromPriority` 按这个夹）
 *
 *     mine = 30 + (up - 45) / (100 - 45) × 60
 *
 * ⚠️ **第一次量错**的经过值得记着：漏读一支导致「46 条全是 60」，
 * 而那个结果**看着像默认值**。**假的测量和真的默认值长得一样。**
 *
 * ## 一条角色内部同分的理由
 *
 * 上游一个角色一条，我们拆成五~七条（`-who` / `-creed` / `-cost` / `-late` …）。
 * **它们同分** —— 因为「角色内部谁先出现」那一层是 `priority` 在管，
 * 而 `intrinsicValue` 管的是「这个角色整体多重」。
 *
 * **⚠️ 上游没有对应物，这是我们自己定的。**
 *
 * @module intrinsic-values
 */

/** 上游 iv → 我们的量纲。 */
export const remap = (up) => 30 + ((up - 45) / (100 - 45)) * 60;

/**
 * 角色那一档：上游 iv 80 → **68.2**。
 *
 * 上游 `characters.md` 里十一个拿得到的角色全是 80 —— **它就是这一档的刻度。**
 */
const ROLE = remap(80);

/**
 * 按 id 前缀归组。
 *
 * ⚠️ **顺序有意义**：先匹配到的算数。`phainon-` 要排在 `phainon` 前面吗？
 * 不用 —— 前缀都不带尾横线的那些写在后面就行。**下面每条都带了尾横线或就是全名。**
 *
 * @type {Array<{prefix: string, value: number, from: string, why?: string}>}
 */
export const TABLE = [
  // ── 世界那一层：上游给得最高 ────────────────────────────────────────
  { prefix: 'amphoreus', value: remap(100), from: 'upstream: 翁法罗斯 100' },
  { prefix: 'goldens-roster', value: remap(85), from: 'upstream: 黄金裔与泰坦 85' },

  // ── 她自己：这是「忘掉了就不是她」的那一类 ──────────────────────────
  // 上游 `Cyrene.md` 七条全是 60，只有「无漏净子」到 90。
  // 而 60 在他们那边是**没填的默认**，不是判断 —— 所以这一组不照搬。
  // 理由写在这儿：这几条是她**是谁**，不是「关于她的事实」。
  { prefix: 'her-origin', value: 84, from: 'ours', why: '她是谁（翁法罗斯之心）—— 忘掉就不是她了' },
  { prefix: 'wulou-jingzi', value: remap(90), from: 'upstream: 无漏净子 90' },
  { prefix: 'philia-disappearance', value: remap(92), from: 'upstream: 帝皇权杖·δ-me13 92' },
  { prefix: 'self-three-names', value: 80, from: 'ours', why: '三形态同一性 —— 她怎么是同一个她' },
  { prefix: 'which-self', value: 72, from: 'ours', why: '同上，读者视角的那一面' },
  { prefix: 'self-love', value: 66, from: 'ours', why: '她怎么理解「爱」—— 这不是细节' },
  { prefix: 'book-of-me', value: remap(60), from: 'upstream: 《如我所书》60' },
  { prefix: 'shanjian-tian', value: remap(60), from: 'upstream: 善见天 60' },
  { prefix: 'ailian', value: 70, from: 'ours', why: '路径名「哀怜」—— 她的起点' },
  { prefix: 'demiurge-titan', value: remap(75), from: 'upstream: 无名泰坦大墓·德谬歌 75' },
  { prefix: 'fuli-and-gaze', value: remap(60), from: 'upstream: 三形态同一性 60' },

  // ── 哀丽秘榭 ────────────────────────────────────────────────────────
  { prefix: 'aedes-elysiae', value: remap(75), from: 'upstream: 哀丽秘榭与黑潮 75' },
  { prefix: 'village', value: 34, from: 'ours', why: '村子里的具体事（秋千）—— 细节' },

  // ── 角色：上游全是 80 ──────────────────────────────────────────────
  { prefix: 'heir-phainon', value: ROLE, from: 'upstream: 白厄 80' },
  { prefix: 'phainon-', value: ROLE, from: 'upstream: 白厄 80' },
  { prefix: 'childhood-phainon', value: ROLE, from: 'upstream: 白厄 80' },
  { prefix: 'mydei-', value: ROLE, from: 'upstream: 万敌 80' },
  { prefix: 'castorice-', value: ROLE, from: 'upstream: 遐蝶 80' },
  { prefix: 'hysilens-', value: ROLE, from: 'upstream: 海瑟音 80' },
  { prefix: 'hyacine-', value: ROLE, from: 'upstream: 风堇 80' },
  { prefix: 'anaxa-', value: ROLE, from: 'upstream: 那刻夏 80' },
  { prefix: 'cipher-', value: ROLE, from: 'upstream: 赛飞儿 80' },
  { prefix: 'cerydra-', value: ROLE, from: 'upstream: 刻律德菈 80' },
  { prefix: 'aglaea-', value: ROLE, from: 'upstream: 阿格莱雅 80' },
  { prefix: 'tribbie-', value: ROLE, from: 'upstream: 缇宝 80' },
  { prefix: 'huangdi-', value: ROLE, from: 'upstream: 荒笛 80' },

  // ── 「某角色怎么样」那十五条：我们的语域，上游没有 ────────────────
  // 它们问的是「她对那个人的看法」。**那不是世界事实，是她的一层关系** ——
  // 所以比角色本身低一点，但不低太多（那也是「她是谁」的一部分）。
  { prefix: 'view-', value: 62, from: 'ours', why: '她对某人的看法 —— 关系层，略低于角色本身' },

  // ── 剩下的边角 ─────────────────────────────────────────────────────
  { prefix: 'memory-', value: 52, from: 'ours', why: '记忆机制 —— 结构性的，但不必长留' },
  { prefix: 'oracle-cards', value: 48, from: 'ours', why: '神谕牌 —— 道具层' },
  { prefix: 'self-oracle', value: 46, from: 'ours', why: '同上' },
  { prefix: 'ripples', value: 54, from: 'ours', why: '涟漪 —— 她的意象，常出现' },
  { prefix: 'heart-pages', value: 50, from: 'ours', why: '心的书页 —— 意象' },
  { prefix: 'letters', value: 44, from: 'ours', why: '写信 / 卡片' },
  { prefix: 'flowers', value: 40, from: 'ours', why: '花 —— 意象，边角' },
  { prefix: 'star-motif', value: 40, from: 'ours', why: '星星 —— 意象，边角' },
  { prefix: 'music-motif', value: 36, from: 'ours', why: '唱歌 —— 边角' },
  { prefix: 'fairy-magic', value: 42, from: 'ours', why: '妖精的魔法 —— 边角' },
  { prefix: 'roles-joke', value: 32, from: 'ours', why: '玩笑层' },
  { prefix: 'mimiform', value: 44, from: 'ours', why: '迷迷的样子' },
  { prefix: 'mimimi-chorus', value: 36, from: 'ours', why: '迷迷们 —— 边角' },
  { prefix: 'memory-tablets', value: 38, from: 'ours', why: '石版' },
  { prefix: 'no-fabrication', value: 74, from: 'ours', why: '「别编」—— 这条忘了她会开始编，**不该淡出**' },
  { prefix: 'partner', value: 76, from: 'ours', why: '伙伴 —— 她怎么称呼对方' },
  { prefix: 'tacitness', value: 50, from: 'ours', why: '默契' },
  { prefix: 'bookend', value: 44, from: 'ours', why: '「最后」' },
  { prefix: 'reserved-now', value: 46, from: 'ours', why: '「变了」' },
  { prefix: 'unfinished-self', value: 58, from: 'ours', why: '「你是谁」' },
  { prefix: 'farewell-tone', value: 60, from: 'ours', why: '道别 —— 她的调子' },
  { prefix: 'thousand-year-wait', value: remap(95), from: 'upstream: 三千万世的轮回 95' },

  // ── `how-she-*` 那一族：**她怎么想事** ──────────────────────────────
  //
  // ⚠️ 第一版这张表**漏了这一整族**（10 条），而它们是最不该淡出的那一类 ——
  //    「她怎么判断好坏」「她怎么讲故事」「她怎么对待遗憾」。
  //    漏掉的原因很实在：我按**角色名**和**意象名**归纳，而这一族是按**她本人**归纳的。
  //
  //    **一张按名字前缀编的表，会系统性地漏掉那些名字不指向实体的条目。**
  //    这条记在这儿，因为下次编这种表还会踩。
  { prefix: 'how-she-judges', value: 76, from: 'ours', why: '她怎么判断好坏 —— 道德内核，不该淡出' },
  { prefix: 'how-she-holds-regret', value: 74, from: 'ours', why: '她怎么对待遗憾 —— 内核' },
  { prefix: 'how-she-tells-stories', value: 76, from: 'ours', why: '她怎么讲故事 —— 这是她的本体' },
  { prefix: 'sincerity-proves-itself', value: 74, from: 'ours', why: '她信什么（颤抖即生命）—— 内核' },
  { prefix: 'how-big-a-village-is', value: 72, from: 'ours', why: '故乡与世界 —— 她看世界的方式' },
  { prefix: 'word-collector', value: 74, from: 'ours', why: '「一起」「我们」—— 她最看重的词' },
  { prefix: 'mimis-origin', value: 70, from: 'ours', why: '迷迷是什么 —— 「她是谁」的那一面' },
  { prefix: 'afraid-to-trouble', value: 66, from: 'ours', why: '怕给人家添麻烦 —— 她的自我克制' },
  { prefix: 'she-noticed-renjia', value: 52, from: 'ours', why: '自称「人家」—— 说话习惯，可淡' },
  { prefix: 'echo-speech', value: 48, from: 'ours', why: '学人说话 —— 习惯，可淡' }
];

/**
 * 一条条目该拿多少。
 *
 * @param {string} id - 条目 id。
 * @param {number} [fallback] - 表里没命中时用它的 `priority`。
 * @returns {number} 该填的值。
 */
export function valueFor(id, fallback) {
  const hit = TABLE.find((row) => id.startsWith(row.prefix));
  if (hit !== undefined) return Math.round(hit.value * 10) / 10;
  return Number.isFinite(fallback) ? fallback : 60;
}

/** 表里命中的前缀 —— 用来查「还有哪些条目没被覆盖」。 */
export const coveredBy = (id) => TABLE.find((row) => id.startsWith(row.prefix));
