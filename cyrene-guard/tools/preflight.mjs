/**
 * 起飞前检查：把 cyrene-guard 的 apply() 在一个假宿主上真跑一遍。
 *
 * 光看配置文件能解析是不够的 —— 崩的那次也可能是插件在挂载时抛。而 DSH 的启动
 * 路径是「读 profile → 挂载每个插件」，任一插件抛就是整个进程起不来。
 *
 * 这个假宿主照着 dsh-fs 和 dsh-system-prompt 的真实用法搭：
 *   ctx.effect(fn, label)          注册清理
 *   ctx.on(event, handler)         监听 fs/observed
 *   ctx.fs.stat / ctx.fs.readText  读回文件
 *   ctx.systemPrompt.section({...})  要求 order 是有限数，否则直接抛
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { apply, inject, name, worthScanning } from '../index.js';

console.log('  导出：name=' + name + '  inject=' + JSON.stringify(inject));

const dir = mkdtempSync(join(tmpdir(), 'guard-check-'));
const events = {};
let section = null;
let disposed = 0;

const ctx = {
  effect(fn, label) {
    // Real signature: the callback returns the disposer.
    const disposer = fn();
    assert.equal(typeof disposer, 'function', `effect "${label}" must return a disposer`);
    return disposer;
  },
  on(event, handler) {
    assert.equal(typeof handler, 'function', `${event} needs a function`);
    events[event] = handler;
  },
  fs: {
    async stat(target) {
      return { size: readFileSync(target.displayPath).length, version: 'v1' };
    },
    async readText(target) {
      return readFileSync(target.displayPath, 'utf8');
    }
  },
  systemPrompt: {
    section(s) {
      // dsh-system-prompt throws on a non-finite order. Reproduce that, because a
      // plugin that only works when the host is lenient is not a plugin that works.
      if (!Number.isFinite(s.order)) throw new TypeError(`prompt section "${s.name}" order must be finite`);
      section = s;
      return () => {};
    }
  }
};

// 真写文件。插件第一件事是 existsSync，只把内容放进假的 readText 是不够的 ——
// 那样它读到的是「文件不存在」，于是什么都不报，而测试看起来像插件坏了。
globalThis.__probe = {};
const write = (rel, body) => {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, 'utf8');
  return full;
};

// ---- 挂载 --------------------------------------------------------------
apply(ctx);
console.log('  apply() 没有抛 ✓');
assert.equal(typeof events['fs/observed'], 'function', '必须在 fs/observed 上挂了监听');
assert.notEqual(section, null, '必须注册了提示词 section');
assert.equal(section.name, 'cyrene-guard/scan');
assert.equal(Number.isFinite(section.order), true);

// ---- 干净的时候不贡献任何东西 --------------------------------------------
assert.equal(section.text(), '', '没有发现时，这一块必须是空的 — 不能每轮都塞一段废话');

// ⚠️ 下面这两个「假凭据」拆开拼。**GitHub 的推送保护会拦这些形状**，
// 而它分不出测试夹具和真东西 —— 2026-10-12 这个仓库就是被这么拦下的
// （见 `cyrene-guard/test/scanner.test.mjs` 里那段注释）。
const FAKE_KEY = 'sk-proj-' + 'abcdefghijklmnopqrstuvwxyz0123456789';
const FAKE_KEY_2 = 'sk-proj-' + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa';


// ---- 写一个有问题的文件，看它报不报 --------------------------------------
const appJs = write('app.js',
  `const API_KEY = "${FAKE_KEY}";\nspawn(c, { shell: true });\n`);
await events['fs/observed']({ displayPath: appJs });
// 监听里是 fire-and-forget，给它一拍。
await new Promise((r) => setTimeout(r, 50));

const report = section.text();
assert.ok(report.includes('app.js'), '报告里要有文件名');
assert.ok(report.includes('sk-p'), '密钥要被脱敏成首尾各 4 位，而不是整条进上下文');
assert.equal(report.includes('abcdefghijklmnopqrstuvwxyz'), false, '完整密钥绝不能出现在报告里');
assert.ok(report.includes('不是安全边界'), '报告必须自己说清它是什么');
console.log('  js 文件扫描 ✓  ' + report.split('\n').length + ' 行');

// ---- 清单文件：幻觉包 --------------------------------------------------
const manifest = write('package.json', JSON.stringify(
  { dependencies: { express: '^4', 'react-virtualized-auto-sizer': '^1', 'some-unknown-pkg': '^1' } },
  null,
  2
));
await events['fs/observed']({ displayPath: manifest });
await new Promise((r) => setTimeout(r, 50));
const manifestReport = section.text();
assert.ok(manifestReport.includes('react-virtualized-auto-sizer'), '编出来的包要报');
assert.ok(manifestReport.includes('react-window'), '并给出替代');
assert.equal(manifestReport.includes('some-unknown-pkg'), false, '表外的包是「不知道」，不是「不存在」');
console.log('  清单文件扫描 ✓');

// ---- 不该扫的东西 ------------------------------------------------------
const dep = write('node_modules/x/a.js', `const k = "${FAKE_KEY_2}";`);
await events['fs/observed']({ displayPath: dep });
await new Promise((r) => setTimeout(r, 50));
assert.equal(section.text().includes('node_modules'), false, '依赖目录不扫');
console.log('  依赖目录被跳过 ✓');

// ---- 读不回来不能让写入流程受影响 --------------------------------------
// 一个从来没存在过的路径：读不回来不能抛，也不能影响写入流程。
await events['fs/observed']({ displayPath: join(dir, 'never-written.js') });
await new Promise((r) => setTimeout(r, 50));
console.log('  读不回来时不抛 ✓');

console.log('\n  全部通过 —— 这个插件不会在启动时把 DSH 弄挂。');
