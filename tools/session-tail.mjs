/**
 * 读一份会话日志的尾部，把每条记录压成一行。
 *
 * 用法：node tools/session-tail.mjs <file.jsonl|.zstd> [count]
 * 见 tools/README.md「会话日志三件套」。拿到没见过的日志时先跑它看字段形状。
 */
import { lastRecords, clip } from './session-log.mjs';

const file = process.argv[2];
const need = Number(process.argv[3] ?? 20);

if (!file) {
  console.error('用法：node tools/session-tail.mjs <file.jsonl|.zstd> [count]');
  process.exit(2);
}

const picked = (await lastRecords(file, need)).filter(Boolean);

for (const o of picked) {
  const type = o.type ?? o.kind ?? '?';
  const stamp = o.timestamp ?? o.time ?? o.data?.time ?? '';
  let detail = '';
  if (type === 'message' || o.message) {
    const m = o.message ?? o.data?.message ?? o;
    const content = m.content;
    if (typeof content === 'string') detail = `role=${m.role ?? '?'} ${clip(content)}`;
    else if (Array.isArray(content)) {
      detail = `role=${m.role ?? '?'} ` + content.map((c) => {
        if (c.type === 'text') return `text:${clip(c.text, 800)}`;
        if (c.type === 'tool_use' || c.type === 'tool-call') return `tool:${c.name} ${clip(c.input ?? c.arguments, 600)}`;
        if (c.type === 'tool_result') return `result:${clip(typeof c.content === 'string' ? c.content : JSON.stringify(c.content), 600)}`;
        return c.type;
      }).join(' | ');
    }
  } else {
    detail = clip(JSON.stringify(o.data ?? o), 800);
  }
  console.log(`[${stamp}] ${type} :: ${detail}`);
  console.log('---');
}
