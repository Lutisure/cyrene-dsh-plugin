/**
 * L1 · 检索。
 *
 * 断言注入了什么：标记命中、条目可达、触发词不误撞、世界书写法干净。
 * **不需要模型、不花钱、一秒跑完。**
 *
 * 要改检索行为，先看这一层；它红了就不用往下看。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import zlib from 'node:zlib';
import { scanEntries, describeFindings } from '../worldbook-injection.mjs';
import {
  ROOT, REPO_ROOT, yaml, PATCH_SCHEMA,
  buildWorldbook, explainEntries, createInjectionLog, DEFAULT_LIMIT, DEFAULT_BUDGET,
  readSession, newestSession
} from './shared.mjs';

/**
 * 跑整套 L1。
 *
 * @param {{record: Function, book: object, byId: Map<string, object>}} ctx
 */
export async function runL1(ctx) {
  const { record, book, byId } = ctx;

// ── L1 检索 ─────────────────────────────────────────────────────────────

/** 跑一个用例，返回每轮的决策（和运行时同样的顺序、同样的调用）。 */
function simulate(testCase) {
  const turns = Number.isFinite(testCase.turns) ? testCase.turns : 1;
  const log = createInjectionLog();
  const rounds = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    log.nextTurn('eval');
    const skip = new Set(book.entries.filter((e) => log.seen('eval', e.id)).map((e) => e.id));
    const decision = explainEntries(book.entries, String(testCase.ask), { skip });
    if (decision.chosen.length > 0) log.record('eval', decision.chosen.map((e) => e.id));
    rounds.push({
      turn,
      ids: decision.chosen.map((e) => e.id),
      chars: decision.chosen.reduce((sum, e) => sum + e.text.length, 0),
      dropped: decision.dropped.map((item) => `${item.entry.id}(${item.reason})`)
    });
  }
  return rounds;
}

const at = (mapping, turn, fallback) => {
  if (mapping === undefined || mapping === null) return fallback;
  if (typeof mapping !== 'object') return mapping;
  return mapping[turn] ?? fallback;
};

const cases = yaml.load(readFileSync(`${ROOT}/eval/retrieval.yaml`, 'utf8'));
for (const testCase of cases) {
  const name = testCase.name;
  try {
    // 覆盖率那一条不是模拟某一轮，是把一群人各扫一遍。
    if (testCase.coverage) {
      const { people, min_entries } = testCase.coverage;
      const thin = people.filter((who) => {
        const hit = book.entries.filter((e) => (e.triggers ?? []).some((t) => String(t).includes(who)));
        return hit.length < min_entries;
      });
      record('L1', name, thin.length === 0, thin.length === 0 ? `${people.length} 位都 ≥${min_entries} 条` : `偏少：${thin.join('、')}`);
      continue;
    }

    const rounds = simulate(testCase);
    const problems = [];

    for (const round of rounds) {
      const { turn } = round;
      const shouldBeEmpty = at(testCase.nonempty, turn, true) === false;
      if (!shouldBeEmpty && round.ids.length === 0) problems.push(`第 ${turn} 轮应当有内容，实际为空`);
      // ⚠️ 这一句曾经缺着：`nonempty: false` 原来**什么都不检查** ——
      // 只做了上面那个方向的断言，于是「这一轮该是空的」是一条**空断言**，
      // 看着像在守着什么，其实永远通过。
      // 这正是这个仓库反复出现的那类错：「没发现问题」和「没有能力发现问题」长得一样。
      if (shouldBeEmpty && round.ids.length > 0) {
        problems.push(`第 ${turn} 轮应当为空，实际注入了 ${round.ids.join('、')}`);
      }

      const want = at(testCase.injected, turn, null);
      if (want) {
        const missing = want.filter((id) => !round.ids.includes(id));
        if (missing.length) problems.push(`第 ${turn} 轮缺少 ${missing.join('、')}`);
      }
      const notWant = at(testCase.not_injected, turn, null);
      if (notWant) {
        const present = notWant.filter((id) => round.ids.includes(id));
        if (present.length) problems.push(`第 ${turn} 轮不该有 ${present.join('、')}`);
      }
    }

    if (testCase.max_entries) {
      const over = rounds.filter((r) => r.ids.length > testCase.max_entries);
      if (over.length) problems.push(`第 ${over.map((r) => r.turn).join('、')} 轮超过 ${testCase.max_entries} 条`);
    }
    if (testCase.max_chars) {
      const over = rounds.filter((r) => r.chars > testCase.max_chars);
      if (over.length) problems.push(`第 ${over.map((r) => `${r.turn}(${r.chars}字)`).join('、')} 轮超过 ${testCase.max_chars} 字`);
    }
    if (testCase.ids_exist) {
      const unknown = rounds.flatMap((r) => r.ids).filter((id) => !byId.has(id));
      if (unknown.length) problems.push(`注入了库里没有的 id：${unknown.join('、')}`);
    }

    record('L1', name, problems.length === 0, problems.length ? problems.join('；') : rounds.map((r) => `${r.ids.length}条`).join(' → '));
  } catch (error) {
    record('L1', name, false, `用例本身出错：${error.message}`);
  }
}

// ── L1 分档提示词（当前没有分档，这一段读到空文件就跳过）────────────────────
//
// 它原来查的是三档模式共用源文件那种情形：几个预设各读一份生成的提示词，
// **改一份会影响几档**，而没有人真正在读那些产物。那个机制**还在**（`persona` 的
// `file` 配置），只是现在两个预设都不配它 —— 所以这里读到 `eval/modes.yaml`
// 会失败、被 catch 住、记一条 skip。
//
// **留着它是因为：要再分档的时候，缺的就是这一段的检查。**
//
// 而下面那条 `corrects_file` 判据是另一次改动的产物，和分档无关 ——
// 它测的是「修正文件有没有被拼进产物」。
//
// 除了查产物里的字面，还查**预设结构**：`complete` 写反、`file` 指错，
// 这两样会让一整个预设白做，而且界面上看不出来（点进去只是「她好像不太一样」）。

try {
  const modeCases = yaml.load(readFileSync(`${ROOT}/eval/modes.yaml`, 'utf8'));
  for (const testCase of modeCases) {
    try {
      const problems = [];

      // ⚠️ `corrects_file`：判据**从源文件现取**，不写死在 yaml 里。
      //
      // 2026-10-10：原来那条断言的是字面 `'不要在句尾挂符号'`。而当天那 7 条修正
      // 被整体重写过（改成「正面规则 + 括号里否定形式」，比原来好），那句话变成了
      // 「不在句尾挂对勾、叉、星号当语气标记」—— 断言当场失效，而**修正根本没丢**。
      //
      // 这条检查要测的是**机制**：修正文件有没有被拼进模式提示词。
      // 所以判据改成「corrections.md 的第一条，出现在产物里」——
      // 文字**跟着源文件走**，改措辞不会再弄坏它，改机制才会。
      if (testCase.corrects_file === true) {
        const source = `${process.env.USERPROFILE ?? process.env.HOME}/.dsh/cyrene-agent/corrections.md`;
        const file = `${ROOT}/dist/${testCase.file}`;
        if (!existsSync(source)) problems.push(`修正文件不在：${source}`);
        else if (!existsSync(file)) problems.push(`产物不在：dist/${testCase.file}`);
        else {
          const first = readFileSync(source, 'utf8').split('\n').find((line) => line.trim().startsWith('- '));
          if (first === undefined) problems.push('修正文件里没有以「- 」开头的条目');
          else {
            // ⚠️ 取判据前先把列表记号**去掉**。
            //
            // 源文件是 `- 对方说无聊…`，而产物里渲染成 `· 对方说无聊…` ——
            // 构建把 `- ` 转成了 `· `。带着前缀去比，永远匹配不上。
            // （第一版就是这么写的，跑出来报「产物里找不到」，
            //   而产物里明明是有的 —— 又是我这边错。）
            //
            // 只取开头一段：尾部的细节（举例、注解）动得更勤，头部的规则最稳。
            const needle = first.trim().replace(/^[-·]\s*/, '').slice(0, 40);
            if (!readFileSync(file, 'utf8').includes(needle)) {
              problems.push(`产物里找不到第一条修正的开头「${needle}」`);
            }
          }
        }
      }

      // 字面检查
      const checks = [
        ...(testCase.contains ?? []).map((needle) => ({ needle, want: true })),
        ...(testCase.notContains ?? []).map((needle) => ({ needle, want: false }))
      ];
      if (checks.length > 0) {
        const file = `${ROOT}/dist/${testCase.file}`;
        if (!existsSync(file)) {
          problems.push(`产物不在：dist/${testCase.file}`);
        } else {
          const body = readFileSync(file, 'utf8');
          for (const { needle, want } of checks) {
            const has = body.includes(needle);
            if (has !== want) problems.push(`${want ? '缺' : '不该有'}「${needle}」`);
          }
        }
      }

      // 体量比
      if (testCase.ratio !== undefined) {
        const small = readFileSync(`${ROOT}/dist/${testCase.ratio.smaller}`, 'utf8').length;
        const large = readFileSync(`${ROOT}/dist/${testCase.ratio.larger}`, 'utf8').length;
        const actual = small / large;
        if (!(actual <= testCase.ratio.maxRatio)) {
          problems.push(`${testCase.ratio.smaller} 是 ${testCase.ratio.larger} 的 ${(actual * 100).toFixed(0)}%，超过 ${(testCase.ratio.maxRatio * 100).toFixed(0)}%`);
        } else {
          problems.push(`（比例 ${(actual * 100).toFixed(0)}%，在线的以内）`);
        }
      }

      const real = problems.filter((line) => !line.startsWith('（'));
      record('L1', testCase.name, real.length === 0, real.length ? real.join('；') : problems.join(' '));
    } catch (error) {
      record('L1', testCase.name ?? '(无名用例)', false, `用例本身出错：${error.message}`);
    }
  }
} catch (error) {
  // ⚠️ 「文件不在」不是失败。
  //
  // `eval/modes.yaml` 属于模式那一套，分享出去的那份刻意没有它（见
  // tools/make-share.mjs）。原来这里一律记成失败，于是导出物里评测台
  // 永远挂着一条红的 —— 而那条红说的是「这个功能不在这份仓库里」，
  // 不是「它坏了」。**把缺席记成故障，真正的故障就淹没在噪音里了。**
  //
  // 区分开：文件确实不在 → 显式跳过并说明；在但读坏了 → 仍然是失败。
  if (error.code === 'ENOENT') {
    process.stdout.write('  skip  读取 eval/modes.yaml —— 文件不在（模式那一套没有随包分发）\n');
  } else {
    record('L1', '读取 eval/modes.yaml', false, error.message);
  }
}

// 预设结构：交给 presets-check.mjs。
//
// 这一段原来在 eval 里手写了一遍，而 tools/check-presets.mjs 里又有一份 ——
// 两份迟早会不一致。现在只有一份，两边都调它。
//
// 它查四件事：五档的 complete / prefix / file 对不对、启用的插件行解析得到吗、
// 禁用行单列（内置预设故意留了没装的插件的禁用行）、以及 **!!js 表达式有没有
// 退化成字符串**（那样 disabled 会拿到非空字符串，shell 工具的启用方向就反了）。
//
// ⚠️ 预设检查属于**模式那一套**，而模式刻意不外发（见 tools/make-share.mjs）。
//    所以这一段：
//
//      · 模块改成**按需动态 import** —— 顶层静态 import 的话，模块不在，
//        整个评测台直接起不来（2026-10-10 实际发生：导出物里 `node tools/eval.mjs`
//        报 ERR_MODULE_NOT_FOUND，一条结果都不出）。
//      · 模块不在时**显式跳过并说明原因**，不是静默通过，也不是失败。
//        「这里没跑」和「这里跑过了」必须看得出区别 —— 这是本仓库自己的规矩。
let checkPresetsFn = null;
try {
  ({ checkPresets: checkPresetsFn } = await import('../presets-check.mjs'));
} catch {
  checkPresetsFn = null;
}

for (const [label, profileDir] of [
  ['web', `${process.env.USERPROFILE ?? process.env.HOME}/.dsh/profiles/web`],
  ['desktop', `${process.env.USERPROFILE ?? process.env.HOME}/.dsh/profiles/desktop`]
]) {
  const name = `${label} profile：昔涟五档的预设结构`;
  if (checkPresetsFn === null) {
    // 显式印一行，但**不调用 record** —— 于是它不进通过数，也不进失败数。
    // 「没跑」就该在总数里缺席，而不是算成通过。
    process.stdout.write(`  skip  ${name} —— presets-check.mjs 不在（模式那一套没有随包分发）\n`);
    continue;
  }
  try {
    const home = process.env.USERPROFILE ?? process.env.HOME;
    const roots = [`${home}/.dsh/profiles/node_modules`, `${profileDir}/node_modules`];
    const { rows, failures } = checkPresetsFn(`${profileDir}/cordis.patch.yml`, roots);
    const ok = rows.filter((row) => row.ok && row.text.trim().startsWith('cyrene')).length;
    record('L1', name, failures === 0,
      failures === 0 ? `${ok} 档结构正确` : rows.filter((row) => !row.ok).map((row) => row.text).join('；'));
  } catch (error) {
    record('L1', name, false, `检查出错：${error.message}`);
  }
}

// ── L1 触发词误命中（负例）──────────────────────────────────────────────
//
// 触发词是子串匹配，而中文里一个汉字不是一个词。误命中是**静默**的：注入内容
// 看起来永远合理，只是不对题 —— 没有人会去查「问开心为什么会给出书页那条」。
//
// 而且伤害会叠加：一轮预算 3 条 / 1400 字，误命中会**挤掉该命中的**。
//
// 2026-10-09 第 4 轮：14 个「某个字只是顺带出现」的问句里 12 个误命中。
// 把十个单字触发词换成长词之后降到 2/14（其中一条还是对的）。

try {
  const negatives = yaml.load(readFileSync(`${ROOT}/eval/false-positives.yaml`, 'utf8'));
  const book = buildWorldbook(yaml.load(readFileSync(`${ROOT}/worldbook/entries.yaml`, 'utf8')));
  for (const testCase of negatives) {
    try {
      const log = createInjectionLog();
      log.nextTurn('eval');
      const decision = explainEntries(book.entries, testCase.ask, { skip: new Set() });
      const ids = decision.chosen.map((entry) => entry.id);
      const wrong = (testCase.absent ?? []).filter((id) => ids.includes(id));
      record('L1', testCase.name, wrong.length === 0,
        wrong.length ? `「${testCase.ask}」误命中 ${wrong.join(', ')}（实际给了 ${ids.join(', ') || '空'}）` : `没误命中`);
    } catch (error) {
      record('L1', testCase.name ?? '(无名负例)', false, `用例本身出错：${error.message}`);
    }
  }

  // 结构：触发词不得只有一个字。一个汉字构不成一个词，而匹配是子串。
  const singles = [];
  for (const entry of [...(book.always ?? []), ...book.entries]) {
    for (const trigger of entry.triggers ?? []) {
      if (String(trigger).length === 1) singles.push(`${entry.id}:${trigger}`);
    }
  }
  record('L1', '没有单字触发词', singles.length === 0,
    singles.length ? `${singles.length} 个：${singles.join(', ')}` : `${book.entries.length} 条的触发词都在两个字以上`);
} catch (error) {
  record('L1', '读取 eval/false-positives.yaml', false, error.message);
}

// ── L1 条目可达性 ───────────────────────────────────────────────────────
//
// 每一条条目，**至少有一个自己的触发词能把它检索出来**。
//
// ## 为什么这条容易漏
//
// 一轮只注入 3 条。同一主题下一堆条目，**优先级低的那几条会被永远挤出去** ——
// 而它们不是「不常用」，是**根本到不了**。静默、无感知，而且随着条目增多越来越严重。
//
// 2026-10-09 第 9 轮实测：121 条里 **11 条**任何触发词都检索不出来，
// 其中 10 条是 `view-*` 那一族（「她对某人的看法」）—— 它们的触发词**只有名字**，
// 而同一个名字下事实层的优先级是 60~65，它们只有 45。
//
// 所以问「你觉得白厄怎么样」拿到的是事实层三条，**她对他的看法永远进不来**。
//
// ⚠️ 判据要写对：**不是**「泛泛问一个人时必须给出这一条」——
// 那要求把 7 条全塞进 3 个位置。判据是「**存在**一个触发词能把它带出来」。
// 第一版写成前者，报了 36 条，其中 25 条是预算在正常工作。
{
  const book = buildWorldbook(yaml.load(readFileSync(`${ROOT}/worldbook/entries.yaml`, 'utf8')));
  const unreachable = [];
  for (const entry of book.entries) {
    const triggers = entry.triggers ?? [];
    if (triggers.length === 0) { unreachable.push(`${entry.id}（没有触发词）`); continue; }
    const reachable = triggers.some((trigger) => {
      const log = createInjectionLog();
      log.nextTurn('eval');
      return explainEntries(book.entries, `跟人家说说${trigger}吧`, { skip: new Set() })
        .chosen.some((chosen) => chosen.id === entry.id);
    });
    if (!reachable) unreachable.push(entry.id);
  }
  record('L1', '每条条目都有触发词能把它检索出来', unreachable.length === 0,
    unreachable.length
      ? `${unreachable.length}/${book.entries.length} 条到不了：${unreachable.slice(0, 5).join(', ')}${unreachable.length > 5 ? ' …' : ''}`
      : `${book.entries.length} 条全部可达`);
}

// ── L1 世界书注入面 ─────────────────────────────────────────────────────
//
// 122 条条目，每条都是模型（子代理读游戏原文之后）写的，而且**每轮都进系统提示词**。
// 这是一个没人看的面 —— 条目加进去之后就再也没人读过，而它们每一轮都在起作用。
//
// 判定逻辑在 `worldbook-injection.mjs`，那边有独立的测试证明它真的会响
// （塞进恶意条目时四类全部命中）。这里只是把它接进回归。

{
  const book = buildWorldbook(yaml.load(readFileSync(`${ROOT}/worldbook/entries.yaml`, 'utf8')));
  const all = [...(book.always ?? []), ...book.entries];
  const { findings, checked } = scanEntries(all);
  record('L1', '世界书条目里没有注入面', findings.length === 0,
    findings.length ? describeFindings(findings) : `${checked} 条：无结构逃逸、无指令式写法`);
}
}
