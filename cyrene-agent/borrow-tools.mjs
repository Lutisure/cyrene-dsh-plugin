/**
 * One-shot: put the two rules into the tools that enforce them.
 *
 * Neither rule can be checked mechanically from inside the tool — the tool cannot
 * see the conversation, so it cannot verify a value was a substring of it. What it
 * can do is state the rule where the model reads it, which is how 灵枢's E011 gate
 * is described in its own contract (`ccgc.py`: a value must be a literal substring
 * of the dialogue). The difference between an instruction and a gate is real, and
 * worth naming rather than pretending otherwise.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const file = 'memory.mjs';
let s = readFileSync(file, 'utf8');
let applied = 0;

const edit = (from, to, label) => {
  if (!s.includes(from)) {
    console.error(`  MISS ${label}`);
    return;
  }
  s = s.replace(from, to);
  applied += 1;
  console.log(`  ok   ${label}`);
};

edit(
  `          description:
            '把一条关于对方的长期信息写进你自己的长期记忆，跨会话保留。' +
            '只在对方明确说「记住」，或主动告诉你一件明显的长期事实时使用。' +
            '不要记录一次性的、临时的、当轮就过期的内容。一次只记一件事，用一句话写。',
          parameter: 'text',
          parameterDescription: '要记住的那件事，一句话',`,
  `          description:
            '把一条关于对方的长期信息写进你自己的长期记忆，跨会话保留。' +
            '只在对方明确说「记住」，或主动告诉你一件明显的长期事实时使用。' +
            '不要记录一次性的、临时的、当轮就过期的内容。一次只记一件事，用一句话写。' +
            '\\n\\n用对方自己的说法记，不要替他把话理顺或润色。' +
            '记忆被改写过的样子和原文一样通顺，所以这种失真不会有任何迹象——' +
            '但从此以后你记住的就不再是他说的那句话了。' +
            '\\n\\n如果这条只在某些情况下成立，在末尾用全角竖线补一个「不适用」字段，' +
            '逗号分隔多个条件：\\n' +
            '  他怕冷｜不适用=聊夏天、聊空调温度\\n' +
            '不要什么都加。只在这条确实有清楚边界、而且那个边界以后真会用上时才写——' +
            '边界是要占提示词位置的。',
          parameter: 'text',
          parameterDescription:
            '要记住的那件事，一句话。必要时在末尾接「｜不适用=条件、条件」',`,
  'remember description'
);

edit(
  `            if (outcome.status === 'empty') return '内容为空，没有写入。';
            if (outcome.status === 'duplicate') return \`「\${outcome.entry}」已经在记忆里了，没有重复添加。\`;
            const written = writeStore(outcome.store);
            if (!written.ok) return \`记忆写入失败：\${written.error}\`;
            return \`记住了：「\${outcome.entry}」\`;`,
  `            if (outcome.status === 'empty') return '内容为空，没有写入。';
            if (outcome.status === 'duplicate') return \`「\${outcome.entry}」已经在记忆里了，没有重复添加。\`;
            if (outcome.status === 'full') {
              // Refused, not evicted, and said out loud. A memory that quietly
              // drops the oldest entry keeps accepting writes while forgetting,
              // which is the one thing it must never do.
              return \`记忆已经满了（\${MAX_ENTRIES} 条），这条没有写进去，也没有丢掉任何旧的。请先用 forget 删掉确实不再需要的，再记这条。\`;
            }
            const written = writeStore(outcome.store);
            if (!written.ok) return \`记忆写入失败：\${written.error}\`;

            // Report the pressure when it starts to matter. MAX_ENTRIES and
            // MAX_INJECT disagree — 120 entries is allowed to be stored, but only
            // the newest few dozen reach the prompt — so a write that succeeds can
            // still be a write that will never be read.
            const load = memoryPressure(outcome.store);
            if (load.fits < load.entries) {
              return \`记住了：「\${outcome.entry}」。不过已经有 \${load.entries} 条，提示词只放得下最新的 \${load.fits} 条，\${load.entries - load.fits} 条较早的暂时看不到（还存着）。\`;
            }
            return \`记住了：「\${outcome.entry}」\`;`,
  'remember run'
);

writeFileSync(file, s);
console.log(`  ${applied} edit(s) applied`);
