/**
 * 行尾助手。
 *
 * 这一组用例的由来：一个九行的小脚本因为行尾调试了三轮，而且每次都报错报到别处去。
 * 所以把「怎么判断、怎么保住、怎么统一」固定下来，配测试。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { countEol, detectEol, isMixed, joinLines, normalizeEol, replaceLine } from '../eol.mjs';

test('detectEol：多数决', () => {
  assert.equal(detectEol('a\r\nb\r\nc\n'), '\r\n');
  assert.equal(detectEol('a\nb\nc\r\n'), '\n');
  assert.equal(detectEol('a\nb'), '\n');
  assert.equal(detectEol('a\r\nb'), '\r\n');
  // 没有任何换行的短文本按 LF
  assert.equal(detectEol('abc'), '\n');
  assert.equal(detectEol(''), '\n');
});

test('isMixed：真的混了才算', () => {
  assert.equal(isMixed('a\r\nb\r\n'), false);
  assert.equal(isMixed('a\nb\n'), false);
  assert.equal(isMixed('a\r\nb\n'), true);
  assert.equal(isMixed('a\nb\r\n'), true);
});

test('countEol：数得准', () => {
  assert.deepEqual(countEol('a\r\nb\r\nc\n'), { crlf: 2, lf: 1, mixed: true });
  assert.deepEqual(countEol('a\nb\n'), { crlf: 0, lf: 2, mixed: false });
  assert.deepEqual(countEol('a\r\nb\r\n'), { crlf: 2, lf: 0, mixed: false });
});

test('normalizeEol：两个方向都不留残渣', () => {
  assert.equal(normalizeEol('a\r\nb\nc', '\n'), 'a\nb\nc');
  assert.equal(normalizeEol('a\r\nb\nc', '\r\n'), 'a\r\nb\r\nc');
  // 不能出现 \r\r\n 这种 —— 先统一成 \n 再换是唯一安全的顺序
  assert.equal(normalizeEol('a\r\nb', '\r\n'), 'a\r\nb');
  assert.ok(!normalizeEol('a\r\nb', '\r\n').includes('\r\r'));
});

test('joinLines：按给定行尾拼', () => {
  assert.equal(joinLines(['a', 'b'], '\r\n'), 'a\r\nb');
  assert.equal(joinLines(['a', 'b'], '\n'), 'a\nb');
});

test('⚠️ replaceLine：CRLF 文件里替换一行，不能把 \\r 弄丢', () => {
  // 这是那个 bug 的最小形状。原来的写法是
  //   /^(\s+triggers: )\[.*\]\r?$/m  加  String.replace
  // 而 `\r?` 会把结尾的 \r **吃掉**，替换文本里又没有它，于是那一行变成 LF。
  //
  // `render` 收到的是**整行**（不含行尾），返回的也是整行 —— 第一版这两条用例
  // 写成了「往整行后面追加」，于是拿到的实际值是 `[a, b][a, b, c]`。
  // 断言失败的是测试，不是助手。
  const before = 'x\r\n    triggers: [a, b]\r\ny\r\n';
  const after = replaceLine(before, /^([ \t]+triggers: )\[.*\]\r?$/m, () => '    triggers: [a, b, c]');
  assert.equal(after, 'x\r\n    triggers: [a, b, c]\r\ny\r\n');
  assert.equal(countEol(after).lf, 0, '不该多出一个纯 LF');
  assert.equal(countEol(after).crlf, 3);
});

test('replaceLine：LF 文件里也一样', () => {
  const before = 'x\n    triggers: [a]\ny\n';
  const after = replaceLine(before, /^([ \t]+triggers: )\[.*\]\r?$/m, () => '    triggers: [a, b]');
  assert.equal(after, 'x\n    triggers: [a, b]\ny\n');
  assert.equal(countEol(after).crlf, 0);
});

test('replaceLine：回调确实拿到整行，不含行尾', () => {
  let seen = null;
  replaceLine('x\r\n    triggers: [a]\r\ny\r\n', /^([ \t]+triggers: )\[.*\]\r?$/m, (line) => { seen = line; return line; });
  assert.equal(seen, '    triggers: [a]');
});

test('replaceLine：找不到就原样返回，不改一个字节', () => {
  const before = 'x\r\ny\r\n';
  assert.equal(replaceLine(before, /^([ \t]+nope: )\[.*\]\r?$/m, () => 'zzz'), before);
});

test('⚠️ 行首必须用 [ \\t]+ 而不是 \\s+ —— 后者会吃掉上一行的换行', () => {
  // 这也是那个 bug 的一半：`\s` 匹配 `\n`，所以 `^(\s+triggers: )` 匹配到的
  // 文本是「\n    triggers: 」，从上一行的换行符开始。
  const before = 'x\r\n    triggers: [a]\r\ny\r\n';
  const wrong = /^(\s+triggers: )\[.*\]\r?$/m.exec(before);
  assert.ok(wrong[0].startsWith('\n'), '`\\s+` 果然把上一行的换行吃进来了：' + JSON.stringify(wrong[0]));
  const right = /^([ \t]+triggers: )\[.*\]\r?$/m.exec(before);
  assert.ok(right[0].startsWith('    triggers:'), '用 [ \\t]+ 才是干净的一行：' + JSON.stringify(right[0]));
});
