/**
 * The persona plugin.
 *
 * Her body used to be inlined in the profile patch, which meant every tweak to
 * her tone cost a rebuild, a patch rewrite and a DSH restart. It now arrives
 * through the `cyrene_persona` template variable, which `dsh-system-prompt`
 * interpolates on every assembly — so the file behind it is hot.
 *
 * The one thing that must never happen is the provider returning `undefined`.
 * Verified against this machine's `dsh-system-prompt`:
 *
 *     throw new Error(`unknown prompt variable "{{${name}}}" ...`)        // not registered
 *     if (value === void 0) throw new Error(`prompt variable ... has no value ...`)
 *
 * Both fail the WHOLE assembly — not the paragraph, the entire preset, on every
 * turn. So the fallback is a real string, and there is a test that says so.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  apply,
  createPersonaReader,
  resolvePromptFile,
} from '../persona.mjs';

/** 仓库根。用来给 junction 当目标。 */
const ROOT = realpathSync(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
/** dist/ 的真实路径。 */
const distDir = () => realpathSync(join(ROOT, 'dist'));

/**
 * ⚠️ 模式那一套（Work / Code / Learn 三份提示词）**可能不在这份仓库里**。
 *
 * 2026-10-11：分档预设整个去掉了，所以下面那几条测「分档提示词」的用例
 * 会**永远跳过** —— 而跳过是对的：那个功能不在，不是坏了。
 *
 * **留着它们的理由是它们测的是 `file:` 这个机制**，而机制还在：
 * 两个预设现在都不配它，但 `persona.mjs` 读文件那条路留着 ——
 * 以后再分档，缺的就是这几条。
 *
 * 判据是「这个功能在不在」：分档的源文件不在，就说明这份仓库没有分档。
 * 用 `{ skip: ... }` 显式跳过并说明原因 —— **不是**静默通过。
 * node:test 会把跳过单独计数，看得出「这里没跑」。
 */
const MODE_FEATURE = existsSync(join(ROOT, 'persona-style-thin.md'))
  ? false
  : '分档提示词那一套不在这份仓库里（这份没有分档预设）';

/** A stand-in for the preset-scope context. */
function fakeContext() {
  const variables = new Map();
  return {
    variables,
    ctx: {
      systemPrompt: {
        variable(name, provider) {
          variables.set(name, provider);
        }
      }
    }
  };
}

/** A temp file holding the given text; `dir` is returned so it can be cleaned up. */
function withPersonaFile(text) {
  const dir = mkdtempSync(join(tmpdir(), 'cyrene-persona-'));
  const file = join(dir, 'system-prompt.md');
  writeFileSync(file, text);
  return { dir, file };
}

test('the plugin registers the variable the preset references', () => {
  const { ctx, variables } = fakeContext();
  apply(ctx);
  assert.deepEqual([...variables.keys()], ['cyrene_persona']);
});

test('the provider returns the file body', () => {
  const { dir, file } = withPersonaFile('# 你是「昔涟」\n\n## 你怎么说话\n\n- 温和\n');
  try {
    const read = createPersonaReader(file, () => {});
    const body = read();
    assert.equal(typeof body, 'string');
    assert.ok(body.startsWith('# 你是「昔涟」'));
    assert.ok(body.includes('温和'));
    assert.equal(body, body.trim(), 'the body is trimmed, so trailing newlines cannot shift the prompt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the body is re-read when the file changes', () => {
  // The whole point: this is what makes a persona edit take effect on the next
  // turn instead of costing a restart.
  const { dir, file } = withPersonaFile('# 第一版\n');
  try {
    const read = createPersonaReader(file, () => {});
    assert.ok(read().includes('第一版'));
    writeFileSync(file, '# 第二版，改长一点点\n');
    assert.ok(read().includes('第二版'), 'an edit must be visible on the next read');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the provider never returns undefined, whatever the file does', () => {
  const messages = [];
  const warn = (message) => messages.push(message);

  // Missing entirely.
  const missing = createPersonaReader(join(tmpdir(), 'cyrene-no-such-dir', 'system-prompt.md'), warn);
  const absent = missing();
  assert.equal(typeof absent, 'string');
  assert.notEqual(absent, '', 'an empty string would make dsh-system-prompt drop the section entirely');

  // Empty.
  const empty = withPersonaFile('   \n\n');
  try {
    const read = createPersonaReader(empty.file, warn);
    assert.equal(typeof read(), 'string');
    assert.notEqual(read(), '');
  } finally {
    rmSync(empty.dir, { recursive: true, force: true });
  }

  // Unreadable JSON-ish garbage is still just text, so this one is legitimately
  // returned as-is — a persona body is not a structured document.
  assert.ok(messages.length > 0, 'a failed read must leave a trace on stderr');
});

test('a repaired file replaces the fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cyrene-persona-'));
  const file = join(dir, 'system-prompt.md');
  try {
    writeFileSync(file, '');
    const read = createPersonaReader(file, () => {});
    const fallback = read();
    assert.ok(fallback.includes('昔涟'), 'the fallback still knows who she is');

    // An empty file must not be cached as the answer: once it has content, that
    // content is what the model should see.
    writeFileSync(file, '# 真正的人设\n');
    assert.ok(read().includes('真正的人设'));
    assert.notEqual(read(), fallback);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a read that starts failing keeps the last good body', () => {
  // A half-written file during an edit is the common case. Losing her persona for
  // a turn is worse than serving the previous one.
  const { dir, file } = withPersonaFile('# 好的人设\n');
  try {
    const read = createPersonaReader(file, () => {});
    assert.ok(read().includes('好的人设'));
    rmSync(file, { force: true });
    assert.ok(read().includes('好的人设'), 'the last good body must survive a transient failure');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// ── 模式提示词的选择 ────────────────────────────────────────────────────────

test('默认读 Chat 那份', () => {
  const { path, problem } = resolvePromptFile(undefined);
  assert.equal(problem, null);
  assert.ok(path.endsWith('system-prompt.md'), path);
});

test('配了 file 就读那一份', { skip: MODE_FEATURE }, () => {
  for (const name of ['system-prompt.other.md', 'system-prompt.other.md', 'system-prompt.other.md']) {
    const { path, problem } = resolvePromptFile(name);
    assert.equal(problem, null, name);
    assert.ok(path.endsWith(name), path);
  }
});

test('⚠️ file 指的文件不存在时必须报问题，不能安静地退回 Chat', () => {
  // 这条是这次改动的全部理由。静默退回的话，四个预设会跑同一份 Chat 人格 ——
  // 界面看着是四个，点进去一样，而且没有任何地方报错。
  const { path, problem } = resolvePromptFile('system-prompt.nope.md');
  assert.equal(path, null, '不应该给出一个会读到 Chat 的路径');
  assert.ok(typeof problem === 'string' && problem.includes('不存在'), String(problem));
});

test('file 不许跑出 dist/', () => {
  for (const bad of ['../../../../etc/passwd', '..\\..\\secret.md', 'sub/../../outside.md']) {
    const { path, problem } = resolvePromptFile(bad);
    assert.equal(path, null, bad);
    assert.ok(typeof problem === 'string' && problem.includes('dist/'), bad + ' → ' + String(problem));
  }
});

test('dist/ 里的绝对路径可以，外面的不行', () => {
  const inside = resolvePromptFile(undefined).path;              // .../dist/system-prompt.md
  const dir = inside.slice(0, inside.lastIndexOf('\\'));
  assert.equal(resolvePromptFile(inside).problem, null, 'dist 里的绝对路径应当放行');
  const outside = resolvePromptFile(dir + '\\..\\persona-soul.md');
  assert.equal(outside.path, null, 'dist 外面的绝对路径应当拒绝');
});

// ── 模式提示词的选择：Windows 路径边界 ──────────────────────────────────────

test('⚠️ 经由 junction 不许读到 dist 外面', () => {
  // 第 7 轮实测出来的绕过：字面检查看的是路径字符串，而 junction 让一个
  // 「看起来在 dist 里」的路径指到外面。当时它读到了 persona-soul.md（15473 字符）。
  //
  // 修法是判断**真实路径**（realpathSync），不是字面路径。
  //
  // junction 不需要管理员权限（符号链接才需要），所以这条能在这个环境里跑。
  const link = join(distDir(), '__test-junction__');
  try {
    rmSync(link, { recursive: true, force: true });
    symlinkSync(ROOT, link, 'junction');
  } catch (error) {
    // ⚠️ **不能静默跳过。**
    //
    // 第一版写的是 `catch { assert.ok(true, '跳过'); return; }` —— 那会让这条用例
    // 在任何建不出 junction 的机器上「通过」，而它什么都没测。
    // 今晚已经栽过一次同类：「L2 那次 9 项里 8 项打勾，因为它对着零个样本检查」。
    //
    // junction 在 Windows 上不需要管理员权限，其它平台上 `'junction'` 会被忽略、
    // 建成普通符号链接 —— 所以建不出来就是真的有问题，该失败。
    assert.fail(`建不出 junction，这条用例测不了任何东西：${error.message}`);
  }
  try {
    for (const target of ['persona-soul.md', 'memory.mjs', 'persona.mjs']) {
      const { path, problem } = resolvePromptFile(`__test-junction__/${target}`);
      assert.equal(path, null, `经由 junction 读到了 ${target}`);
      assert.ok(String(problem).includes('链接') || String(problem).includes('dist/ 外面'), String(problem));
    }
  } finally {
    rmSync(link, { recursive: true, force: true });
  }
});

test('正常的三份模式提示词仍然读得到', { skip: MODE_FEATURE }, () => {
  for (const name of ['system-prompt.other.md', 'system-prompt.other.md', 'system-prompt.other.md']) {
    const { path, problem } = resolvePromptFile(name);
    assert.equal(problem, null, `${name}: ${problem}`);
    assert.ok(path.endsWith(name), path);
    // 返回的应当是**规范化之后的**真实路径
    assert.ok(path.startsWith(distDir()), path);
  }
});

test('文件名大小写不敏感（Windows 的实际情况）', { skip: MODE_FEATURE }, () => {
  const { path, problem } = resolvePromptFile('system-prompt.other.md');
  assert.equal(problem, null, String(problem));
  // ⚠️ 这里**不能**断言返回的是磁盘上那个小写名字。
  //
  // 人家原本写的是「realpath 会把大小写规范化」，实测**不是** —— Windows 上
  // `realpathSync` 返回的是你给它的那个大小写（Node 没用
  // GetFinalPathNameByHandle 那一套）。这一条是被测试逼着改的：
  // 断言 `endsWith('system-prompt.other.md')` 失败，实际值是大写那份。
  //
  // 所以真实行为是：**能打开**（Windows 不区分大小写），原样返回。
  assert.ok(path.toLowerCase().endsWith('system-prompt.other.md'), path);
});

test('子目录写法指向 dist 里面，不存在就拒绝', () => {
  // `DIST/x` 不是「dist 目录」的大小写变体，而是 dist 下一个叫 DIST 的子目录。
  // 相对路径一律相对于 dist，这条要说清楚 —— 消息里给出的完整路径就是证据。
  const { path, problem } = resolvePromptFile('DIST/system-prompt.other.md');
  assert.equal(path, null);
  assert.ok(String(problem).includes('不存在'), String(problem));
  assert.ok(String(problem).includes('DIST'), String(problem));
});

test('尾点与备用数据流都不放行', () => {
  for (const bad of ['system-prompt.other.md.', 'system-prompt.other.md:$DATA', 'system-prompt.other.md:hidden']) {
    const { path } = resolvePromptFile(bad);
    assert.equal(path, null, bad);
  }
});

test('保留设备名不放行', () => {
  // Windows 把 NUL / CON / PRN / AUX / COM1 这些当成设备，出现在路径的**任何位置**都特殊。
  for (const dev of ['NUL', 'CON', 'PRN', 'AUX', 'COM1']) {
    const { path } = resolvePromptFile(dev);
    assert.equal(path, null, dev);
  }
});
