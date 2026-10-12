/**
 * 把每轮「用户说了什么 / 助手回了什么」压成一行，便于快速通读。
 *
 * 用法：node tools/session-brief.mjs <file.jsonl|.zstd> [perTextChars]
 * 见 tools/README.md「会话日志三件套」。
 *
 * U<seq> 是用户的，A<seq> 是助手的，tools( 是这一步调了哪些工具。
 * 只挑用户那侧看：Select-String -Path brief.txt -Pattern '^U\s+[^<]'
 */
import { forEachLine, clip, seqOf } from './session-log.mjs';

const file = process.argv[2];
const cap = Number(process.argv[3] ?? 700);

if (!file) {
  console.error('用法：node tools/session-brief.mjs <file.jsonl|.zstd> [perTextChars]');
  process.exit(2);
}

const cut = (s) => clip(s, cap);

await forEachLine(file, async (o) => {
  const seq = seqOf(o);
  const d = o.data ?? {};
  if (o.type === 'user/message') {
    const text = (d.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' ');
    console.log(`U${seq ?? ''}\t${cut(text)}`);
  } else if (o.type === 'assistant/message') {
    const content = d.message?.content ?? [];
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join(' ');
    const tools = content.filter((c) => c.type === 'tool_use' || c.type === 'tool_call');
    if (text.trim()) console.log(`A${seq ?? ''}\t${cut(text)}`);
    if (tools.length) console.log(`  tools(${tools.length})\t${tools.map((t) => t.name).join(',')}`);
  }
});
