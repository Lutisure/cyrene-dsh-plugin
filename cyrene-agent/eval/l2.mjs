/**
 * L2 · 文风。
 *
 * 断言输出的字面特征，用真实 transcript 跑，不用假想的样本。
 * 没有 transcript 就不跑 —— 它量不了虚构出来的话。
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
 * @param {{record: Function, book: object, byId: Map<string, object>, TRANSCRIPT: string|null, AFTER: string|null}} ctx
 */
export function runL2(ctx) {
  const { record, book, byId, TRANSCRIPT, AFTER } = ctx;

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
}
