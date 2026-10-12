import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// ---- 仓库根，从本文件的位置推（由 tools/derive-roots.mjs 加的头）----
//
// 以前这里写的是作者机器上的绝对路径。那只在那台机器上成立，
// 而且清洗脚本会把绝对路径换成占位符，于是代码里出现 <本仓库> 这种目录名，直接崩。
import { fileURLToPath as __f } from 'node:url';
import { dirname as __d, join as __j } from 'node:path';
const REPO_ROOT = __j(__d(__f(import.meta.url)), '../..');
const require = createRequire(`${REPO_ROOT}/cyrene-agent/x.js`);
const yaml = require('js-yaml');

// ⚠️ 这里原来还是写死的 `'<本仓库>/cyrene-agent/worldbook/entries.yaml'`。
//
// 上面第 4-10 行**已经**加了 `REPO_ROOT` 的推导，注释里还写明了「清洗脚本会把绝对路径
// 换成占位符，于是代码里出现 <本仓库> 这种目录名，直接崩」—— **而这一行没跟着改。**
//
// 2026-10-11 在干净机器上实测，它就是崩的那一个：
//
//     Error: ENOENT: no such file or directory, open
//       '...\<本仓库>\cyrene-agent\worldbook\entries.yaml'
//
// **「修了一半」比没修更难发现** —— 文件头看起来已经改过了。
const doc = yaml.load(readFileSync(`${REPO_ROOT}/cyrene-agent/worldbook/entries.yaml`, 'utf8'));
const e = doc.entries.find((x) => x.id === 'mydei-who');
const NL = String.fromCharCode(10);

console.log('  ① id 是字符串，不是嵌套结构');
console.log('     id = ' + JSON.stringify(e.id) + '   类型 ' + typeof e.id);
console.log('     字段 = ' + Object.keys(e).join(', '));
console.log('     → 「-who / -did / -people」是 id 的后缀，不是独立的 YAML 键');

console.log('');
console.log('  ② 折叠块在运行时有没有留下换行');
const count = (e.text.match(new RegExp(NL, 'g')) ?? []).length;
console.log('     正文 ' + e.text.length + ' 字，换行符 ' + count + ' 个');
console.log('     开头：' + e.text.slice(0, 64));
console.log('     → ' + (count === 0 ? '没有换行，是一整段' : '✗ 有换行'));

console.log('');
console.log('  ③ 全库：所有条目的 text 都不含换行');
const bad = doc.entries.filter((x) => x.text.includes(NL)).map((x) => x.id);
console.log('     ' + (bad.length === 0 ? doc.entries.length + ' 条全部通过' : '✗ 有换行的：' + bad.join(', ')));

console.log('');
console.log('  ④ 全库出现过的字段名');
const keys = new Set(doc.entries.flatMap((x) => Object.keys(x)));
console.log('     ' + [...keys].join(', '));
console.log('     读取代码只认 id / triggers / priority / text —— 「-did」不在字段里，无从误读');

console.log('');
console.log('  ⑤ 那批条目在库里的样子（前两条）');
for (const id of ['mydei-who', 'mydei-did', 'castorice-death']) {
  const x = doc.entries.find((y) => y.id === id);
  console.log('     ' + id.padEnd(18) + ' priority ' + x.priority + '   ' + x.text.length + ' 字');
}
