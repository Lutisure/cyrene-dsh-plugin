/**
 * URL 白名单守卫。
 *
 * 这些用例的存在本身就是这一轮的产出：安全扫描器对 `tools/fetch-hsr-data.mjs`
 * 报过**三次**「fetch 的地址来自外部输入」，而之前「是误报」这个判断只写在注释里。
 * 没有人验过它。
 *
 * 现在有一批绕过尝试在验：userinfo 伪装、后缀伪装、尾点、IDN 同形字、
 * IP 字面量、云元数据地址、非 https 协议、畸形输入。
 *
 * ⚠️ 有一条**故意**允许的行为（带端口的同主机）—— 见文件末尾那条测试。
 * 那是当前行为，不是疏忽；写下来是因为「没测到」和「测了且确认可以」不是一回事。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { assertSafe, ALLOWED_HOST } from '../safe-url.mjs';

test('放行：正常的目标', () => {
  const href = assertSafe(`https://${ALLOWED_HOST}/DimbreathBot/TurnBasedGameData/main/ExcelOutput/TextMapCHS.json`);
  assert.ok(href.startsWith(`https://${ALLOWED_HOST}/`), href);
});

test('放行：主机名大小写不敏感', () => {
  assert.doesNotThrow(() => assertSafe('https://RAW.GITHUBUSERCONTENT.COM/x'));
});

test('拒绝：非 https', () => {
  for (const url of [
    'http://raw.githubusercontent.com/x',
    'file:///C:/Windows/System32/config/SAM',
    'data:text/html,<script>x</script>',
    'javascript:alert(1)',
    'ftp://raw.githubusercontent.com/x'
  ]) {
    assert.throws(() => assertSafe(url), /https/, url);
  }
});

test('拒绝：别的主机', () => {
  for (const url of ['https://example.com/x', 'https://github.com/x', 'https://gist.githubusercontent.com/x']) {
    assert.throws(() => assertSafe(url), /只允许/, url);
  }
});

test('拒绝：后缀伪装', () => {
  // 这两个是白名单最常见的写错方式 —— 用 endsWith 或者 includes 就会放过去。
  for (const url of [
    'https://evil-raw.githubusercontent.com/x',
    'https://raw.githubusercontent.com.evil.com/x',
    'https://notraw.githubusercontent.com/x'
  ]) {
    assert.throws(() => assertSafe(url), /只允许/, url);
  }
});

test('拒绝：尾点主机名', () => {
  // `raw.githubusercontent.com.` 是合法的绝对域名写法，DNS 会解析成同一台。
  // 用字符串相等比对会拒掉它 —— 这是偏保守的方向，是对的。
  assert.throws(() => assertSafe('https://raw.githubusercontent.com./x'), /只允许/);
});

test('拒绝：IDN 同形字', () => {
  // 把第一个字母换成西里尔字母 а。URL 会把它转成 punycode，字符串比对因此不相等。
  assert.throws(() => assertSafe('https://r\u0430w.githubusercontent.com/x'), /只允许/);
});

test('拒绝：内网与云元数据地址', () => {
  for (const url of [
    'https://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'https://127.0.0.1:19387/',
    'https://localhost/x',
    'https://10.0.0.1/x',
    'https://192.168.1.1/x',
    'https://172.16.0.1/x',
    'https://172.31.255.255/x',
    'https://0.0.0.0/x'
  ]) {
    assert.throws(() => assertSafe(url), /内网|云元数据/, url);
  }
});

test('内网判定必须真的能触发', () => {
  // 这条盯的是一个具体的退化：守卫第一版把「主机名相等」放在「内网判定」之前，
  // 于是内网那一支**永远执行不到** —— 要先等于 raw.githubusercontent.com 才走得到，
  // 而那不是内网地址。一段永远不执行的检查比没有更糟，它让人以为挡了。
  //
  // 所以这里指定一个内网主机当白名单，确认闸门在它自己那一层就拦住。
  assert.throws(() => assertSafe('https://169.254.169.254/x', '169.254.169.254'), /内网|云元数据/);
});

test('拒绝：畸形输入', () => {
  for (const bad of ['', 'not a url', '//raw.githubusercontent.com/x', 'https://', null, undefined, 42]) {
    assert.throws(() => assertSafe(bad), Error, String(bad));
  }
});

test('userinfo 伪装：真正的目标由 hostname 决定', () => {
  // 左边这个的 hostname 是 raw.githubusercontent.com，请求确实发到那里，放行是对的。
  assert.doesNotThrow(() => assertSafe('https://evil.com@raw.githubusercontent.com/x'));
  // 右边这个的 hostname 是 evil.com —— 这一条才是攻击写法，必须拒。
  assert.throws(() => assertSafe('https://raw.githubusercontent.com@evil.com/x'), /只允许/);
});

test('⚠️ 当前行为：同主机可以带非标准端口', () => {
  // `hostname` 不含端口，所以 `raw.githubusercontent.com:8443` 通过。
  // 判定：同一个主机，不构成 SSRF，可以接受 —— 但这个脚本只抓静态文件，
  // 收紧到默认端口更干净。留这条测试是为了让它是**已知行为**而不是漏网。
  assert.doesNotThrow(() => assertSafe('https://raw.githubusercontent.com:8443/x'));
});
