/**
 * dsh-cyrene-agent/memory — 长期记忆（预设级插件）。
 *
 * 读侧走 `systemPrompt.variable()`，写侧走 `tools.register`。
 *
 * 为什么读侧用 `variable()` 而不是 `context()`：
 *   - `context()` 是 **append 型**：内容一变就追加一条新的，旧的不会消失。
 *     记忆每写一次就变一次，用它会累积出一堆过期版本。
 *   - `variable()` 是**替换**语义，正是记忆需要的。代价是它在提示词头部，
 *     改动会让前缀缓存失效 —— 但记忆是低频写入，这个代价可以接受。
 *
 * ⚠️ **人设正文里引用 `{{cyrene_memory}}`，而这个变量只有本插件注册。**
 * 引用一个没注册的模板变量会让**整次装配失败**（不是降级，是硬失败）。
 * 所以这两件事由 build.mjs 一起生成、并有一条测试盯着它们不许漂移：
 * 只要人设里出现了这个占位符，预设里就必须有这一行插件。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  MAX_ENTRIES,
  addEntry,
  forgetEntries,
  memoryPressure,
  parseTombstones,
  renderMemory,
  tombstone
} from './memory-logic.mjs';

/** Cordis 服务名。`tools` 刻意不在这里 —— 它在下面用 scoped inject 可选挂载。 */
export const inject = ['systemPrompt'];

/**
 * 记忆文件位置。
 *
 * 用 `os.homedir()` 而不是 `process.env.HOME`：Windows 上 HOME 通常没设，
 * 那样会退化成 `./.dsh`，也就是「跟着工作目录跑」——同一份记忆会因为从哪个
 * 目录启动 DSH 而落在不同地方。
 */
function storePath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'cyrene-agent', 'memory.md');
}

/**
 * Where forgotten entries go.
 *
 * Never injected. Kept because forgetting is itself worth remembering: without it
 * 「我为什么忘掉这个」 and 「我是不是扔了还有用的东西」 have no answers, and a
 * deletion is irreversible before anyone can disagree with it.
 */
function archivePath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'cyrene-agent', 'memory-forgotten.md');
}

/** 读记忆。读不到就是空记忆 —— 绝不抛错，读失败不该让整轮对话挂掉。 */
/** Read the archive. Missing is normal: nothing has been forgotten yet. */
function readArchive() {
  try {
    const path = archivePath();
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

/**
 * Append tombstone lines to the archive.
 * @param {string[]} lines - tombstone payloads.
 * @returns {{ok: boolean, error?: string}} the result.
 */
function appendArchive(lines) {
  if (lines.length === 0) return { ok: true };
  try {
    const path = archivePath();
    mkdirSync(dirname(path), { recursive: true });
    const existing = readArchive();
    const body = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`;
    writeFileSync(path, `${body}${lines.map((line) => `- ${line}`).join('\n')}\n`, 'utf8');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * The raw payloads of the entries a keyword matches.
 *
 * Needed before the removal, because the archive wants the whole line — including
 * any 「不适用=」 boundary it carried — and the store no longer has it afterwards.
 *
 * @param {string} store - the memory store.
 * @param {string} keyword - the substring to match, case-insensitively.
 * @returns {string[]} the matched payloads.
 */
function rawLineMatches(store, keyword) {
  const needle = keyword.toLowerCase();
  return String(store ?? '')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ') && line.slice(2).toLowerCase().includes(needle))
    .map((line) => line.slice(2).trim());
}

function readStore() {
  try {
    const file = storePath();
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
}

/**
 * 写记忆。
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
 * 造一个「一个字符串参数、返回一段文本」的工具描述符。
 *
 * ⚠️ **`parameters` 必须是 JSON Schema，不是作者 spec。**
 *
 * 这里绕过 `defineTool`，是因为它在 `link:` 安装下解析不到（与参考项目同样的理由）。
 * 而这两个 API 的形状**不一样**：
 *
 *     function defineTool(options) {
 *       const parameters = parameterSchemaSpecToJsonSchema(options.parameters);  // ← 编译在这里
 *       ...
 *     }
 *     register(definition) {
 *       assertSupportedJsonSchema(output.schema);                                // ← 只校验 output
 *       ... layer.tools.insert(name, definition)                                 // ← parameters 原样存
 *     }
 *
 * 所以 `register` 的 `parameters` **会原样送到模型 API**。写成作者 spec 的样子
 * （`{ text: { type: 'string', required: true } }`）—— 那正是官方工具**经过
 * defineTool 之后**输入端的形状 —— API 收到的是一个没有 `type` 的对象，直接拒绝：
 *
 *     Invalid schema for function 'forget': schema must be a JSON Schema of
 *     'type: "object"', got 'type: null'
 *
 * 这个坑我来回踩了两次，值得记下来：
 *   · 第 2 轮我把 JSON Schema 改成作者 spec —— 那次方向对，因为官方工具确实那么写，
 *     但那**是 defineTool 的输入格式**，而我用的是 register。
 *   · 第 8 轮我拿 `parameterSchemaSpecToJsonSchema` 去「验证」它 —— **而 register
 *     永远不调那个函数**，于是验出了一个假的通过。
 * 教训不是「要验证」，而是「**要验证对的那个函数**」。
 *
 * @param {{name: string, description: string, parameter: string, parameterDescription: string, run: Function}} spec - 工具定义。
 * @returns {object} 工具描述符。
 */
function stringTool({ name, description, parameter, parameterDescription, run }) {
  return {
    name,
    description,
    // The shape `defineTool` would have produced, written out by hand.
    parameters: {
      type: 'object',
      properties: { [parameter]: { type: 'string', description: parameterDescription } },
      required: [parameter]
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }]
    },
    execute: (args) => run(args?.[parameter])
  };
}

/**
 * The memory block, as text — for the persona plugin to splice into the body.
 *
 * ⚠️ **It is not registered as a `context()`, and neither is a `variable()`.**
 * Both routes were tried against the real `dsh-system-prompt`, and both fail —
 * differently, and both silently:
 *
 *   1. As a `variable()` referenced from the persona body, it never resolved.
 *      Interpolation scans a section's text once and **never re-scans a value it
 *      substituted in**. Since the body is itself the value of
 *      `{{cyrene_persona}}`, a `{{cyrene_memory}}` inside it reached the model as
 *      the literal string.
 *   2. As a `context()`, it is discarded outright. The preset sets
 *      `complete: true` **and** `includeRuntimeContext: false`, and `assemble()`
 *      ends with `contexts: runtimeContextSuppressed ? [] : transformed.contexts`.
 *      The channel is emptied wholesale.
 *
 * So the block is composed into the persona body by `persona.mjs`, which is the
 * only thing that actually reaches the model under those two settings.
 *
 * @returns {string} the block, or an empty string when nothing is remembered.
 */
export function readMemoryBlock() {
  return renderMemory(readStore());
}

/**
 * 挂载长期记忆。
 * @param {object} ctx - 预设级 Cordis 上下文（已 inject systemPrompt）。
 * @returns {void}
 */
export function apply(ctx) {
  // 读侧不在这里注册 —— 由 persona.mjs 拼进正文。见 readMemoryBlock 的说明。

  // 写侧：可选挂载 —— 没有 tools 服务时插件照样加载，只是变成只读。
  ctx.inject(['tools'], (scope) => {
    scope.tools.register(
      stringTool({
        name: 'remember',
        description:
          '把一条关于对方的长期信息写进你自己的长期记忆，跨会话保留。' +
          '只在对方明确说「记住」，或主动告诉你一件明显的长期事实时使用。' +
          '不要记录一次性的、临时的、当轮就过期的内容。一次只记一件事，用一句话写。',
        parameter: 'text',
        parameterDescription: '要记住的那件事，一句话',
        run: (value) => {
          const outcome = addEntry(readStore(), value);
          if (outcome.status === 'empty') return '内容为空，没有写入。';
          if (outcome.status === 'injection') {
            // Refused, visibly. A memory is read into the system prompt on every
            // later turn, so an instruction that gets in here never leaves — and the
            // usual way one arrives is a web page the model was reading, not the
            // person. Naming what matched lets them judge; storing it behind a marker
            // would be silent, and the marker would be read as part of the memory.
            return `这条没有写进记忆。里面有一句像是在给人家下指令的话（「${outcome.against}」），而记忆每一轮都会读到，放进去就一直在。如果这是你在跟人家讨论、或者引用别人的话，换一种说法再说一次就好。`;
          }
          if (outcome.status === 'duplicate') return `「${outcome.entry}」已经在记忆里了，没有重复添加。`;
          const written = writeStore(outcome.store);
          if (!written.ok) return `记忆写入失败：${written.error}`;
          return `记住了：「${outcome.entry}」`;
        }
      })
    );

    scope.tools.register({
      name: 'forget',
      description:
        '把内容包含某关键词的记忆移出长期记忆。' +
        '在对方明确说「忘掉」「别记着」某件事时使用。' +
        '\n\n被移走的内容不会删除，会进一个不再注入的存档，附上你写的原因。' +
        '原因要如实写——几个月后有人回看时，它得能说明当时为什么这么决定。' +
        '\n\n一次只忘一件事。关键词要挑得准，它会匹配到的所有条目一起移走。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '要忘掉的内容里包含的关键词' },
          reason: { type: 'string', description: '为什么忘掉它，一句话，如实写' }
        },
        required: ['keyword', 'reason']
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value ?? '') }]
      },
      execute: (args) => {
        const keyword = String(args?.keyword ?? '').trim();
        const reason = String(args?.reason ?? '').trim();
        if (keyword === '') return '没有给关键词，什么都没有动。';
        if (reason === '') return '没有给原因。写一句为什么，然后再忘。';

        const store = readStore();
        const matched = rawLineMatches(store, keyword);
        if (matched.length === 0) return '没有找到包含这个词的记忆，什么都没有动。';

        const outcome = forgetEntries(store, keyword);
        const written = writeStore(outcome.store);
        if (!written.ok) return `记忆写入失败：${written.error}`;

        const when = new Date().toISOString().slice(0, 10);
        const archived = appendArchive(matched.map((line) => tombstone(line, reason, when)));
        if (!archived.ok) {
          // The entry is already out of the live store. Say what happened rather
          // than reporting a clean success, because the archive write failing means
          // the record of WHY is missing, which is the whole point of the change.
          return `移走了 ${outcome.removed} 条，但存档写入失败（${archived.error}）——内容已不在记忆里，原因没能留下。`;
        }
        return `忘掉了 ${outcome.removed} 条，已经连同原因存进存档（还可以用 restore 捞回来）。`;
      }
    });

        scope.tools.register({
          name: 'forgotten',
          description:
            '看看过去忘掉过什么、以及当时为什么忘。' +
            '用它复核：某条是不是当初就不该忘，或者现在又需要了。',
          parameters: {
            type: 'object',
            properties: {
              keyword: { type: 'string', description: '可选，只看包含这个词的' }
            }
          },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value ?? '') }]
          },
          execute: (args) => {
            const keyword = String(args?.keyword ?? '').trim().toLowerCase();
            let stones = parseTombstones(readArchive());
            if (keyword !== '') stones = stones.filter((stone) => stone.raw.toLowerCase().includes(keyword));
            if (stones.length === 0) return keyword === '' ? '还没有忘掉过什么。' : '存档里没有包含这个词的。';

            const lines = stones.map(
              (stone) => `- ${stone.forgot || '(没记日期)'}　${stone.text}　原因：${stone.reason || '(没写原因)'}`
            );
            return `忘掉过 ${stones.length} 条：\n${lines.join('\n')}`;
          }
        });

        scope.tools.register({
          name: 'restore',
          description: '把忘掉的记忆捞回来。在对方说「那条还是有用的」「上次不该忘」时使用。',
          parameters: {
            type: 'object',
            properties: {
              keyword: { type: 'string', description: '要捞回来的那条里包含的关键词' }
            },
            required: ['keyword']
          },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value ?? '') }]
          },
          execute: (args) => {
            const keyword = String(args?.keyword ?? '').trim().toLowerCase();
            if (keyword === '') return '没有给关键词。';

            const stones = parseTombstones(readArchive());
            const hit = stones.filter((stone) => stone.raw.toLowerCase().includes(keyword));
            if (hit.length === 0) return '存档里没有包含这个词的。';

            // parseTombstones already stripped the tombstone fields and kept the live
            // ones, so the entry goes back exactly as it was — boundary and all.
            const existing = readStore()
              .replace(/\r\n?/gu, '\n')
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line.startsWith('- '))
              .map((line) => line.slice(2).trim());

            const back = hit.map((stone) => stone.text).filter((text) => !existing.includes(text));
            if (back.length === 0) return '那些已经在记忆里了，没有重复放回。';

            const written = writeStore(`${[...existing, ...back].map((line) => `- ${line}`).join('\n')}\n`);
            if (!written.ok) return `写回记忆失败：${written.error}`;

            const keep = stones.filter((stone) => !hit.includes(stone));
            try {
              const path = archivePath();
              mkdirSync(dirname(path), { recursive: true });
              writeFileSync(path, keep.length === 0 ? '' : `${keep.map((stone) => `- ${stone.raw}`).join('\n')}\n`, 'utf8');
            } catch (error) {
              return `已经放回记忆（${back.length} 条），但存档没能同步删除：${String(error?.message ?? error)}`;
            }
            return `捞回来 ${back.length} 条。`;
          }
        });
  });

  // ⚠️ 这里绝对不能 ctx.provide()：预设作用域里发布服务会让整个预设挂载失败。
}
