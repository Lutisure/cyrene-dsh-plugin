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

import { buildIndex, cleanName, grams } from './retrieval.mjs';
import { createEmbedder } from './embedder.mjs';

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
 * 「有区分度」的二元组：文档频率落在 `(0, 这个值]` 之间，**且真的出现在候选块里**。
 *
 * ## 为什么分数闸需要它（2026-10-13 实测）
 *
 * 50 句日常话里，**「明天见」的余弦是 0.2045** —— 比 20 条剧情问题的中位数（0.0798）高一倍多，
 * 也高于 0.15 这道闸。它和块的唯一重叠是「明天」（df=161，语料里到处都是）。
 *
 * 摊开看它的两个二元组：`明天` df=161（在块里）、`天见` df=11（在块里）。
 * 而三条**真该注入**的剧情问题各自都有更稀有的：
 *
 *     凯撒的登神长阶…   登神(7) 长阶(3) 铸成(7)
 *     净世金血…        净世(2) 世金(2)
 *     谁让毁灭流下了一滴金血   一滴(5) 滴金(1) 流下(2)
 *
 * 所以判据是 **df ≤ 10 且出现在候选块里** —— 10 这个数是从这张表上读出来的：
 * 「天见」的 11 刚好落在外面。
 *
 * ⚠️ 它挡的是**分数闸**，不是名字闸：名字闸有真专名，不需要这一层。
 */
export const STORY_DISTINCTIVE_DF = 10;

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
 * @returns {{
 *   index: object, docs: Array<object>, stamp: number, file: string | null,
 *   names: Set<string>, speakers: Set<string>, triggers: Set<string>,
 *   df: Map<string, number>, aliases: object,
 *   windows: object | null, vectors: object | null
 * } | null} 读不到时返回 null。
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
    const raw = readFileSync(file, 'utf8');
    const docs = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    if (docs.length === 0) return null;
    const { speakers, triggers } = nameSet(docs);
    // 文档频率：给「分数闸要不要认这条查询」用的（见 STORY_DISTINCTIVE_DF）。
    // 与 buildIndex 用的是同一个 haystack，避免两处口径不一致。
    const df = new Map();
    for (const d of docs) {
      for (const g of new Set(grams(`${d.chapter ?? ''} ${d.node ?? ''} ${d.text ?? ''}`))) {
        df.set(g, (df.get(g) ?? 0) + 1);
      }
    }
    cache = {
      stamp,
      docs,
      index: buildIndex(docs),
      // `names` 保留成并集：只传 names 的旧调用方（含仓库里那批测试）仍然成立。
      names: new Set([...speakers, ...triggers]),
      speakers,
      triggers,
      df,
      aliases: aliasGroups(),
      // 向量表：条数与源哈希对不上就是 null（等于没开）。窗口级优先。
      windows: loadWindows(raw, docs.length),
      vectors: loadVectors(raw, docs.length),
      file
    };
    return cache;
  } catch {
    // 读失败不能让这一轮对话失败。
    return null;
  }
}

/**
 * 专名表：剧情原文里的说话人 + 世界书触发词里剥出来的专名。
 *
 * ## 两档不是一回事（2026-10-13 实测）
 *
 * 说话人那一份是真专名（帕姆、姬子、缇宝…），命中一个就足以判定「在问剧情」。
 * 触发词那一份**混着普通词** —— 实测 486 个里 240 个是 2 字词：
 *
 *     涟漪 启程 旅途 妖精 魔法 伙伴 短信 玫瑰 星星 星空 银河 明天 记得 想你 …
 *
 * 而 40 句日常话里有 4 句会被这些 2 字词放过去：
 *
 *     「明天见」→明天   「记得多穿点」→记得   「有点想你」→想你   「明天要早起」→明天
 *
 * 所以这里**拆成两份返回**，闸门按两份分别判（见 `mentionsName`）。
 *
 * @param {Array<object>} docs - 剧情块。
 * @returns {{speakers: Set<string>, triggers: Set<string>}} 两份专名。
 */
function nameSet(docs) {
  const speakers = new Set();
  for (const d of docs) {
    for (const m of String(d.text ?? '').matchAll(/\*\*【([^】]{1,12})】\*\*/g)) {
      // cleanName 返回片段数组 —— `「长老」阿蒙内特` 要拆成两段，
      // 不然里头的 `」` 会让整串匹配不上任何东西。见 retrieval.mjs 的说明。
      for (const name of cleanName(m[1])) speakers.add(name);
    }
  }
  const triggers = new Set();
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
          if (base.length >= 2 && base.length <= 6) triggers.add(base);
        }
      }
    } catch {
      // 读不到世界书就只用说话人 —— 闸门变松，但不会失效。
    }
  }
  return { speakers, triggers };
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
 * 名字闸。**两档分开判。**
 *
 * - **说话人**（`**【X】**` 里出来的真专名）：命中一个就放行。
 * - **触发词型**：≥3 字的命中一个放行；**2 字的要同时命中两个**才算 ——
 *   单独一个「明天」「想你」「记得」不该把一段剧情塞进日常闲聊里。
 *
 * 返回值是**判定归属**，不是布尔 —— 日志与探针要能看出「是哪道闸放的行」。
 *
 * 旧形状（只有 `names`）走回退分支：只传 names 的调用方（含仓库里那批测试）行为不变。
 *
 * @param {object} state - `load()` 的结果。
 * @param {string} query - 用户这一轮说的话。
 * @returns {'speaker'|'trigger-long'|'trigger-two'|'trigger-one'|'none'} 判定归属。
 */
function nameVerdict(state, query) {
  if (state.speakers instanceof Set && state.triggers instanceof Set) {
    for (const n of state.speakers) if (query.includes(n)) return 'speaker';
    // 别名表里的人名按**强专名**对待 —— 它们每一个都核实过是指向某个人的叫法。
    // 这一条救了两种问法：
    //   · 2 字的别名（凯撒、金织、伏龙）—— 按「2 字触发词要两个」会被挡掉
    //   · 不在触发词表里的叫法（灰黯之手）—— 说话人表里只有「灰黯之手，遐蝶」整串
    for (const group of state.aliases ?? []) {
      for (const n of group) if (query.includes(n)) return 'speaker';
    }
    let short = 0;
    for (const n of state.triggers) {
      if (!query.includes(n)) continue;
      if (n.length >= 3) return 'trigger-long';
      short += 1;
      if (short >= 2) return 'trigger-two';
    }
    return short === 1 ? 'trigger-one' : 'none';
  }
  return [...(state.names ?? [])].some((n) => query.includes(n)) ? 'speaker' : 'none';
}

/** 名字闸真正放行的两档。 */
const NAMED = new Set(['speaker', 'trigger-long', 'trigger-two']);

/** 探针用：把 `load()` 出来的状态交出去（测试与标定要能看闸门归属）。 */
export function debugState() {
  return load();
}

/**
 * 别名表：同一角色的不同叫法。
 *
 * ## 为什么需要它
 *
 * 「缇宝的墓碑上写了什么」这条问题，含答案的那一块写的是「缇里西庇俄丝」——
 * 两边一个共同专名都没有，余弦看不见，答案块因此排到第 38 名。
 *
 * ## 每一条都核实过
 *
 * 见 `worldbook/aliases.yaml` 的文件头：**两种叫法都要在 986 块里真的出现过**，
 * 且指向同一个人。核实阶段否掉了 5 组（玻吕茜亚是姐妹不是本人、雅辛缇娅疑似先代…）。
 *
 * @returns {string[][]} 别名组；读不到时是空数组（不扩展 = 退回改动前的行为）。
 */
function aliasGroups() {
  const file = dataPath('./worldbook/aliases.yaml');
  if (file === null || !existsSync(file)) return [];
  try {
    const parsed = yaml.load(readFileSync(file, 'utf8'));
    return (parsed?.groups ?? [])
      .map((g) => (Array.isArray(g) ? g.map((n) => String(n).trim()).filter(Boolean) : []))
      .filter((g) => g.length >= 2);
  } catch {
    // 别名表坏了就当没有 —— 不能让整轮对话失败。
    return [];
  }
}

/**
 * 查询侧扩展试过，**结论：不要用**（2026-10-13 实测）
 *
 * 把用户用的叫法扩展成同组所有叫法之后再检索，排序会变差 —— 剧情锚点命中 5/10 → 4/10，
 * 还弄坏了两条原本正确的（「海瑟音的歌声」被换成另一块、「白厄的老师教了他什么」
 * 被换成卡厄斯兰那的长篇）。
 *
 * 原因是别名形式自带高 IDF 的二元组，扩展会把「那个叫法出现得多」的块抬起来，
 * 而长度归一化的余弦分不出「被提到很多次」和「回答了这个问题」。
 *
 * 所以别名**不进检索打分**，只用两处：
 *   一、让核实过的人名叫法按强专名放行（见 `nameVerdict`）—— 已实现
 *   二、作为数据留给未来的向量检索（`worldbook/aliases.yaml`）
 */

/**
 * 候选块里有「有区分度」的二元组吗 —— df 落在 `(0, STORY_DISTINCTIVE_DF]` 且出现在块正文里。
 *
 * 旧形状（state 里没有 `df`）不额外设限 —— 只传 index/names 的调用方行为不变。
 *
 * @param {object} state - `load()` 的结果。
 * @param {string} query - 用户这一轮说的话。
 * @param {object} doc - 候选块。
 * @returns {boolean} 是否可以走分数闸。
 */
function hasDistinctiveOverlap(state, query, doc) {
  if (!(state.df instanceof Map)) return true;
  const text = String(doc?.text ?? '');
  for (const g of new Set(grams(query))) {
    const freq = state.df.get(g) ?? 0;
    if (freq > 0 && freq <= STORY_DISTINCTIVE_DF && text.includes(g)) return true;
  }
  return false;
}

/**
 * 向量检索 —— **默认 auto：装好了就启用，没装就当没有**
 *
 *   （不设）                     auto —— 模型或向量表缺任何一个，静默退回纯词法
 *   DSH_STORY_EMBED=off|0|false  显式关掉（一键回退）
 *   DSH_STORY_EMBED=fake         假向量（只验接线，不验效果；测试用）
 *
 * 其余可调项（一般不用动）：
 *
 *   DSH_STORY_EMBED_DIR              模型目录（默认 `<包>/cyrene_embedding/bge-small-zh-v1.5`）
 *   DSH_STORY_EMBED_GRANULARITY      `window`（默认）或 `chunk`
 *   DSH_STORY_EMBED_FUSION           `rrf`（**默认**）或 `linear`
 *   DSH_STORY_EMBED_RRF_K            倒数排名融合的平滑常数，**默认 10**
 *   DSH_STORY_EMBED_TOPK             向量召回补进候选池的条数，默认 8
 *   DSH_STORY_EMBED_WEIGHT           线性融合权重（只在 FUSION=linear 时用），默认 0.5
 *   DSH_STORY_EMBED_QUERY_PREFIX     查询前缀；默认不加（见 queryPrefix 的实测记录）
 *
 * ⚠️ **这几个默认值是量出来的，不是拍的**（100 条剧情题 + 100 句日常，锚点命中）：
 *
 *     纯词法 46% → 窗口级 + linear 48% → 窗口级 + RRF(K=60) 53% → **RRF(K=10) 54%**
 *     块级向量 + linear 只有 42%（比纯词法还差）—— 所以默认用窗口级。
 *
 *   `linear` 会把两个**尺度不可比**的分数直接相加（词法 0.05–0.2，向量 0.5–0.7），
 *   等于让向量独占；`rrf` 用排名，才对得上。
 *
 * ## 为什么敢默认开
 *
 * 这条路上**每一处失败都是「退回词法」而不是报错**：没装模型、没装 onnxruntime、
 * 向量表哈希对不上、编码抛异常 —— 全都只是让这一轮少一点召回，对话不受影响。
 *
 * ## 设计：闸门不动，只动排序与召回
 *
 * 名字闸与分数闸**继续用原始余弦**（跨问题可比，阈值才立得住）；
 * 向量只做两件事：把词法漏掉的块**补进候选池**，以及在够格候选之间**决定先后**。
 */
const embedOn = () => {
  const value = String(process.env.DSH_STORY_EMBED ?? 'auto').toLowerCase();
  if (value === 'off' || value === '0' || value === 'false') return false;
  return true;
};
const embedWeight = () => {
  const raw = Number(process.env.DSH_STORY_EMBED_WEIGHT ?? 0.5);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.5;
};
const vectorTopK = () => {
  const raw = Number(process.env.DSH_STORY_EMBED_TOPK ?? 8);
  return Number.isInteger(raw) && raw > 0 ? raw : 8;
};

/**
 * 查询前缀 —— **默认不加**。
 *
 * BAAI 的模型卡在检索场景下建议给查询加 `为这个句子生成表示以用于检索相关文章：`
 * （bge-*-v1.5 三个尺寸都是这一句，文档不加）。
 *
 * ⚠️ **2026-10-13 实测：在这套语料上它是反效果** —— 100 条剧情题的锚点命中
 * **54% → 48%**。那句指令是给「短查询检索长文章」调分布用的，而这里是
 * 「十几字的问句 检索 220 字的游戏对白窗口」，语义场景对不上。
 *
 * 所以默认关。要试自定义前缀：`DSH_STORY_EMBED_QUERY_PREFIX=<文本>`。
 */
const queryPrefix = () => {
  const raw = process.env.DSH_STORY_EMBED_QUERY_PREFIX;
  if (raw === undefined || raw === 'off') return '';
  return raw;
};

/** 编码器单例。加载失败返回 null —— 那一轮退回纯词法，对话不受影响。 */
let embedderPromise = null;
function getEmbedder() {
  if (!embedOn()) return Promise.resolve(null);
  embedderPromise ??= createEmbedder().catch(() => null);
  return embedderPromise;
}

/**
 * 读向量表。**条数与源文件 sha256 都对得上才用** ——
 * 「chunks 重建了但向量忘了重建」不能静默出错。
 *
 * @param {string} sourceText - `dist/story-chunks.jsonl` 的原文。
 * @param {number} count - 块数。
 * @returns {{dim: number, data: Float32Array, model: string}|null} 向量表。
 */
function loadVectors(sourceText, count) {
  if (!embedOn()) return null;
  const metaFile = dataPath('./dist/story-vectors.json');
  const binFile = dataPath('./dist/story-vectors.f32');
  if (metaFile === null || binFile === null || !existsSync(metaFile) || !existsSync(binFile)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    if (meta.count !== count) return null;
    if (meta.sourceSha256 !== createHash('sha256').update(sourceText).digest('hex')) return null;
    const buf = readFileSync(binFile);
    const data = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    if (data.length !== count * meta.dim) return null;
    return { dim: meta.dim, data, model: meta.model };
  } catch {
    return null;
  }
}

/**
 * 读窗口级向量表（**优先于块级**）。同样的核对：条数 + 源哈希。
 *
 * 块级向量实测在 100 条剧情题上「含答案那一块排第 1」是 0/100 —— 块太大，
 * 答案那一行被整块主题平均掉了。窗口级（块内 220 字符滑窗）就是为了解决这个。
 *
 * @param {string} sourceText - chunks 原文。
 * @param {number} count - 块数。
 * @returns {{dim: number, data: Float32Array, chunkOf: Int32Array, count: number}|null} 窗口表。
 */
function loadWindows(sourceText, count) {
  if (!embedOn()) return null;
  const mode = String(process.env.DSH_STORY_EMBED_GRANULARITY ?? 'window').toLowerCase();
  if (mode === 'chunk') return null;
  const metaFile = dataPath('./dist/story-windows.json');
  const binFile = dataPath('./dist/story-windows.f32');
  if (metaFile === null || binFile === null || !existsSync(metaFile) || !existsSync(binFile)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    if (meta.chunks !== count) return null;
    if (meta.sourceSha256 !== createHash('sha256').update(sourceText).digest('hex')) return null;
    const buf = readFileSync(binFile);
    const data = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    if (data.length !== meta.count * meta.dim) return null;
    if (!Array.isArray(meta.chunkOf) || meta.chunkOf.length !== meta.count) return null;
    return { dim: meta.dim, data, chunkOf: Int32Array.from(meta.chunkOf), count: meta.count };
  } catch {
    return null;
  }
}

/** 一条查询 → 全体块的向量余弦（已归一化，点积即余弦）。 */
function vectorScores(state, queryVector) {
  const { dim } = state.windows ?? state.vectors;
  const scores = new Float32Array(state.docs.length).fill(-1);
  if (state.windows != null) {
    // 窗口级：**块分 = 它所有窗口里的最大值**（max-pooling）
    const { data, chunkOf, count } = state.windows;
    for (let w = 0; w < count; w += 1) {
      let sum = 0;
      const base = w * dim;
      for (let c = 0; c < dim; c += 1) sum += data[base + c] * queryVector[c];
      const chunk = chunkOf[w];
      if (sum > scores[chunk]) scores[chunk] = sum;
    }
    return scores;
  }
  const { data } = state.vectors;
  for (let r = 0; r < state.docs.length; r += 1) {
    let sum = 0;
    const base = r * dim;
    for (let c = 0; c < dim; c += 1) sum += data[base + c] * queryVector[c];
    scores[r] = sum;
  }
  return scores;
}

/**
 * 混合排序：把向量召回的块补进候选池，再按加权分排序。
 *
 * @param {object} state - `load()` 的结果。
 * @param {string} query - 用户这一轮说的话。
 * @param {Array<object>} eligible - 已过闸的候选（含词法分）。
 * @param {Float32Array|null} queryVector - 查询向量；为空则原样返回。
 * @returns {Array<object>} 排好序的候选（可能比 eligible 多）。
 */
function hybridOrder(state, query, eligible, queryVector) {
  if (queryVector === null || (state.windows == null && state.vectors == null)) return eligible;
  const weight = embedWeight();
  const fusion = String(process.env.DSH_STORY_EMBED_FUSION ?? 'rrf').toLowerCase();
  const all = state.index.search(query, state.docs.length);
  const lexicalOf = new Map(all.map((c) => [c.doc.id, c.score]));
  const vectors = vectorScores(state, queryVector);
  const indexOf = new Map(state.docs.map((d, i) => [d.id, i]));
  const vecOrder = [...vectors.keys()].sort((a, b) => vectors[b] - vectors[a]);

  const pool = new Map(eligible.map((c) => [c.doc.id, c]));
  for (const i of vecOrder.slice(0, vectorTopK())) {
    const doc = state.docs[i];
    if (!pool.has(doc.id)) pool.set(doc.id, { doc, score: lexicalOf.get(doc.id) ?? 0 });
  }

  if (fusion === 'rrf') {
    // 倒数排名融合：**两个分数的尺度不可比**（词法 0.05–0.2，向量 0.5–0.7），
    // 直接线性相加等于让向量独占 —— 所以用排名而不是分数。
    const K = Number(process.env.DSH_STORY_EMBED_RRF_K ?? 10);
    const lexRankOf = new Map(all.map((c, i) => [c.doc.id, i + 1]));
    const vecRankOf = new Map(vecOrder.map((i, r) => [state.docs[i].id, r + 1]));
    return [...pool.values()]
      .map((c) => {
        const at = indexOf.get(c.doc.id) ?? -1;
        return {
          ...c,
          vector: at >= 0 ? vectors[at] : 0,
          hybrid: 1 / (K + (lexRankOf.get(c.doc.id) ?? 9999)) + 1 / (K + (vecRankOf.get(c.doc.id) ?? 9999))
        };
      })
      .sort((a, b) => b.hybrid - a.hybrid);
  }

  return [...pool.values()]
    .map((c) => {
      const at = indexOf.get(c.doc.id) ?? -1;
      const vector = at >= 0 ? vectors[at] : 0;
      return { ...c, vector, hybrid: (1 - weight) * c.score + weight * vector };
    })
    .sort((a, b) => b.hybrid - a.hybrid);
}

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
export function pick(state, query, seen = new Map(), now = Date.now(), queryVector = null) {
  if (state === null || typeof query !== 'string' || query.trim() === '') return null;
  const verdict = nameVerdict(state, query);
  const mentioned = NAMED.has(verdict);
  const gate = mentioned ? verdict : 'score';
  const windowMs = storyWindowMs();
  // 别名**不进检索打分** —— 实测查询扩展会把排序弄差（见 aliasGroups 上方那段记录）。
  const candidates = state.index.search(query, 3);
  if (candidates.length === 0) return null;
  /** 够格走闸门的候选，按分数降序。 */
  const eligible = candidates.filter((top, rank) => {
    if (mentioned) return true;
    if (rank !== 0) return false;
    if (top.score < STORY_SCORE_FLOOR) return false;
    // 分数够，还要问一句「候选块里有没有稀有的二元组」——见 STORY_DISTINCTIVE_DF。
    return hasDistinctiveOverlap(state, query, top.doc);
  });
  if (eligible.length === 0) return null;

  // 混合排序（可选，默认关）：向量召回补进候选池 + 加权排序。
  // **上面那两道闸用的仍是原始余弦** —— 换的只是「够格之后给哪一块」。
  const ordered = hybridOrder(state, query, eligible, queryVector);

  for (const top of ordered) {
    const stamp = seen.get(top.doc.id);
    if (stamp !== undefined && now - stamp < windowMs) continue;
    seen.set(top.doc.id, now);
    // 记过的偶尔清一次，免得进程活久了这一张表无限长。
    if (seen.size > 512) {
      for (const [id, at] of seen) if (now - at >= windowMs) seen.delete(id);
    }
    return { doc: top.doc, score: top.score, escalated: false, gate, vector: top.vector ?? null };
  }

  // 全都在窗口里。
  //
  // ⚠️ **宁可重复也不空手** —— 这是世界书那边的 `escalated` 做法：
  // 「那几条是『窗口里什么都没有、只好重发一次』的」。**给一段她已经看过的，
  // 比这一轮什么都没有强。** 第一版是直接 return null，那不是同一个设计。
  const top = ordered[0];
  seen.set(top.doc.id, now);
  return { doc: top.doc, score: top.score, escalated: true, gate, vector: top.vector ?? null };
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
      // 是哪道闸放的行：speaker / trigger-long / trigger-two / score。
      // **真机上要判断「是谁放的行」，只能靠这个字段。**
      gate: hit.gate ?? null,
      // 向量余弦；没开向量检索、或它没参与排序时是 null。
      // 这一格是「embedding 到底有没有生效」在真机上的唯一证据 —— 全是 null 就是没生效。
      vector: typeof hit.vector === 'number' ? Number(hit.vector.toFixed(4)) : null,
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

      const state = load();
      // 查询向量：只在开了向量检索、且向量表对得上时才编。**编不出来就退回纯词法。**
      let queryVector = null;
      if (state?.windows != null || state?.vectors != null) {
        const model = await getEmbedder();
        if (model !== null) {
          try {
            queryVector = (await model.embed([`${queryPrefix()}${query}`]))[0] ?? null;
          } catch {
            queryVector = null;
          }
        }
      }

      const hit = pick(state, query, recent, Date.now(), queryVector);
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
