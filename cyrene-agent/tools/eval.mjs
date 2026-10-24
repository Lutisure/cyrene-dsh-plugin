/**
 * 评测台入口：跑 L1（检索），可选跑 L0（材料）与 L2（文风）。
 *
 *    L0 材料   扫源文件本身：混合行尾、她自己不该用的写法。
 *    L1 检索   断言注入了什么。**不需要模型、不花钱、一秒跑完。**
 *    L2 文风   断言输出的字面特征。用真实 transcript 跑，不用假想的样本。
 *
 * 三层各在一个文件里（eval/l0.mjs、eval/l1.mjs、eval/l2.mjs），共用底座在
 * eval/shared.mjs。这个文件只负责读参数、把三层串起来、打印报告。
 *
 * 跑的顺序是 L1 → L0 → L2，和拆之前一致 —— 报告是按「哪一层先出现」分组的。
 *
 * ## 用法
 *
 *   node tools/eval.mjs                          # 只跑 L1
 *   node tools/eval.mjs --transcript <file>      # L1 + L2（文件里是她的输出）
 *   node tools/eval.mjs --session                # 挑最近的一份会话当 transcript
 *   node tools/eval.mjs --after /cyrene          # 只量这个标记之后的输出
 *   node tools/eval.mjs --json
 */
import { readFileSync } from 'node:fs';
import {
  ROOT, REPO_ROOT, yaml, newestSession,
  buildWorldbook, DEFAULT_LIMIT, DEFAULT_BUDGET
} from '../eval/shared.mjs';
import { runL0 } from '../eval/l0.mjs';
import { runL1 } from '../eval/l1.mjs';
import { runL2 } from '../eval/l2.mjs';

const argv = process.argv.slice(2);
const argOf = (name) => { const at = argv.indexOf(name); return at === -1 ? null : (argv[at + 1] ?? null); };
const AS_JSON = argv.includes('--json');
const USE_SESSION = argv.includes('--session');
const TRANSCRIPT = USE_SESSION ? newestSession() : argOf('--transcript');
/**
 * 只统计**最后一次**出现这个标记之后的内容。
 *
 * 为什么需要它：同一个会话里通常混着两种身份 —— 当工程 agent 干活的时候
 * （写代码、报进度）和切进角色的时候。前者本来就该用 ✓、本来就该写
 * 「不是……而是……」，拿它去量文风是量错了对象。传 `--after /cyrene`
 * 就只看角色那一部分。
 */
const AFTER = argOf('--after');

const book = buildWorldbook(yaml.load(readFileSync(`${ROOT}/worldbook/entries.yaml`, 'utf8')));
const byId = new Map(book.entries.map((entry) => [entry.id, entry]));
const results = [];
const record = (layer, name, ok, detail) => results.push({ layer, name, ok, detail });

const ctx = { record, book, byId, TRANSCRIPT, AFTER, argv };

await runL1(ctx);
runL0(ctx);
runL2(ctx);

// ── 报告 ────────────────────────────────────────────────────────────────

if (AS_JSON) {
  console.log(JSON.stringify({ results, entries: book.entries.length, limits: { DEFAULT_LIMIT, DEFAULT_BUDGET } }, null, 1));
} else {
  const layers = [...new Set(results.map((r) => r.layer))];
  for (const layer of layers) {
    const rows = results.filter((r) => r.layer === layer);
    const bad = rows.filter((r) => !r.ok).length;
    console.log(`\n  ${layer}  ${rows.length - bad}/${rows.length} 通过`);
    for (const row of rows) {
      console.log(`    ${row.ok ? 'ok  ' : 'FAIL'} ${row.name}`);
      if (!row.ok) console.log(`         ${row.detail}`);
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n  世界书 ${book.entries.length} 条 · 上限 ${DEFAULT_LIMIT} 条 / ${DEFAULT_BUDGET} 字`);
  console.log(`  合计 ${results.length - failed}/${results.length}${TRANSCRIPT ? '' : '（L2 未跑：加 --transcript <文件>）'}`);
}
process.exit(results.some((r) => !r.ok) ? 1 : 0);
