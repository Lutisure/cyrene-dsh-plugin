/**
 * 剧情切块器 —— 端到端。
 *
 * ## 为什么是端到端而不是单元
 *
 * `chunkFile` 的第一版把去重放在**「块」**那一层，而一个节点会切出十几块 ——
 * **983 块掉成 123 块。而输出看起来「正常」**：每个文件都有块数、分位数也合理、
 * 合计也是个像样的数。是看到「支线 1 块」才起疑的。
 *
 * **那种错只有真跑一遍才看得见**，所以这一份造一份 `corpus-src/` 夹具，
 * 跑整个工具，再读落下来的 `dist/story-chunks.jsonl`。
 *
 * 覆盖靠 `DSH_STORY_ROOT`。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const TOOL = join(import.meta.dirname, '..', 'tools', 'build-story-index.mjs');

/** 一条够长的发言，用来把节点撑出多块。 */
const LINE = (n) => `**【遐蝶】** 第 ${n} 句台词，这一行要够长才撑得出第二块来。`;

/**
 * 造一份夹具。
 *
 * @param {Record<string, string>} files - 文件名 → 内容。
 * @returns {{dir: string, cleanup: () => void}} 临时根目录。
 */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'story-root-'));
  mkdirSync(join(dir, 'corpus-src'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, 'corpus-src', name), body, 'utf8');
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * 跑工具，读落下来的块。
 *
 * @param {string} dir - 夹具根目录。
 * @returns {Array<object>} 块。
 */
function run(dir) {
  const result = spawnSync(process.execPath, [TOOL], {
    env: { ...process.env, DSH_STORY_ROOT: dir },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, `工具应当跑通：${result.stderr ?? ''}`);
  const raw = readFileSync(join(dir, 'dist', 'story-chunks.jsonl'), 'utf8');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** 一个节点，正文有 count 行。 */
function node(chapter, title, id, count) {
  const lines = Array.from({ length: count }, (_, i) => LINE(i + 1));
  return `# ${chapter}\n\n## ${title}　\`${id}\`\n\n${lines.join('\n')}\n`;
}

test('一个长节点要切出多块 —— 这正是我踩过的那个坑', () => {
  // 一个节点 60 行、约 3000 字，而 CHUNK_TARGET 是 900。
  const { dir, cleanup } = fixture({ 'amphoreus-main-story.md': node('第一章', '开端', '1040101', 60) });
  try {
    const chunks = run(dir);
    assert.ok(chunks.length >= 3, `一个长节点该切出多块，实际只有 ${chunks.length} 块`);
    // 每一块都还带着同一个节点 ID —— 去重不能把同节点的后续块吃掉。
    for (const c of chunks) assert.equal(c.nodeId, '1040101');
  } finally {
    cleanup();
  }
});

test('块带上章节、节点名和任务 ID', () => {
  const { dir, cleanup } = fixture({ 'amphoreus-main-story.md': node('落木逐火英雄纪', '银辇啊', '1040101', 40) });
  try {
    const [first] = run(dir);
    assert.equal(first.chapter, '落木逐火英雄纪');
    assert.equal(first.node, '银辇啊');
    assert.equal(first.nodeId, '1040101');
    assert.equal(first.kind, '主线');
    assert.ok(first.text.includes('第 1 句'));
  } finally {
    cleanup();
  }
});

test('说明行（> 开头）不进索引', () => {
  const body = `# 第一章\n\n> 崩坏：星穹铁道 游戏内文本（本地提取）。\n> 只在本地自用。\n\n## 开端　\`1040101\`\n\n${Array.from({ length: 20 }, (_, i) => LINE(i + 1)).join('\n')}\n`;
  const { dir, cleanup } = fixture({ 'amphoreus-main-story.md': body });
  try {
    const chunks = run(dir);
    const all = chunks.map((c) => c.text).join('\n');
    assert.ok(!all.includes('只在本地自用'), '说明行不该出现在正文里');
    assert.ok(all.includes('第 1 句'));
  } finally {
    cleanup();
  }
});

test('后一份文件里同 ID 的节点整个跳过 —— 去重在节点那一层', () => {
  // 同一个节点 ID 出现在两份文件里。第二份的内容更薄，应该整条不要。
  const thin = (id) => `# 另一份\n\n## 同一节　\`${id}\`\n\n**【希儿】** 薄版正文，只有这一行也要够长才不至于被丢掉，再多加几个字。\n`;
  const { dir, cleanup } = fixture({
    'amphoreus-main-story.md': node('第一章', '开端', '1040101', 30),
    'amphoreus-side-stories.md': thin('1040101')
  });
  try {
    const chunks = run(dir);
    assert.ok(chunks.every((c) => !c.text.includes('薄版正文')), '重复节点应当整个跳过，而不是只跳第一块');
    assert.ok(chunks.some((c) => c.text.includes('第 1 句')), '先到的那份要留着');
  } finally {
    cleanup();
  }
});

test('不重复的节点会被收进来 —— 三份不全互相包含', () => {
  const { dir, cleanup } = fixture({
    'amphoreus-main-story.md': node('第一章', '开端', '1040101', 30),
    'amphoreus-story.md': node('别的章', '独有的一节', '9999999', 30)
  });
  try {
    const ids = new Set(run(dir).map((c) => c.nodeId));
    assert.ok(ids.has('1040101'));
    assert.ok(ids.has('9999999'), '第二份独有的节点要被收进来');
  } finally {
    cleanup();
  }
});

test('太短的块丢掉 —— 一个光标题没有检索价值', () => {
  const body = `# 第一章\n\n## 只有标题　\`1040101\`\n\n短。\n\n## 有正文的　\`1040102\`\n\n${Array.from({ length: 20 }, (_, i) => LINE(i + 1)).join('\n')}\n`;
  const { dir, cleanup } = fixture({ 'amphoreus-main-story.md': body });
  try {
    const chunks = run(dir);
    assert.ok(chunks.every((c) => c.nodeId !== '1040101'), '短块应当丢掉');
    assert.ok(chunks.some((c) => c.nodeId === '1040102'));
  } finally {
    cleanup();
  }
});

test('读不到的文件跳过，不炸', () => {
  const { dir, cleanup } = fixture({ 'amphoreus-story.md': node('第一章', '开端', '1040101', 30) });
  try {
    // 另外两个文件不存在 —— 工具该跳过它们，照样产出。
    assert.ok(run(dir).length > 0);
  } finally {
    cleanup();
  }
});

// ── 清掉游戏界面 ──────────────────────────────────────────────────────
//
// 那两个 .md 是「播放顺序原文」，带着播放器的记号。
// **实测占 12.5% 的字符、65% 的块里有它。**
//
// 而代价不只是体积 —— 对方说问「遐蝶的死亡之触」时**思考时间明显变长**，
// 查下来两个原因，这是其中一个：**要读懂一段剧情，模型得先把这些记号过滤掉。**

test('〔选项〕和 · 选项行不进索引 —— 那是界面，不是剧情', () => {
  const body = [
    '# 第一章',
    '',
    '## 受戒　`1040101`',
    '',
    '**【阿蒙内特】** 与死者同行…',
    '〔选项〕',
    '',
    '　· 轻轻触碰。',
    '　· 不，我做不到。',
    '',
    ...Array.from({ length: 16 }, (_, i) => LINE(i + 1))
  ].join('\n');
  const { dir, cleanup } = fixture({ 'amphoreus-main-story.md': body });
  try {
    const all = run(dir).map((c) => c.text).join('\n');
    assert.ok(!all.includes('〔选项〕'), '选项标题不该在正文里');
    assert.ok(!all.includes('轻轻触碰'), '选项行不该在正文里');
    assert.ok(all.includes('与死者同行'), '台词要留着');
  } finally {
    cleanup();
  }
});

test('↳ 回应行留下内容、去掉记号 —— 那是剧情，不是界面', () => {
  const body = [
    '# 第一章',
    '',
    '## 受戒　`1040101`',
    '',
    '↳ 以上都通向：**【不知名的死囚】** 不、不……',
    '↳ **【阿蒙内特】** 这是你的义务。',
    '',
    ...Array.from({ length: 16 }, (_, i) => LINE(i + 1))
  ].join('\n');
  const { dir, cleanup } = fixture({ 'amphoreus-main-story.md': body });
  try {
    const all = run(dir).map((c) => c.text).join('\n');
    assert.ok(!all.includes('↳'), '箭头记号不该在正文里');
    assert.ok(!all.includes('以上都通向'), '合并标记不该在正文里');
    assert.ok(all.includes('【不知名的死囚】'), '回应行的内容要留着');
    assert.ok(all.includes('这是你的义务'), '回应行的内容要留着');
  } finally {
    cleanup();
  }
});
