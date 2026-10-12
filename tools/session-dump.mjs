/**
 * 把会话日志里的「人看的部分」抽出来：用户说了什么、助手回了什么、调了哪些工具。
 * 跳过 reasoning 和文件正文。
 *
 * 用法：node tools/session-dump.mjs <file.jsonl|.zstd> [fromSeq] [toSeq]
 * 见 tools/README.md「会话日志三件套」。序号从 session-brief 或 session-tail 里读。
 */
import { forEachLine, clip, seqOf } from './session-log.mjs';

const file = process.argv[2];
const from = Number(process.argv[3] ?? 0);
const to = Number(process.argv[4] ?? Number.MAX_SAFE_INTEGER);

if (!file) {
  console.error('用法：node tools/session-dump.mjs <file.jsonl|.zstd> [fromSeq] [toSeq]');
  process.exit(2);
}

await forEachLine(file, async (o) => {
  const seq = seqOf(o);
  if (typeof seq === 'number' && (seq < from || seq > to)) return;
  const d = o.data ?? {};

  if (o.type === 'user/message') {
    const text = (d.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    console.log(`\n######## seq=${seq} USER ########`);
    console.log(clip(text, 2000));
  } else if (o.type === 'assistant/message') {
    const content = d.message?.content ?? [];
    const texts = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const tools = content.filter((c) => c.type === 'tool_use' || c.type === 'tool_call');
    if (texts.trim()) {
      console.log(`\n---- seq=${seq} ASSISTANT turn ${d.turn} ----`);
      console.log(clip(texts, 2500));
    }
    for (const t of tools) {
      const inp = t.input ?? t.arguments ?? {};
      const brief = inp.command ?? inp.file_path ?? inp.path ?? inp.pattern ?? JSON.stringify(inp);
      console.log(`      [tool] ${t.name}: ${clip(brief, 300)}`);
    }
  } else if (o.type === 'command/run') {
    console.log(`\n>>>>> seq=${seq} COMMAND /${d.name} ${clip(d.args, 200)}`);
  }
});
