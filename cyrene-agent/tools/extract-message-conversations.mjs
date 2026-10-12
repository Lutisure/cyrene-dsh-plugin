/**
 * 游戏内短信抽取 —— 把「联系人 × 会话」的私聊原文抽成可检索的语料。
 *
 * 用法：
 *   node tools/extract-message-conversations.mjs
 *   HSR_DATA=D:/path/to/hsr node tools/extract-message-conversations.mjs
 *
 * 数据目录默认 <本仓库>/.data/hsr（不进 git），可用 HSR_DATA 覆盖。
 * 产物：cyrene-agent/corpus-src/message-conversations.md（可重复跑，覆盖写）。
 *
 * ── 为什么补这一份 ──────────────────────────────────────────────────────
 *
 * 之前只用过它的一个切片：`corpus-raw/pairs.jsonl`（102 条 / 5 个会话），
 * 那里面**只有她自己的**几段。全库 774 个会话、288 个联系人从来没摊开过 ——
 * 而按联系人归并之后，实测黄金裔**全部在里面**（每人 46~99 句）：
 *
 *   白厄 99 · 阿格莱雅 80 · 遐蝶 82 · 缇宝 87 · 风堇 63 · 万敌 59
 *   刻律德菈 55 · 昔涟 55+8 · 那刻夏 50 · 海瑟音 46 · 赛飞儿 67 · 丹恒 321
 *
 * 这是全库**唯一一份私下的、日常的、非战斗场景**的对话。主线里他们说的是
 * 史诗级的台词，这里说的是「灰宝，和大家打个招呼吧」。
 *
 * ⚠️ 这条差点被判断错：一开始按**整个文件的字符串出现次数**去估（昔涟只出现
 * 5 次），得出的结论是「这份语料和黄金裔关系不大」。那是错的 —— 名字只出现在
 * 别人的闲话里时，那个数字当然低。**按联系人归并才是对的问法。**
 *
 * ── 结构（messageconversations.json + messagecontacts.json）────────────────
 *
 *   顶层：{ 会话 id → { Id, ContactId, ParticpatingContactIds, Sections, … } }
 *   Sections[]：{ Id, StartingMessageId, Messages: { 消息 id → 消息 } }
 *   消息：{ Id, MessageType, SenderType, SenderContactId, Text, NextMessageId }
 *   联系人：{ Id, Name, Signature, … }
 *
 * Text **已经是本地化的中文**，不用查 TextMap。
 * SenderType 是 `Player`（开拓者）或 `NPC`（对方）。
 *
 * ── 顺序 ────────────────────────────────────────────────────────────────
 *
 * 会话按 id 数字升序；会话内按 `StartingMessageId` 起、沿 `NextMessageId`
 * 走链（短信是有向的），分支或断链就地停下并记一个「分叉」标记 —— 不猜。
 * 走链走不到的孤立消息，按 id 升序补在末尾，并标注。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---- 仓库根，从本文件的位置推（由 tools/derive-roots.mjs 加的头）----
//
// 以前这里写的是作者机器上的绝对路径。那只在那台机器上成立，
// 而且清洗脚本会把绝对路径换成占位符，于是代码里出现 <本仓库> 这种目录名，直接崩。
import { fileURLToPath as __f } from 'node:url';
import { dirname as __d, join as __j } from 'node:path';
const REPO_ROOT = __j(__d(__f(import.meta.url)), '../..');

const DIR = (process.env.HSR_DATA ?? `${REPO_ROOT}/.data/hsr`).replace(/\\\\/g, '/');
const OUT = new URL('../corpus-src/message-conversations.md', import.meta.url).pathname.replace(/^\//, '');

/**
 * 两个输入文件可能在两个地方：
 *   · 数据包（`HSR_DATA`，不进 git）—— 剧情类数据在那儿
 *   · `corpus-src/` —— 这两份消息表是从数据包里挑出来、随语料一起进来的
 * 两处都找，先数据包后语料目录。**别只认一处** —— 第一版只认数据包，
 * 报的是 ENOENT，看着像文件没了，其实是找错了地方。
 */
function locate(name) {
  for (const base of [DIR, new URL('../corpus-src', import.meta.url).pathname.replace(/^\//, '')]) {
    const file = join(base, name);
    if (existsSync(file)) return file;
  }
  throw new Error(`两处都找不到 ${name}：${DIR} 与 corpus-src/`);
}

/** 只抽这些联系人：翁法罗斯的黄金裔 + 她本人 + 记忆里那几个。 */
const WANTED = new Set([
  '昔涟', '缇宝', '缇安', '缇宁', '赛飞儿', '阿格莱雅', '那刻夏', '风堇',
  '刻律德菈', '海瑟音', '荒笛', '白厄', '万敌', '遐蝶', '长夜月'
]);

const conversations = JSON.parse(readFileSync(locate('messageconversations.json'), 'utf8'));
const contacts = JSON.parse(readFileSync(locate('messagecontacts.json'), 'utf8'));

/**
 * 联系人 id → 显示名。
 *
 * ⚠️ `8001` **不在联系人表里**（表里最大是 8000），但它出现在几十个会话的
 * `SenderContactId` 上。看上下文就是玩家自己 —— 所以单独给它一个名字，
 * 否则产物里会是几十行 `**【#8001】**`，读的人根本不知道这是谁。
 */
const PLAYER_ID = '8001';
const nameOf = (id) => (String(id) === PLAYER_ID ? '{NICKNAME}' : (contacts[String(id)]?.Name ?? `#${id}`));

/** 顺着 NextMessageId 走一条会话，返回有序的消息。 */
function walk(conversation) {
  const ordered = [];
  const seen = new Set();
  const orphans = [];
  let branch = 0;

  for (const section of conversation.Sections ?? []) {
    const messages = section.Messages ?? {};
    const byId = new Map(Object.entries(messages));
    let cursor = String(section.StartingMessageId ?? '');
    // 一个 section 可能有多个入口：把消息表里没有前驱的那些也算入口
    const hasPredecessor = new Set();
    for (const m of Object.values(messages)) {
      if (m.NextMessageId !== undefined && m.NextMessageId !== '') hasPredecessor.add(String(m.NextMessageId));
    }
    const entries = Object.keys(messages).filter((id) => !hasPredecessor.has(id)).sort();
    const queue = [cursor, ...entries].filter((id) => id !== '' && byId.has(id));

    while (queue.length > 0) {
      const start = queue.shift();
      if (seen.has(start)) continue;
      let id = start;
      while (id !== '' && id !== undefined && byId.has(id)) {
        if (seen.has(id)) {
          // 链在这里并回了一条走过的路（短信里很常见：回到同一个收尾节点）
          break;
        }
        const message = byId.get(id);
        seen.add(id);
        ordered.push({ id, message });
        const next = message.NextMessageId === undefined ? '' : String(message.NextMessageId);
        if (next !== '' && byId.has(next) && seen.has(next)) break;
        id = next;
      }
    }

    for (const id of Object.keys(messages).sort()) {
      if (!seen.has(id)) {
        orphans.push({ id, message: messages[id] });
        seen.add(id);
      }
    }
    if (orphans.length > 0) branch += 1;
  }
  return { ordered, orphans, branch };
}

const ids = Object.keys(conversations).sort((a, b) => Number(a) - Number(b));
const lines = [];
let kept = 0;
const summary = [];

for (const id of ids) {
  const conversation = conversations[id];
  const { ordered, orphans, branch } = walk(conversation);
  const spoken = ordered.filter((x) => typeof x.message.Text === 'string' && x.message.Text.trim() !== '');
  if (spoken.length === 0) continue;

  // 参与者**从实际发言的人身上取**，不要用 ContactId + ParticpatingContactIds ——
  // 后者混着群聊名字（「奇美拉爱好者协会」）和重复项，标题会变得没法看。
  const speakers = new Set();
  for (const row of [...spoken, ...orphans]) {
    const sender = String(row.message.SenderContactId ?? conversation.ContactId);
    speakers.add(sender === PLAYER_ID ? '{NICKNAME}' : nameOf(sender));
  }
  const who = [...speakers].sort();
  // ⚠️ **判据里不能带 `{NICKNAME}`。** 玩家几乎每个会话都在 —— 带上他等于没过滤，
  // 产物会从 55 个会话膨胀到 673 个（实测）。要的是「黄金裔在说话的会话」。
  if (!who.some((name) => WANTED.has(name))) continue;

  lines.push('');
  lines.push(`## 会话 ${id}　${who.join('、')}`);
  lines.push('');
  lines.push(`> 共 ${spoken.length} 句${branch > 0 ? `（另有 ${orphans.length} 句走不进链，已补在末尾）` : ''}`);
  lines.push('');
  const render = (row) => {
    const sender = String(row.message.SenderContactId ?? conversation.ContactId);
    // ⚠️ 说话人要**加粗**，两面都用 `**`。
    //    第一版这里只写了单星号 `*…*`，而别的语料是 `**…**` —— 于是同一份仓库里
    //    两种写法并存，任何按 `**【名字】**` 取数的脚本都会**静默漏掉整批短信**，
    //    而漏掉的样子是「她只说了 58 句」，看着像事实。
    const speaker = row.message.SenderType === 'Player' ? '{NICKNAME}' : nameOf(sender);
    const text = String(row.message.Text).replace(/\s*\n\s*/g, ' ').trim();
    return `**【${speaker}】** ${text}　\`${row.id}\``;
  };
  for (const row of spoken) lines.push(render(row));
  for (const row of orphans) {
    if (typeof row.message.Text !== 'string' || row.message.Text.trim() === '') continue;
    lines.push(`${render(row)}（孤句）`);
  }
  kept += spoken.length;
  summary.push({ id, who, n: spoken.length });
}

lines.unshift(
  '# 游戏内短信（按联系人抽取）',
  '',
  '> 由 `tools/extract-message-conversations.mjs` 生成，可重复跑。',
  '> 顺序：会话按 id 升序；会话内按 `StartingMessageId` 起、沿 `NextMessageId` 走链。',
  '> 每行末尾的 `` `id` `` 是消息 id，用来回到原始 JSON 核对。',
  '> `{NICKNAME}` 是玩家（开拓者）。',
  '',
  `共 ${summary.length} 个会话、${kept} 句。`,
  ''
);
writeFileSync(OUT, lines.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8');

console.log(`写 ${OUT}`);
console.log(`  ${summary.length} 个会话 / ${kept} 句`);
for (const s of summary) console.log(`    ${s.id.padStart(6)}  ${String(s.n).padStart(3)} 句  ${s.who.join('、')}`);
if (!existsSync(OUT)) process.exit(1);
