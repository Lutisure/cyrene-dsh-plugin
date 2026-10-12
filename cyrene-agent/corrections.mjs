/**
 * dsh-cyrene-agent/corrections — 说话方式的修正（预设级插件）。
 *
 * 解决的问题：在对话里发现她哪里说得不对，只能当场纠正，**下一轮她就忘了**。
 * 记进长期记忆也不对——记忆是记「关于对方的事实」，风格规则混进去会把记忆挤满。
 *
 * 这里开一条独立的通道：
 *
 *   用户说「以后别用『闲得慌』」→ 她调 correct → 追加进 corrections.md
 *   → **下一次装配**（下一轮）就被读进提示词 → 跨会话、跨重启都在
 *
 * 为什么能立刻生效：`persona.mjs` 在**每次装配时**读文件，靠 mtime 缓存判断要不要
 * 重新解析（见 file-cache.mjs）。所以这个文件是**热的**——改完下一轮就带上，
 * 不需要重启。这也正是当初把人设从「内联在补丁里」改成「运行时读文件」的理由。
 *
 * ⚠️ 边界要说清楚：**这条通道只在预设里存在。** 技能（/cyrene）是纯 markdown，
 * 背后没有任何插件，没有工具可调。所以技能里的修正来自构建期内联——
 * 跑一次 `node build.mjs` 就把当前的 corrections.md 带进去。
 *
 * ⚠️ 另一条边界：写进提示词**不等于**模型一定遵守。它把概率抬上去，不是保证。
 * 所以规则要写得具体、可判断（「不要说 X」比「语气再自然一点」有用得多）。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addEntry, forgetEntries, parseEntries } from './memory-logic.mjs';

/**
 * 随包带的那份默认修正 —— 就在本模块旁边。
 *
 * ⚠️ **它里面只放「她怎么说话」那类规则**（不挂对勾、不拆两个版本、不用「账」）。
 * 凡是**开发和维护这个仓库**的规矩（改文本要用 read/edit、别手写 base64），
 * 属于工作习惯不属于人格，放 `AGENTS.md` —— 混进来每一轮都要多背一条无关的约束。
 *
 * @returns {string|null} 绝对路径，或 null（文件不在）。
 */
function defaultPath() {
  try {
    return fileURLToPath(new URL('corrections.default.md', import.meta.url));
  } catch {
    return null;
  }
}

/** Cordis 服务名。`tools` 在下面用 scoped inject 可选挂载。 */
export const inject = ['systemPrompt'];

/**
 * 这一节在提示词里的标题。
 *
 * 措辞是刻意的：它必须读起来像**对上面内容的覆盖**，而不是又一段并列的建议。
 * 模型对「以下是修正」和「以下是一些想法」的处理方式不一样。
 */
export const BLOCK_OPEN = '【你对说话方式的修正 —— 以下是对方明确要求过的，优先级高于上面任何语气描述】';
export const BLOCK_CLOSE = '【修正结束】';

/** 文件放在和记忆同一个目录，便于一起备份、一起手改。 */
function storePath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'cyrene-agent', 'corrections.md');
}

/**
 * 读修正。读不到就是空的 —— 绝不抛错，读失败不该让整轮对话挂掉。
 *
 * ⚠️ **而「读不到」分两种，不能一样对待：**
 *
 *   · 文件**不存在** → 头一次用这台机器。**这时把随包那份默认的拷过去。**
 *     否则新装的人面对的是一条修正都没有的她 —— 而那份默认的九条，
 *     正是「她说话像不像她」里落差最大的那部分。
 *   · 文件存在但**读失败**（权限、编码坏掉）→ 返回空串，不动它。
 *     **这时候去覆盖才是危险的**：那是把人家自己写的规则删掉。
 *
 * 拷一份而不是「读不到就用默认内容」：默认那九条是**可以逐条删的**。
 * 回退的话，用户加一条自己的规则、那九条就全没了 —— 而它们互不相干。
 */
function readStore() {
  try {
    const file = storePath();
    if (existsSync(file)) return readFileSync(file, 'utf8');

    const seed = defaultPath();
    if (seed === null || !existsSync(seed)) return '';
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(seed, file);
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 写修正。
 * @param {string} text - 完整的新内容。
 * @returns {{ok: boolean, error?: string}} 结果。
 */
function writeStore(text) {
  try {
    const file = storePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, 'utf8');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 把修正渲染成提示词里的一块。
 *
 * 每条前面加一个「·」，并且明确写出「覆盖」的语义 —— 一段没有边界的规则列表
 * 在长提示词里很容易被当成背景资料略过。
 *
 * @returns {string} 这一块文本，没有修正时是空串。
 */
export function readCorrectionsBlock() {
  const entries = parseEntries(readStore());
  if (entries.length === 0) return '';
  const body = entries.map((entry) => `· ${entry}`).join('\n');
  return `${BLOCK_OPEN}\n${body}\n${BLOCK_CLOSE}`;
}

/** 供测试与诊断：当前有几条。 */
export function countCorrections() {
  return parseEntries(readStore()).length;
}

/**
 * 挂载修正通道。
 * @param {object} ctx - 预设级 Cordis 上下文（已 inject systemPrompt）。
 * @returns {void}
 */
export function apply(ctx) {
  // 读侧不在这里注册 —— 由 persona.mjs 拼进正文。理由和记忆一样：
  // `complete: true` 会替换掉所有其它 section，`includeRuntimeContext: false`
  // 会清空整个 context 通道，所以提示词注册表里除了正文什么都进不去。

  ctx.inject(['tools'], (scope) => {
    // 工具描述符的形状要求和 memory.mjs 完全一样：`register` 会把 `parameters`
    // **原样送给模型 API**，所以它必须是 JSON Schema，不是 defineTool 的作者 spec。
    // 详见 memory.mjs 里 stringTool 的注释。
    scope.tools.register({
      name: 'correct',
      description:
        '记下一条关于「你应该怎么说话 / 怎么表现」的持久修正，跨会话生效。' +
        '在对方指出你哪里说得不对、要求你以后别那样说、或纠正你的语气与习惯时使用。' +
        '一次只记一条，写成可直接判断的规则（「不要说 X」比「语气自然些」有用）。' +
        '不要用它记关于对方的事实 —— 那是 remember 的事。',
      parameters: {
        type: 'object',
        properties: {
          rule: { type: 'string', description: '要遵守的那条规则，一句话' }
        },
        required: ['rule']
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value ?? '') }]
      },
      execute: (args) => {
        const outcome = addEntry(readStore(), args?.rule);
        if (outcome.status === 'empty') return '内容为空，没有记下。';
        if (outcome.status === 'duplicate') return `「${outcome.entry}」已经记过了。`;
        const written = writeStore(outcome.store);
        if (!written.ok) return `记录失败：${written.error}`;
        return `记下了：「${outcome.entry}」`;
      }
    });

    scope.tools.register({
      name: 'uncorrect',
      description:
        '从修正列表里删掉包含某关键词的条目。在对方说「那条不用记了」「上次那条取消」时使用。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '要删掉的那条里包含的关键词' }
        },
        required: ['keyword']
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value ?? '') }]
      },
      execute: (args) => {
        const outcome = forgetEntries(readStore(), args?.keyword);
        if (outcome.removed === 0) return '没有找到包含这个词的修正，什么都没有删。';
        const written = writeStore(outcome.store);
        if (!written.ok) return `写入失败：${written.error}`;
        return `删掉了 ${outcome.removed} 条。`;
      }
    });
  });

  // ⚠️ 这里绝对不能 ctx.provide()：预设作用域里发布服务会让整个预设挂载失败。
}
