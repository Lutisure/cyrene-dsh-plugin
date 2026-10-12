/**
 * 评测台。
 *
 * 三层，按「确定性 → 需要模型」排列，和 CI 的分层思路一样：
 *
 *   L1 检索   断言注入了什么。**不需要模型、不花钱、一秒跑完。**
 *             RAGAS 的 context precision / recall 对应的是这一层，
 *             而我们那个死锁也正死在这一层 —— 输出看着正常，检索是空的。
 *
 *   L2 文风   断言输出的字面特征。用真实 transcript 跑，不用假想的样本。
 *             每一条都来自一次**真实被指出的问题**，不是凭空写的规则。
 *
 *   L3 语义   像不像、判得准不准。**这一层要模型，而且不能用来定论：**
 *             CharacterEval (ACL 2024) 实测过，GPT-4 当评判者与人类判断的
 *             Pearson 相关只有 0.362~0.385，而用人类标注训练的奖励模型是 0.631。
 *             所以 L3 只用来筛，定论靠人。
 *
 * 用法：
 *   node tools/eval.mjs                          # 只跑 L1
 *   node tools/eval.mjs --transcript <file>      # L1 + L2（文件里是她的输出）
 *   node tools/eval.mjs --json                   # 机器可读
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import zlib from 'node:zlib';

// ---- 仓库根，从本文件的位置推（由 tools/derive-roots.mjs 加的头）----
//
// 以前这里写的是作者机器上的绝对路径。那只在那台机器上成立，
// 而且清洗脚本会把绝对路径换成占位符，于是代码里出现 <本仓库> 这种目录名，直接崩。
import { fileURLToPath as __f } from 'node:url';
import { dirname as __d, join as __j } from 'node:path';
const REPO_ROOT = __j(__d(__f(import.meta.url)), '../..');

import { scanEntries, describeFindings } from '../worldbook-injection.mjs';
// ⚠️ `presets-check.mjs` 不在这里静态 import —— 它属于模式那一套，刻意不随包分发。
//    改成下面预设检查那段的按需动态 import。静态的话模块不在，整个评测台起不来。

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

/**
 * profile 补丁里有 `!!js` 动态值表达式：
 *
 *     disabled: !!js process.platform === 'win32'
 *
 * js-yaml 默认不认识这个标签会抛。用一个自定义 Type 把它当字符串吃掉就行 ——
 * 这里只是**读**补丁做断言，不求值。
 */
const PATCH_SCHEMA = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => data === null || typeof data === 'string',
    construct: (data) => (data === null ? '' : String(data)),
    predicate: () => false
  })
]);

/**
 * 会话日志是**多帧 zstd**（一个 zstd 帧接一个），不能整体解压 ——
 * 扫 `28 B5 2F FD` 魔数逐帧解，再拼起来。
 *
 * 为什么要内置这一步：第一版让人先手动导出成一份 jsonl 再喂进来，
 * 结果那份快照几小时后就过期了 —— 里面最后一个 `/cyrene` 是**更早那一次**，
 * 于是截出来零个样本，而所有检查对着零个样本打勾。
 * **评测台要自己去读当下的事实，不能依赖一份会过期的中间产物。**
 */
function readSession(file) {
  const buf = readFileSync(file);
  const offsets = [];
  for (let i = 0; i + 3 < buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i);
  }
  if (offsets.length === 0) return buf.toString('utf8');
  const parts = [];
  for (let k = 0; k < offsets.length; k += 1) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(offsets[k], end)).toString('utf8')); } catch { /* 跳过坏帧 */ }
  }
  return parts.join('');
}

/** 找本机最新的一个会话文件。 */
function newestSession() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  let best = null;
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let items; try { items = readdirSync(dir); } catch { return; }
    for (const item of items) {
      const full = `${dir}/${item}`;
      let info; try { info = statSync(full); } catch { continue; }
      if (info.isDirectory()) { walk(full, depth + 1); continue; }
      if (!item.startsWith('session.v4.jsonl')) continue;
      if (best === null || info.mtimeMs > best.mtimeMs) best = { full, mtimeMs: info.mtimeMs };
    }
  };
  walk(`${home}/.dsh/sessions`, 0);
  return best?.full ?? null;
}

const ROOT = `${REPO_ROOT}/cyrene-agent`;
const {
  buildWorldbook, explainEntries, createInjectionLog, DEFAULT_LIMIT, DEFAULT_BUDGET
} = await import(`file://${REPO_ROOT}/cyrene-agent/worldbook-logic.mjs`);

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

// ── L0 材料 ─────────────────────────────────────────────────────────────
//
// 扫**源文件本身**，不扫她的输出。
//
// 为什么需要这一层：文风规则一直只管她，不管写她材料的那个。而后者写的东西
// 会渗进世界书、soul、语料、文档 —— 2026-10-09 就渗进了 docs/README.md（12 处），
// 而工具当时明明报过这个模式，被一句「工程模式本来就该用」解释掉了。
//
// 跟「原话是」那一条是同一件事：**世界书怎么写她就怎么说**，
// 反过来也成立 —— **写材料的人怎么写，她也怎么说**。

if (argv.includes('--sources')) {
  // 行尾：一个文件里不许混着两种。
  //
  // 2026-10-09 第 4-5 轮：一个「改九个条目触发词」的小脚本**悄悄把九行从 CRLF
  // 改成了 LF**，而且没有任何东西发现 —— 直到下一轮去数行尾才看出来
  // （CRLF 从 880 降到 871，正好等于改过的条目数）。
  //
  // 这里不规定该用哪种行尾，只要求别混。理由：这个仓库是备份，工作区就是正在
  // 运行的那份插件（.gitattributes 里是 `* -text`），工具没有立场去改整体风格，
  // 它只该不要在编辑的时候顺手改掉。
  {
    const packages = ['cyrene-agent', 'cyrene-guard', 'dsh-theme-cyrene'];
    const repoRoot = `${ROOT}/..`;
    const textExtensions = new Set(['.mjs', '.js', '.json', '.yaml', '.yml', '.md', '.txt', '.css', '.ts', '.html']);
    const skipDirs = new Set(['node_modules', '.git', 'dist', 'GIF', 'assets', 'music', 'brand', '.data', 'deploy']);
    const mixed = [];
    let scanned = 0;
    const walk = (dir) => {
      let items;
      try { items = readdirSync(dir); } catch { return; }
      for (const item of items) {
        if (skipDirs.has(item)) continue;
        const full = `${dir}/${item}`;
        let info;
        try { info = statSync(full); } catch { continue; }
        if (info.isDirectory()) { walk(full); continue; }
        if (!textExtensions.has(item.slice(item.lastIndexOf('.'))) || info.size > 4e6) continue;
        const body = readFileSync(full, 'utf8');
        const crlf = (body.match(/\r\n/g) ?? []).length;
        const lf = (body.match(/(?<!\r)\n/g) ?? []).length;
        if (crlf === 0 && lf === 0) continue;
        scanned += 1;
        if (crlf > 0 && lf > 0) mixed.push(`${full.slice(repoRoot.length + 1)}（CRLF ${crlf} / LF ${lf}）`);
      }
    };
    for (const pkg of packages) walk(`${repoRoot}/${pkg}`);
    record('L0', '文本文件里没有混合行尾', mixed.length === 0,
      mixed.length ? `${mixed.length} 个：${mixed.slice(0, 3).join('；')}` : `${scanned} 个文件，行尾各自一致`);
  }

  const SOURCE_FILES = [
    'persona-soul.md',
    'worldbook/entries.yaml',
    'corpus/line-samples.yaml',
    'docs/README.md',
    'docs/STORY-EXTRACTION.md'
  ];
  const style = yaml.load(readFileSync(`${ROOT}/eval/style.yaml`, 'utf8'));
  const found = [];
  for (const relative of SOURCE_FILES) {
    const full = `${ROOT}/${relative}`;
    if (!existsSync(full)) continue;
    const body = readFileSync(full, 'utf8');
    for (const rule of style) {
      // 只有标了 sources: true 的规则也约束写材料的人。
      // 输出规则不全都适用：条文要引用被禁的模式，世界书要逐字引游戏原文。
      if (rule.sources !== true) continue;
      for (const pattern of (rule.forbid ?? [])) {
        const hit = new RegExp(pattern, 'gm').exec(body);
        if (hit) found.push(`${relative}  「${hit[0].slice(0, 20)}」  来自规则：${rule.name}`);
      }
    }
  }
  record('L0', '源文件里没有她自己不该用的写法', found.length === 0,
    found.length === 0 ? `${SOURCE_FILES.length} 个文件干净` : `${found.length} 处：${found.slice(0, 3).join('；')}${found.length > 3 ? ' …' : ''}`);
}

// ── L2 文风 ─────────────────────────────────────────────────────────────
//
// ⚠️ **量的是哪一份会话、量到了几条，必须出现在结果里。**
//
// 2026-10-09 第 8 轮踩到的两件事：
//
//   ① `--session` 是**按 mtime 挑最新那个**。今晚工作区一换，同一个命令
//      一小时前量的是工程会话、现在量的是 Chat 工作区里那个 ——
//      **而输出里一个字都没提**。同一个命令量不同的东西，结果就没法比。
//
//   ② 那次跑出 **8/8 通过**，而样本只有 **2 条**。
//      8/8 这个数字本身看不出它是在 2 条上得到的还是在 200 条上。
//      今晚已经栽过一次更严重的同类：「9 项里 8 项打勾，因为它对着零个样本检查」。
//      加了「样本非空」的守卫，但那只挡住了**零**，没挡住**少**。
//
// 所以现在：开始时报「量的是哪一份、几条」，样本少于一屏的量级时**明说样本薄**。

if (TRANSCRIPT) {
  if (!existsSync(TRANSCRIPT)) {
    record('L2', '读取 transcript', false, `找不到 ${TRANSCRIPT}`);
  } else {
    record('L2', '量的是哪一份', true, `${TRANSCRIPT.replace(/.*sessions[\\/]/, '')}（${Math.round(statSync(TRANSCRIPT).size / 1024)} KB）`);
    // 读出来的每一段都当成一次输出。支持两种输入：
    //   · 纯文本（空行分段）
    //   · 会话 jsonl（取 assistant 的正文，跳过思考）
    // 每段带上**行号**，因为 jsonl 里的换行是转义的 `\n` 两个字符 ——
    // 按文本去原始串里搜是搜不到的（第一版就这么错了），只能靠行号定位。
    const raw = readSession(TRANSCRIPT);
    const lines = raw.split('\n');
    let samples = [];
    if (/^\s*\{/.test(raw)) {
      for (const [index, line] of lines.entries()) {
        if (!line.trim()) continue;
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (row?.type !== 'assistant/message') continue;
        const text = (row?.data?.message?.content ?? [])
          .filter((part) => part?.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text).join('\n').trim();
        if (text) samples.push({ text, line: index });
      }
    } else {
      let from = 0;
      for (const block of raw.split(/\n{2,}/)) {
        const text = block.trim();
        if (text) {
          samples.push({ text, line: raw.indexOf(block, from) === -1 ? 0 : raw.slice(0, raw.indexOf(block, from)).split('\n').length - 1 });
          from += block.length;
        }
      }
    }

    // 只看角色模式那一段：找**最后一次**「文本正好等于标记」的用户消息，切掉前面的。
    //
    // ⚠️ 不能用 `line.includes(标记)`。第一版就是那么写的，结果匹配到了**技能正文里**的
    //    `/cyrene` —— 那份 86 KB 的 SKILL.md 自己就含很多个，而它是在最末尾注入的，
    //    于是「标记之后」什么都没有，截出零个样本。
    //    标记要认**用户真的只发了这几个字**那一行。
    if (AFTER) {
      let markerLine = -1;
      for (const [index, line] of lines.entries()) {
        if (!line.trim()) continue;
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (row?.type !== 'user/message') continue;
        const text = (row?.data?.content ?? [])
          .filter((part) => part?.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text).join('\n').trim();
        if (text === AFTER) markerLine = index;
      }
      if (markerLine === -1) {
        record('L2', `按「${AFTER}」截取`, false, `找不到文本正好是「${AFTER}」的用户消息`);
        samples = [];
      } else {
        const kept = samples.filter((sample) => sample.line > markerLine);
        record('L2', `按「${AFTER}」截取`, kept.length > 0,
          `${samples.length} 段 → ${kept.length} 段（那条消息在第 ${markerLine + 1} 行）`);
        samples = kept;
      }
    }

    // ⚠️ 样本为空时下面的检查会**全部通过** —— 那只说明什么都没量到。
    //    第一版就出过这个：截取失败了，9 项检测里 8 项打勾。
    //    一个因为没量而通过的评测台比没有更糟，所以这里直接判失败。
    if (samples.length === 0) {
      record('L2', '样本非空', false, '一个样本都没有，下面的检查没有意义（不要把空当成通过）');
    } else {
      // 样本数写进结果里。8/8 这个数字**本身看不出它是在 2 条上得到的
      // 还是在 200 条上** —— 而这两件事的可信度差得很远。
      const chars = samples.reduce((sum, sample) => sum + (typeof sample === 'string' ? sample.length : sample.text.length), 0);
      const thin = samples.length < 10 || chars < 500;
      record('L2', '样本量', !thin,
        `${samples.length} 段 / ${chars} 字` + (thin ? '　⚠️ 样本太薄，下面那些「通过」说明不了什么 —— 只说明这几次里没出现那些毛病' : ''));
    }

    const style = yaml.load(readFileSync(`${ROOT}/eval/style.yaml`, 'utf8'));

    // ── 聚合指标（供 rule.bands 用）────────────────────────────────────
    //
    // 和 tools/style-stats.mjs 同一套定义。**算的是整份样本的聚合值。**
    //
    // 为什么不逐条算：基线那 2054 句本身就是聚合数字，拿单条回复去比是把两种
    // 不同尺度的东西放在一起；而且短回复里的比例噪声极大 —— 一句里有一个「呀」
    // 就是 100%。CharacterBench 那条也说了：人设特征在自然回复里稀疏，
    // 单条里数不出比例。
    const allLines = samples
      .flatMap((sample) => String(typeof sample === 'string' ? sample : sample.text).split('\n'))
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const pct = (re) => allLines.length === 0
      ? 0
      : (allLines.filter((line) => re.test(line)).length / allLines.length) * 100;
    const AGGREGATE = {
      particle: pct(/[呀啦呢吧哦嘛]/),
      pYa: pct(/呀/), pLa: pct(/啦/), pNe: pct(/呢/), pBa: pct(/吧/),
      pO: pct(/哦/), pMa: pct(/嘛/), pA: pct(/啊/),
      we: pct(/我们/), together: pct(/一起/), addressee: pct(/开拓者/),
      imagery: pct(/花|种子|星|光|风|涟漪|海|明天|旅途|纸页|故事/),
      ratio: (() => {
        const them = allLines.reduce((n, line) => n + (line.match(/人家/g) ?? []).length, 0);
        const me = allLines.reduce((n, line) => n + (line.match(/我/g) ?? []).length, 0);
        return them + me === 0 ? 0 : them / (them + me);
      })()
    };

    for (const rule of style) {
      const hits = [];
      for (const [index, sample] of samples.entries()) {
        // 样本现在是 { text, line }，兼容纯字符串。
        const body = typeof sample === 'string' ? sample : sample.text;
        if (rule.forbid) {
          for (const pattern of rule.forbid) {
            const found = new RegExp(pattern, 'gm').exec(body);
            if (found) hits.push(`#${index + 1} 命中「${found[0].slice(0, 24)}」`);
          }
        }
        if (rule.ratio) {
          const them = (body.match(/人家/g) ?? []).length;
          const me = (body.match(/我/g) ?? []).length;
          if (them + me >= 5) {
            const share = them / (them + me);
            if (share < rule.ratio.min) hits.push(`#${index + 1} 人家占比 ${(share * 100).toFixed(0)}% 低于 ${rule.ratio.min * 100}%`);
          }
        }
      }
      // bands 用的是**聚合值**，所以这一支在样本循环之外。
      if (rule.bands) {
        for (const [key, [low, high]] of Object.entries(rule.bands)) {
          const value = AGGREGATE[key];
          if (value === undefined) { hits.push(`指标 ${key} 在 eval.mjs 里没有定义`); continue; }
          // ratio 是 0~1，其余是百分数。这条文件里两种都有，比例也跟着写成 0~1。
          const scaled = key === 'ratio' ? value * 100 : value;
          const lo = key === 'ratio' ? low * 100 : low;
          const hi = key === 'ratio' ? high * 100 : high;
          if (scaled < lo || scaled > hi) {
            hits.push(`${key} = ${scaled.toFixed(1)}%，落在 [${lo}, ${hi}] 之外`);
          }
        }
      }
      record('L2', rule.name, hits.length === 0, hits.length ? `${hits.length} 处：${hits.slice(0, 4).join('；')}${hits.length > 4 ? ' …' : ''}` : `${samples.length} 段全过`);
    }
  }
}

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
