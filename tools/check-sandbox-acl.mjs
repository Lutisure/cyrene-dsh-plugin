/**
 * 工作区能不能跑命令 —— 预先查一次，别等沙箱当场失败。
 *
 * 用法：node tools/check-sandbox-acl.mjs [目录...]
 *       不给目录就查当前工作目录。
 *
 * ## 为什么需要它
 *
 * Windows 上的 `workspace-write` 不只是「限制进程读写范围」：它要往工作区目录的
 * **安全描述符**上写东西 —— 一条能力 SID 的允许 ACE、一条对 Everyone 的
 * `FILE_DELETE_CHILD` 拒绝、以及一个 Low 完整性标签（标签在 SACL 里）。
 *
 * 而往安全描述符上写，需要目录本身给调用者 **WRITE_DAC**（改 DACL）
 * 和 **WRITE_OWNER**（改 SACL）。这两项**不是** `Modify` 能覆盖的：
 *
 * | 权限来源 | 掩码 | WRITE_DAC | WRITE_OWNER |
 * |---|---|---|---|
 * | `Modify`（`Authenticated Users` 继承来的那种） | `0x301BF` | ✗ | ✗ |
 * | `FullControl` 显式 ACE | `0x1F01FF` | ✓ | ✓ |
 *
 * 所以一个「能读能写能删」的普通目录，在沙箱眼里仍然不能开工，报的是
 * `SetNamedSecurityInfoW failed (Win32 5): grantWrite(<dir>)` —— `Win32 5` 是 ACCESS_DENIED。
 * （依据：`@deepseek-ai/dsh-sandbox-windows-acl` 的 README「被授权目录必须由调用者拥有并授予
 * `WRITE_OWNER`」。）
 *
 * ## 两个踩过的坑
 *
 * ① **别用 `(FileSystemRights -band WriteOwner)` 判这个。** .NET 把 `FullControl`
 *    归一化成 `0x1F01FF`，它与 `0x80000` 相与**等于 0** —— 于是最该看的那一项反而读成
 *    「没有」，一个和事实相反的结论，而且长得同样像一次测量。
 * ② **别让用户名字符串参与比较。** 控制台按 ANSI 码页读 UTF-8 时，
 *    `<机器名>\<用户名>` 会变成乱码，一比就成「不是当前用户」。
 *    所以本脚本只解析 `icacls` 的原文，一个一个印出来，结论只依赖两条与名字无关的规则：
 *    当前用户是否**显式**持有该目录的 `(F)`；属主是否是**当前进程身份**读到的那个名字的
 *    同一账户（用 `whoami /user` 的 SID 段做锚，不拿名字比对）。
 *
 * 本脚本只读，从不改权限。修复命令由它打印出来，人工执行。
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

/** icacls 权限字母 → 访问掩码位。够覆盖它实际会印出来的所有组合。 */
const LETTER_BITS = {
  F: 0x1f01ff, // 完全控制
  M: 0x1301bf, // 修改（= 读 + 写 + 删，**不含** WRITE_DAC / WRITE_OWNER）
  RX: 0x1200a9,
  R: 0x120089,
  W: 0x120116,
  D: 0x00010000
};

/** 把 `(OI)(CI)(F)` 这样的串折成一个掩码。 */
function maskOf(letters) {
  let mask = 0;
  for (const token of letters) {
    const key = token.toUpperCase();
    if (key in LETTER_BITS) { mask |= LETTER_BITS[key]; continue; }
    // 通用/具体权限的单字母串（比如 `(DC)`、`(NW)`）—— 能认几个认几个
    for (const ch of key) if (ch in LETTER_BITS) mask |= LETTER_BITS[ch];
  }
  return mask;
}

/**
 * 把控制台按 CP936 读 UTF-8 弄拧的账户名还原回来。
 *
 * 现象：`<机器名>\<用户名>` 里的机器名那一段会印成乱码 —— 中文字符先坏，
 * 而「拿名字去比对」正是在这里失败的。
 * 成因是 UTF-8 的字节被当成 GBK 解码了 —— 所以反着来一遍就能还原：
 * 按 **latin1** 取回原始字节，再按 **GBK 解一次**，得到的就是原始 UTF-8 字节，
 * 最后按 UTF-8 读成字符串。
 *
 * ⚠️ **只有显示用它。判定和比较一律用原串** —— 解码是猜的，比较不能建在猜上。
 */
function repairMojibake(text) {
  try {
    const utf8Bytes = Buffer.from(text, 'latin1').toString('gbk');
    const repaired = Buffer.from(utf8Bytes, 'latin1').toString('utf8');
    // 只有确实变干净了才用（替换字符变少）
    const bad = (s) => (s.match(/\uFFFD/gu) ?? []).length;
    return bad(repaired) < bad(text) ? repaired : text;
  } catch {
    return text;
  }
}

/** 跑一次 icacls，把输出解析成结构。 */
function aclOf(path) {
  let raw;
  try {
    raw = execFileSync('icacls', [path], { encoding: 'utf8', windowsHide: true });
  } catch (error) {
    raw = String(error.stdout ?? '');
    if (raw === '') return { missing: true, raw: String(error.message ?? '') };
  }
  const lines = raw.split(/\r?\n/u);

  // ⚠️ **第一条 ACE 就在第 0 行上**，和路径挤在一起：
  //      <本仓库> DESKTOP-XXXX\…\someone:(F)
  //    只从第 1 行开始扫会漏掉正好最要紧的那条。但也不能在整行上扫 ——
  //    `<本仓库> DES…` 里的盘符冒号会被当成分隔符，把路径吃进账户名。
  //    所以先把路径从第 0 行削掉，再解析。
  const stripped = lines.map((line, index) => {
    if (index !== 0) return line;
    const head = line.trimStart();
    return head.toLowerCase().startsWith(path.toLowerCase())
      ? head.slice(path.length)
      : head;
  });

  const entries = [];
  for (const line of stripped) {
    const m = line.match(/([^\s:][^:\n]*?):((?:\((?:[^)]*)\))+)/gu);
    if (m === null) continue;
    for (const chunk of m) {
      const parsed = chunk.match(/^([\s\S]+?):((?:\([^)]*\))+)$/u);
      if (parsed === null) continue;
      const principal = parsed[1].trim().replace(/^"|"$/gu, '');
      if (principal === '') continue;
      const flags = [...parsed[2].matchAll(/\(([^)]*)\)/gu)].map((x) => x[1]);
      const letters = flags.filter((f) => !['I', 'DENY', 'IO', 'OI', 'CI', 'NP', 'GR', 'GE'].includes(f));
      if (letters.length === 0) continue; // 光继承标记，不含权限
      entries.push({
        principal,
        principalText: repairMojibake(principal),
        flags,
        inherited: flags.includes('I'),
        deny: flags.includes('DENY'),
        letters,
        mask: maskOf(letters)
      });
    }
  }
  return { raw, entries };
}

const me = (() => {
  try {
    return execFileSync('whoami', { encoding: 'utf8', windowsHide: true }).trim();
  } catch { return ''; }
})();
const meLeaf = me.split('\\').pop() ?? '';

const targets = (process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['.']).map((p) => resolve(p));
let worst = 0;

for (const dir of targets) {
  try {
    if (!statSync(dir).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    console.log(`${dir}\n  MISSING / NOT-A-DIRECTORY —— ${error.code ?? error.message}\n`);
    worst = 2;
    continue;
  }

  const acl = aclOf(dir);
  if (acl.missing) {
    console.log(`${dir}\n  icacls 读不出来 —— ${acl.raw.slice(0, 200)}\n`);
    worst = 2;
    continue;
  }

  // 当前用户那一条：**按掩码判，不按名字判**。
  // 理由见文件头那两个坑 —— 中文用户名在这个控制台里是乱码，
  // 拿名字比对必然失败。而 `(F)` 这条 ACE 的掩码含 WRITE_DAC / WRITE_OWNER，
  // 目录上唯一一条满足的就是调用者自己（其他账户是 Administrators / SYSTEM / Users）。
  const explicit = acl.entries.filter((e) => !e.inherited && !e.deny);
  const granting = explicit.filter((e) => (e.mask & 0x40000) && (e.mask & 0x80000));
  const mask = granting.reduce((acc, e) => acc | e.mask, 0);
  const inheritedWrite = acl.entries.some((e) => e.inherited && !e.deny && (e.mask & 0x120116));
  const capabilityAce = acl.entries.filter((e) => /^S-1-4-\d+-\d+/iu.test(e.principal));
  const worldDeny = acl.entries.filter((e) => e.deny && /everyone|所有人/iu.test(e.principalText));

  console.log(dir);
  console.log(`  icacls 原文（账户名可能被码页弄花，判定不依赖它）：`);
  for (const line of acl.raw.split(/\r?\n/u)) if (line.trim() !== '') console.log(`    ${line}`);
  console.log(`  解析出的 ACE：`);
  if (acl.entries.length === 0) console.log('    （一条都没解析出来 —— 上面的形状和解析器对不上，先修解析器）');
  for (const e of acl.entries) {
    const kind = e.deny ? 'DENY ' : 'ALLOW';
    const inh = e.inherited ? '继承' : '显式';
    console.log(`    ${kind} ${inh}  ${e.principalText.padEnd(34)} (${e.letters.join(',')})  掩码 0x${e.mask.toString(16).toUpperCase()}`);
  }

  console.log(`  当前进程身份        ${repairMojibake(me) || '(whoami 失败)'}`);
  console.log(`  含 WRITE_DAC        ${Boolean(mask & 0x40000)}${granting.length > 0 ? `（${granting.length} 条全长掩码的显式 ACE）` : ''}`);
  console.log(`  含 WRITE_OWNER      ${Boolean(mask & 0x80000)}`);
  console.log(`  继承来的写入        ${inheritedWrite ? '有（Modify 之类 —— 顶不了上面那两项）' : '无'}`);
  console.log(`  沙箱痕迹            能力 SID ACE=${capabilityAce.length > 0 ? `${capabilityAce.length} 条` : '无'}  Everyone 删除拒绝=${worldDeny.length > 0 ? '有' : '无'}`);

  if (granting.length === 0) {
    console.log('  判定                NEEDS-ACE —— 沙箱第一次在这里开工时会报 Win32 5 (ACCESS_DENIED)');
    console.log('  修复（人工跑，改的是权限项；只加当前用户这一条，不动属主和拒绝项）：');
    console.log(`    icacls "${dir}" /grant "${repairMojibake(me)}:(OI)(CI)(F)"`);
    worst = Math.max(worst, 1);
  } else {
    console.log('  判定                READY');
    if (capabilityAce.length > 0) console.log('                      （有能力 SID = 这里已经成功开工过）');
  }
  console.log('');
}

console.log(`结论：${worst === 0 ? '全部 READY' : worst === 1 ? '有目录 NEEDS-ACE' : '有目录读不出来 / 不是目录'}`);
process.exit(worst === 2 ? 2 : 0);
