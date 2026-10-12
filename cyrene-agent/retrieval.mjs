/**
 * 检索 · 纯函数核心
 *
 * ## 它服务两个消费者
 *
 *   `tools/story-probe.mjs`  离线标定（闸门、专名表、单次探针）
 *   `story.mjs`              运行时注入
 *
 * 抽成模块的理由和 `worldbook-logic.mjs` 一样：**规则住的地方要能在没有会话、
 * 没有模型的情况下被穷举测。** 注入那一层才碰 DSH。
 *
 * ## 为什么是字符二元组
 *
 * 中文没有空格。二元组有个正好需要的性质：「遐蝶后来怎么样了」和「遐蝶怎么样」
 * 共享「怎么」「么样」—— 而触发词式的整串子串匹配，中间隔一个「后来」就断了。
 *
 * ## 为什么这里**不收单字**
 *
 * 世界书那边（132 条短条目）留单字，因为「花」这种一个字的东西不留就消失了。
 * **这边不同：983 块、每块约 855 字符，单字只贡献噪声。**
 *
 * 实测代价：加单字之后「晚安」拿到 0.1607 —— 比两条真剧情问题还高，
 * 因为它命中了「走过**安眠**地」里的「安」。短查询加单字，任何一次命中都会主导余弦。
 */

/** 标点和其他符号不进索引。与世界书那边同一套 —— 两处不一致会让分数不可比。 */
const STRIP = /[\s，。！？、；：「」『』（）()【】《》…—－\-~♪“”"'’‘]/g;

/**
 * 专名清洗。**规则故意很窄。**
 *
 * 剧情原文里的 `**【X】**` 有 717 个，而其中绝大多数是**真有用的** ——
 * 「尼卡多利的士兵」「愤慨的悬锋族人」这些问起来都是剧情问题。
 * 所以只剔三类真有害的，不把描述当噪声清掉：
 *
 *   纯标点   `？？？` `？？` —— **这个最要紧**：用户在对话里打一串问号表示困惑，
 *            会被名字闸判成剧情问题。
 *   单字     `刃` —— 太短，「刀刃」这种普通词也会命中。
 *   花括号   `{NICKNAME}` —— 模板占位符，不是名字。
 *
 * ## 为什么返回数组
 *
 * `「长老」阿蒙内特` 这种，剥掉外层引号会留下 `长老」阿蒙内特` —— 中间那个 `」`
 * 让整串匹配不上任何东西（**第一版就是这么错的**）。要的是**拆成两段**：
 * `长老` 和 `阿蒙内特`，因为用户可能只说其中一个。
 *
 * 「三月七」这种整段被引号包住的，剥完还是 `三月七`，和裸的那个合成一条。
 *
 * @param {string} raw - 从 `**【X】**` 里取出来的原文。
 * @returns {string[]} 能当专名用的片段；一个都不剩时是空数组。
 */
export function cleanName(raw) {
  const text = String(raw ?? '').trim();
  // 先按引号拆段，再逐段剥壳。
  const parts = text.split(/[「」『』"'‘’“”]/).map((s) => s.trim()).filter(Boolean);
  return parts.filter((name) => {
    if (name.length < 2) return false;
    if (/^[？?…。！、\s]+$/.test(name)) return false;
    if (/[{}]/.test(name)) return false;
    return true;
  });
}

/**
 * 字符二元组。
 *
 * @param {string} text - 原文。
 * @returns {string[]} 二元组；只有一个字时退回那个字，免得空手而归。
 */
export function grams(text) {
  const clean = String(text ?? '').replace(STRIP, '');
  const out = [];
  for (let i = 0; i + 1 < clean.length; i += 1) out.push(clean.slice(i, i + 2));
  if (clean.length === 1) out.push(clean);
  return out;
}

/** @param {string} text - 原文。 @returns {Map<string, number>} 词频。 */
function termCounts(text) {
  const counts = new Map();
  for (const g of grams(text)) counts.set(g, (counts.get(g) ?? 0) + 1);
  return counts;
}

/**
 * 建索引。IDF 从**这批文档本身**估，不需要外部语料。
 *
 * @param {Array<object>} docs - 每项要有 `text`，可选 `chapter` / `node`。
 * @param {(doc: object) => string} [haystack] - 参与匹配的文本，默认 章节+节点+正文。
 * @returns {{search: (query: string, topK?: number) => Array<{doc: object, score: number}>}} 索引。
 */
export function buildIndex(docs, haystack) {
  const pick = haystack ?? ((d) => `${d.chapter ?? ''} ${d.node ?? ''} ${d.text ?? ''}`);
  const docTerms = docs.map((d) => termCounts(pick(d)));

  const df = new Map();
  for (const terms of docTerms) for (const g of terms.keys()) df.set(g, (df.get(g) ?? 0) + 1);
  const idf = (g) => Math.log((docs.length + 1) / ((df.get(g) ?? 0) + 1)) + 1;

  const vectors = docTerms.map((terms) => {
    const vec = new Map();
    let norm = 0;
    for (const [g, c] of terms) {
      const w = (1 + Math.log(c)) * idf(g);
      vec.set(g, w);
      norm += w * w;
    }
    return { vec, norm: Math.sqrt(norm) || 1 };
  });

  return {
    size: docs.length,
    vocabulary: df.size,
    /**
     * @param {string} query - 用户的问题。
     * @param {number} topK - 取前几块。
     * @returns {Array<{doc: object, score: number}>} 按分数降序。
     */
    search(query, topK = 3) {
      const qc = termCounts(query);
      const qvec = new Map();
      let qnorm = 0;
      for (const [g, c] of qc) {
        // 查询里出现库里没有的词时，IDF 给一个下限 —— 否则新词会把整个向量归一化掉。
        const w = (1 + Math.log(c)) * (df.has(g) ? idf(g) : 1);
        qvec.set(g, w);
        qnorm += w * w;
      }
      qnorm = Math.sqrt(qnorm) || 1;
      return vectors
        .map((d, i) => {
          let dot = 0;
          const [small, large] = qvec.size < d.vec.size ? [qvec, d.vec] : [d.vec, qvec];
          for (const [g, w] of small) {
            const other = large.get(g);
            if (other !== undefined) dot += w * other;
          }
          return { doc: docs[i], score: dot / (qnorm * d.norm) };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    }
  };
}
