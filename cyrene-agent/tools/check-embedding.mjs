/**
 * 部署自检（doctor）：装完 embedding 之后跑这一条，看它是不是真的通了
 *
 * ## 查什么
 *
 *   一、模型文件：六个文件是否都在、sha256 是否与清单一致
 *   二、向量表：`dist/story-windows.{f32,json}` 是否存在、条数与 chunks 的 sha256 是否对得上
 *   三、编码器：能不能真的加载模型、编出一句话（维度对不对、有没有 [UNK]）
 *   四、端到端：走**真实 hook** 跑三句 —— 剧情题应当注入、别名题应当注入、日常句**不该**注入
 *
 * ## 用法
 *
 *   node tools/check-embedding.mjs                    # 模型与包目录都按默认（本包）
 *   node tools/check-embedding.mjs --package D:/x/cyrene-agent
 *   node tools/check-embedding.mjs --model D:/x/bge-small-zh-v1.5
 *
 * 退出码：0 = 全通；1 = 有 FAIL（会逐条列出）
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import { MANIFEST, defaultModelDir, matches } from './embedding-manifest.mjs';

const arg = (name, fallback = null) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? true);
};

// 默认就是**这个脚本所在包的根** —— 从别处用 `--package` 指过来也行。
const PKG = String(arg('package', fileURLToPath(new URL('..', import.meta.url)))).replace(/\\/g, '/');
const MODEL = String(arg('model', defaultModelDir()));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : `　${detail}`}`);
};

console.log(`\n══ embedding 部署自检 ═════════════════════════════════════════`);
console.log(`  包目录    ${PKG}`);
console.log(`  模型目录  ${MODEL}`);
console.log(`  DSH_HOME  ${process.env.DSH_HOME ?? '（未设，将用 %USERPROFILE%\\.dsh）'}`);
console.log(`  开关      DSH_STORY_EMBED=${process.env.DSH_STORY_EMBED ?? '（未设 = auto）'}`);

// ── 一、模型文件 ──────────────────────────────────────────────────────
console.log('\n  【一】模型文件');
for (const entry of MANIFEST) {
  const r = matches(join(MODEL, entry.path), entry);
  check(entry.path, r.ok, r.ok ? `${entry.bytes} bytes` : r.why);
}

// ── 二、向量表 ────────────────────────────────────────────────────────
console.log('\n  【二】向量表');
const chunksFile = join(PKG, 'dist', 'story-chunks.jsonl');
const metaFile = join(PKG, 'dist', 'story-windows.json');
const binFile = join(PKG, 'dist', 'story-windows.f32');
check('dist/story-chunks.jsonl 存在', existsSync(chunksFile));
check('dist/story-windows.json 存在', existsSync(metaFile));
check('dist/story-windows.f32 存在', existsSync(binFile));

let windowsMeta = null;
if (existsSync(chunksFile) && existsSync(metaFile) && existsSync(binFile)) {
  const raw = readFileSync(chunksFile, 'utf8');
  const docs = raw.split('\n').filter(Boolean);
  windowsMeta = JSON.parse(readFileSync(metaFile, 'utf8'));
  const hash = createHash('sha256').update(raw).digest('hex');
  check('向量表条数与块数一致', windowsMeta.chunks === docs.length, `chunks=${windowsMeta.chunks}　块=${docs.length}`);
  check('向量表源哈希与当前 chunks 一致', windowsMeta.sourceSha256 === hash, windowsMeta.sourceSha256 === hash ? '哈希相同' : '⚠️ 语料重建过，需要重新生成向量表');
  const bytes = statSync(binFile).size;
  check('向量表字节数与元信息一致', bytes === windowsMeta.count * windowsMeta.dim * 4, `${(bytes / 1024 / 1024).toFixed(2)} MB　${windowsMeta.count} 窗 × ${windowsMeta.dim} 维`);
  check('元信息里带 chunkOf 映射', Array.isArray(windowsMeta.chunkOf) && windowsMeta.chunkOf.length === windowsMeta.count);
}

// ── 三、编码器 ────────────────────────────────────────────────────────
console.log('\n  【三】编码器');
const embedderUrl = pathToFileURL(join(PKG, 'embedder.mjs')).href;
const storyUrl = pathToFileURL(join(PKG, 'story.mjs')).href;
let model = null;
try {
  const { createEmbedder, loadVocab, tokenize, encodeIds } = await import(embedderUrl);
  const tk = loadVocab(MODEL);
  check('tokenizer.json 能读出词表', tk !== null, tk === null ? '' : `词表 ${Object.keys(tk.vocab).length} 项`);
  if (tk !== null) {
    const sample = '那刻夏的眼睛是怎么没的';
    const pieces = tokenize(sample, tk);
    const unknown = encodeIds(sample, tk).filter((id) => id === tk.unk).length;
    check('中文分词无 [UNK]', unknown === 0, `${pieces.length} 个 token，[UNK] ${unknown}`);
  }
  const t0 = Date.now();
  model = await createEmbedder(MODEL);
  check('模型加载成功', model !== null, model === null ? '见上方 stderr' : `${Date.now() - t0} ms，维度 ${model?.dim}`);
  if (model !== null) {
    const vec = await model.embed(['测试']);
    check('能编出一句话', Array.isArray(vec) && vec[0]?.length === model.dim, `维度 ${vec[0]?.length}`);
  }
} catch (error) {
  check('编码器加载', false, String(error?.message ?? error));
}

// ── 四、端到端（走真实 hook）─────────────────────────────────────────
console.log('\n  【四】端到端（真实 hook）');
const audit = join(mkdtempSync(join(tmpdir(), 'cyrene-doctor-')), 'story.jsonl');
process.env.DSH_STORY_AUDIT = audit;
try {
  const mod = await import(storyUrl);
  const state = mod.debugState();
  check('story.mjs 能读到索引', state !== null, state === null ? '' : `${state.docs.length} 块`);
  check('story.mjs 认出了向量表', state?.windows != null, state?.windows ? `${state.windows.count} 窗 × ${state.windows.dim} 维` : '没认出来 —— 会退回纯词法');

  let hook = null;
  mod.apply({ on: (_e, fn) => { hook = fn; } });
  check('hook 挂上了', typeof hook === 'function');

  if (typeof hook === 'function' && state !== null) {
    const probes = [
      { q: '那刻夏的眼睛是怎么没的', want: true, why: '剧情题（提到专名）' },
      { q: '凯撒做过什么', want: true, why: '别名题（2 字别名）' },
      { q: '今天好累啊', want: false, why: '日常句（不该注入）' },
      { q: '有点想你了', want: false, why: '日常句（含触发词）' }
    ];
    for (const p of probes) {
      const msgs = [{ role: 'user', content: [{ type: 'text', text: p.q }] }];
      const decision = await hook(
        { agent: { id: 'doctor', session: { id: `doctor-${p.q}` } }, messages: msgs },
        async () => ({ kind: 'enter', messages: [...msgs] })
      );
      const added = (decision?.messages ?? []).length - msgs.length;
      const got = added > 0;
      const tail = got ? String(decision.messages[decision.messages.length - 1].content?.[0]?.text ?? '').split('\n').slice(0, 3).join(' / ') : '（未注入）';
      check(`${p.why}：${p.q}`, got === p.want, `${got ? '已注入' : '未注入'}　${tail.slice(0, 96)}`);
    }
  }
} catch (error) {
  check('端到端', false, String(error?.message ?? error));
}

// ── 汇总 ──────────────────────────────────────────────────────────────
const bad = results.filter((r) => !r.ok);
console.log(`\n  ── ${results.length - bad.length}/${results.length} 项通过 ──`);
if (bad.length > 0) {
  console.log('  ✗ 有 FAIL：');
  for (const r of bad) console.log(`      · ${r.name}　${r.detail}`);
  console.log('');
  process.exit(1);
}
console.log('  ✓ 全部通过 —— embedding 这条路是通的\n');
