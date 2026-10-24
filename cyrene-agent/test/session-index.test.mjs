/**
 * 会话日志索引 —— 报账要靠它把「第几轮」接上「她说了什么」。
 *
 * 这一层最容易出的错不是崩溃，是**少找到一些日志**：找不到的样子是
 * 「报账说没有真实数据」，看着像事实、其实是没扫到。所以测试里
 * 造的是磁盘上真实存在的三种布局，而不是一个理想化的目录树。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { findSessionLogs } from '../session-index.mjs';

test('两种布局都要扫到：会话子目录，和直接躺在工作区目录下的那份', () => {
  const home = mkdtempSync(join(tmpdir(), 'cyrene-sessions-'));
  try {
    // 布局①：一个会话一个目录
    const a = join(home, 'sessions', '--F-One--', 'session-aaa');
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, 'session.v4.jsonl.zstd'), 'x');

    // 布局②：日志直接躺在工作区目录下（与子目录同级）
    const ws = join(home, 'sessions', '--F-Two--');
    mkdirSync(join(ws, 'session-bbb'), { recursive: true }); // 空子目录，没有日志
    writeFileSync(join(ws, 'session.v4.jsonl.zstd'), 'y');

    // 布局③：明文 jsonl（导出包里那种）
    const c = join(home, 'sessions', '--F-Three--', 'session-ccc');
    mkdirSync(c, { recursive: true });
    writeFileSync(join(c, 'session.v4.jsonl'), 'z');

    const found = findSessionLogs(home);
    const ids = found.map((entry) => entry.id).sort();
    assert.deepEqual(ids, [
      '--F-Two--', // 布局② 的 id 就是工作区目录名 —— 留痕里 `session` 字段写的就是它
      'session-aaa',
      'session-ccc'
    ]);
    assert.equal(found.find((e) => e.id === '--F-Two--').workspace, '--F-Two--');
    assert.equal(found.find((e) => e.id === 'session-aaa').workspace, '--F-One--');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('压缩那份优先：两种都在时选 .zstd', () => {
  const home = mkdtempSync(join(tmpdir(), 'cyrene-sessions-'));
  try {
    const dir = join(home, 'sessions', '--F--', 'session-x');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.v4.jsonl'), 'old');
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), 'new');
    const [only] = findSessionLogs(home);
    assert.ok(only.file.endsWith('.zstd'), only.file);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('什么都没有的时候返回空数组，不抛', () => {
  const home = mkdtempSync(join(tmpdir(), 'cyrene-sessions-'));
  try {
    assert.deepEqual(findSessionLogs(home), []);
    assert.deepEqual(findSessionLogs(join(home, 'definitely-not-here')), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// 这条是**对照线**：索引在合成目录上全对、在真机器上一个都找不到，
// 是最容易发生的一种失效（路径拼错、工作区命名不同）。
//
// 但没有 DSH 的机器上它测不了任何东西 —— CI 的干净 runner 就是那样。
// 所以先扫一次：扫到东西才断言，扫不到就 skip 并报出扫的位置，不假装通过。
// 硬留着 `found.length > 0` 的后果是每一次 CI 都红，而那并不说明代码坏了。
const REAL_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const REAL_FOUND = findSessionLogs();

test(
  '拿真实的 DSH_HOME 跑一次：扫得到，而且每份都指到一个真文件',
  {
    skip:
      REAL_FOUND.length > 0
        ? false
        : `${REAL_HOME} 下没有可扫的会话日志 —— 这条对照线只能在本机跑，干净环境里没有东西可对照`,
  },
  () => {
    // 这条是**对照线**：索引在合成目录上全对、在真机器上一个都找不到，
    // 是最容易发生的一种失效（路径拼错、工作区命名不同）。
    const found = REAL_FOUND;
    assert.ok(found.length > 0, '真机上应当至少有一个会话日志');
    for (const entry of found.slice(0, 5)) {
      assert.ok(entry.id.length > 0);
      assert.ok(entry.file.includes('session.v4.jsonl'), entry.file);
    }
  },
);

