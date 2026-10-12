/**
 * 包名检查的测试。
 *
 * 这一组的重点是**三态不能塌成两态**。DeepSec 把「不存在」和「没查成」分得很开，
 * 而且为此写了专门的测试；塌成两态之后，一次断网就会把整个依赖清单报成幻觉包，
 * 而误报的规则会被关掉，关掉之后它一条都拦不住。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { maskCommentsAndStrings, languagesOf } from '../scanner.mjs';
import { clearPackageCache, packagesIn, seedLookup, verifyPackage } from '../packages-scan.mjs';
import { KNOWN, HALLUCINATED, escapeGoModulePath, normaliseName } from '../packages.mjs';

/**
 * 走一遍「解析 → 查表」，返回名字与结论。
 *
 * ⚠️ 用**只遮注释**的那一层。import 的包名住在字符串里，用全遮罩会把每一个都遮掉 ——
 * 而测试只会看到「什么都没找到」，看起来像通过。第一次写这个 helper 时就是这么错的。
 */
function inspect(text, path) {
  const langs = languagesOf(path);
  const masked = maskCommentsAndStrings(text, langs, { strings: false });
  return packagesIn(text, path, langs, masked).map((p) => ({ ...p, ...seedLookup(p.name, p.registry) }));
}

// ---------------------------------------------------------------- 种子表

test('the seed tables were generated, not typed', () => {
  // 手抄 128 个包名，错一个字符就是一条永远查不到的规则。生成器解析不出来会抛，
  // 所以表非空本身就是它跑过且解析成功的证据。
  assert.equal(KNOWN.npm.length > 20, true);
  assert.equal(KNOWN.pypi.length > 20, true);
  assert.equal(HALLUCINATED.npm.length > 0, true);
  assert.equal(HALLUCINATED.pypi.length > 0, true);
  for (const list of Object.values(HALLUCINATED)) {
    for (const entry of list) {
      assert.ok(entry.replacements.length > 0, `${entry.name} has no suggested replacement`);
    }
  }
});

test('Go module paths are escaped the way the proxy requires', () => {
  // 规范：大写写成 ! 加小写，! 本身写成 !!. 漏了这条，带大写的 module 一律查不到，
  // 而查不到会被当成「不存在」—— 于是报出一个假的幻觉包。
  assert.equal(escapeGoModulePath('example.com/Acme/RemotePackage'), 'example.com/!acme/!remote!package');
  assert.equal(escapeGoModulePath('a!b'), 'a!!b');
  assert.equal(escapeGoModulePath('lower/case'), 'lower/case');
});

test('package names are normalised per registry', () => {
  assert.equal(normaliseName('OpenCV_Python', 'pypi'), 'opencv-python');
  // Rust 源码写 actix_web，包名是 actix-web。
  assert.equal(normaliseName('actix_web', 'cargo'), 'actix-web');
  assert.equal(normaliseName('React', 'npm'), 'React', 'npm names are case-sensitive');
});

// ---------------------------------------------------------------- 三态

test('a name in neither table is unknown, not missing', () => {
  // 这是整个模块最要紧的一条。把 unknown 当成 missing，规则就变成误报机器。
  assert.equal(seedLookup('some-package-nobody-has-heard-of', 'npm').verdict, 'unknown');
  assert.equal(seedLookup('express', 'npm').verdict, 'exists');
  const fake = seedLookup('express-rate-limit-flex', 'npm');
  assert.equal(fake.verdict, 'missing');
  assert.deepEqual(fake.replacements, ['express-rate-limit']);
});

test('only a 404 means the package does not exist', async () => {
  clearPackageCache();
  const stub = (status) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => ({}) });

  assert.equal(await verifyPackage('a', 'npm', stub(200)), 'exists');
  assert.equal(await verifyPackage('b', 'npm', stub(404)), 'missing');
  // 429 and 5xx are "could not check", which is the whole point.
  assert.equal(await verifyPackage('c', 'npm', stub(429)), 'unknown');
  assert.equal(await verifyPackage('d', 'npm', stub(500)), 'unknown');
});

test('a network failure is not cached', async () => {
  // DeepSec 的注释：把瞬时失败写进缓存 would suppress verification after
  // connectivity recovers — 一次断网就能让某个包在 TTL 里被错误地记成不存在。
  clearPackageCache();
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    throw new Error('offline');
  };
  assert.equal(await verifyPackage('flaky', 'npm', flaky), 'unknown');
  assert.equal(await verifyPackage('flaky', 'npm', flaky), 'unknown');
  assert.equal(calls, 2, 'an unverified result must be retried, not remembered');

  // A definitive answer IS cached.
  let definitive = 0;
  const missing = async () => {
    definitive += 1;
    return { status: 404, ok: false };
  };
  assert.equal(await verifyPackage('gone', 'npm', missing), 'missing');
  assert.equal(await verifyPackage('gone', 'npm', missing), 'missing');
  assert.equal(definitive, 1, 'a confirmed miss is worth remembering');
});

// ---------------------------------------------------------------- 解析

test('hallucinated packages are found in a manifest', () => {
  const manifest = JSON.stringify({
    dependencies: { express: '^4', 'react-virtualized-auto-sizer': '^1', 'secure-jwt-auth': '2' }
  });
  const found = inspect(manifest, 'package.json');
  const names = found.map((f) => f.name);
  assert.ok(names.includes('express'));
  assert.ok(names.includes('react-virtualized-auto-sizer'));
  assert.equal(found.find((f) => f.name === 'react-virtualized-auto-sizer').verdict, 'missing');
  assert.equal(found.find((f) => f.name === 'express').verdict, 'exists');
});

test('scoped npm packages keep both segments', () => {
  const src = 'import x from "@angular/core";\nimport y from "lodash/fp";';
  const names = inspect(src, 'a.js').map((f) => f.name);
  assert.ok(names.includes('@angular/core'), 'a scoped package is one name, not two');
  assert.ok(names.includes('lodash'), 'a subpath import is still the root package');
});

test('comments and relative imports are not package names', () => {
  const src = '// import "totally-made-up"\nimport a from "./local.js";\nimport b from "lodash";';
  // `lodash` is here so the assertion is not vacuous: a helper that matched nothing
  // would also produce an empty list, and this test would pass while proving nothing.
  // It did exactly that before the mask was fixed.
  assert.deepEqual(inspect(src, 'a.js').map((f) => f.name), ['lodash']);
});

test('python imports are read without swallowing the next line', () => {
  // `[\w.,\s]` used to include newlines, so an `import` with nothing after it ate the
  // following lines and reported them as part of the module name.
  const src = 'import os\nimport torchvision\nfrom torch_vision_utils import x\n# import fake_thing\n';
  const found = inspect(src, 'a.py');
  const names = found.map((f) => f.name);
  assert.ok(names.includes('torchvision'), 'a plain import');
  assert.ok(names.includes('torch_vision_utils'), 'a from-import');
  assert.equal(names.some((n) => n.includes('\n')), false, 'no name may contain a newline');
  assert.equal(names.includes('fake_thing'), false, 'a commented import is not code');
});

test('requirements.txt is parsed per line', () => {
  const req = 'express==4.18.2\n# a comment\nreact-virtualized-auto-sizer>=1.0\n-r other.txt\n';
  const names = inspect(req, 'requirements.txt').map((f) => f.name);
  assert.ok(names.includes('express'));
  assert.ok(names.includes('react-virtualized-auto-sizer'), 'version specifiers are stripped');
  assert.equal(names.some((n) => n.startsWith('-')), false, 'pip options are not packages');
});
