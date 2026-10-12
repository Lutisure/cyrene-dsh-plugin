/**
 * 校验一个 URL 是不是「我们只从这一台主机抓东西」。
 *
 * ## 为什么单独一个文件
 *
 * 原先它埋在 `tools/fetch-hsr-data.mjs` 里，而那个脚本是**顶层可执行**的 ——
 * 一 import 就会 mkdir、发十三个请求、克隆仓库。于是这个守卫一行测试都没有，
 * 而它偏偏是「脚本只从哪抓东西」这件事的**唯一**依据。
 *
 * 安全扫描器对这个脚本报过三次「fetch 的地址来自外部输入」。三次都是误报 ——
 * 但「是误报」这个判断，之前只写在注释里，没有任何东西验它。
 * 搬出来之后它能被测，那句话才从断言变成结论。
 *
 * ## 这台主机是写死的
 *
 * `ALLOWED_HOST` 和 `TABLES` 都是常量，没有任何外部输入能进到 URL 里。
 * 守卫的价值不在拦当下的输入，在于**以后有人改这两个常量时会被拦住**。
 *
 * @param {unknown} url - 待校验的 URL 字符串。
 * @param {string} [allowedHost] - 允许的主机名；默认 raw.githubusercontent.com。
 * @returns {string} 规范化之后的 href。
 * @throws {Error} 任何一项不合规时。
 */
export const ALLOWED_HOST = 'raw.githubusercontent.com';

/** 内网与云元数据网段。云元数据那条最要紧——它是拿到实例凭据的经典跳板。 */
const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|0\.0\.0\.0$)/i;

export function assertSafe(url, allowedHost = ALLOWED_HOST) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error('不是合法的 URL：' + String(url).slice(0, 80));
  }

  if (parsed.protocol !== 'https:') throw new Error('只走 https，拒绝 ' + parsed.protocol);

  // 内网判定放在主机名相等之前。
  //
  // 原先是反过来的，于是这一条**永远不可能触发** —— 主机名必须先等于
  // raw.githubusercontent.com 才走得到这里，而那不是内网地址。一段永远不会
  // 执行的检查比没有更糟：它让人以为挡了，实际没挡。
  // 现在它自己就是一道闸，将来 allowedHost 变成列表或者可配置时它仍然有效。
  if (PRIVATE.test(parsed.hostname)) {
    throw new Error('拒绝内网或云元数据地址：' + parsed.hostname);
  }

  // 精确相等。不做后缀匹配 —— `evil-raw.githubusercontent.com` 和
  // `raw.githubusercontent.com.evil.com` 都会因此被拒。
  if (parsed.hostname !== allowedHost) {
    throw new Error('只允许 ' + allowedHost + '，拒绝 ' + parsed.hostname);
  }

  return parsed.href;
}
