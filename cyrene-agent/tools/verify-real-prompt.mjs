/**
 * Assemble her prompt with the **real** DSH implementation.
 *
 * Every other test in this repo checks either pure functions or a replica of the
 * runtime's semantics. This one runs the genuine article: it extracts the needed
 * `@deepseek-ai` packages out of the installed `app.asar`, mounts the actual
 * `SystemPrompt` service, loads the three real plugins by their real package
 * names, and renders the prompt the model would receive.
 *
 * It has already earned its keep twice, finding two bugs that no replica test
 * could have caught and that would both have shipped silently:
 *
 *   1. `{{cyrene_memory}}` inside the persona body reached the model as a literal
 *      string. Interpolation scans a section's text once and never re-scans a
 *      value it substituted in, so a placeholder nested behind `{{cyrene_persona}}`
 *      was never expanded.
 *   2. Both the worldbook always-on block and the memory block were being
 *      registered through `context()`, which the preset's
 *      `includeRuntimeContext: false` **empties wholesale** — and every other
 *      section is replaced by `complete: true`. Both would have mounted cleanly
 *      and reached nobody.
 *
 * Usage:
 *   node tools/verify-real-prompt.mjs
 *   DSH_ASAR="D:\\path\\to\\app.asar" node tools/verify-real-prompt.mjs
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Where the asar lives. Overridable, because the install path is machine-specific. */
const ASAR = process.env.DSH_ASAR ?? '<DSH 安装目录>\\resources\\app.asar';

/**
 * The packages the prompt registry needs.
 *
 * Seeded explicitly rather than discovered. `dsh-system-prompt` imports
 * `@deepseek-ai/cordis` without declaring it, so a manifest walk stops short;
 * and `cordis` in turn fails on a bare import in a way that reports a *file
 * path* rather than a package name, so the error-driven loop below cannot name
 * it either. This list was established by hand. The loop still runs, so a
 * genuinely new dependency surfaces with a clear message instead of a
 * module-not-found from deep inside the runtime.
 */
const SEED = [
  'dsh-system-prompt',
  'dsh-persona',
  'dsh-tools',
  'cordis',
  'cosmokit',
  'dsh-scope',
  'schemastery'
];

/** The packages whose imports are chased until they resolve. */
const ROOTS = ['dsh-system-prompt', 'dsh-tools'];

// ---------------------------------------------------------------- vendoring

/** Read one file out of an asar without extracting the whole thing. */
function readAsarFile(header, dataStart, fd, inner) {
  let node = header;
  for (const part of inner.split('/').filter(Boolean)) {
    node = node?.files?.[part];
    if (node === undefined) return null;
  }
  if (node.files !== undefined) return null;
  const buffer = Buffer.alloc(node.size);
  readSync(fd, buffer, 0, node.size, dataStart + Number(node.offset));
  return buffer;
}

const { openSync, readSync, closeSync } = await import('node:fs');

/**
 * Copy one package out of the asar.
 * @param {object} header - the asar index.
 * @param {number} dataStart - where file data begins.
 * @param {number} fd - the open asar.
 * @param {string} name - the package name without its scope.
 * @param {string} vendorRoot - the `node_modules` to populate.
 * @returns {number} how many files were written.
 */
function copyPackage(header, dataStart, fd, name, vendorRoot) {
  const root = `dsh/node_modules/@deepseek-ai/${name}`;
  let node = header;
  for (const part of root.split('/').filter(Boolean)) node = node?.files?.[part];
  if (node === undefined) throw new Error(`missing package in the asar: ${root}`);

  let copied = 0;
  const walk = (prefix, entry) => {
    for (const [child, childNode] of Object.entries(entry.files ?? {})) {
      const rel = prefix === '' ? child : `${prefix}/${child}`;
      if (childNode.files) { walk(rel, childNode); continue; }
      const buffer = Buffer.alloc(childNode.size);
      readSync(fd, buffer, 0, childNode.size, dataStart + Number(childNode.offset));
      const target = join(vendorRoot, '@deepseek-ai', name, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buffer);
      copied += 1;
    }
  };
  walk('', node);
  return copied;
}

/**
 * Copy every package the prompt registry needs out of the asar.
 *
 * The dependency list is discovered by **importing and reading the error**, not
 * by following `package.json`. `dsh-system-prompt` imports `@deepseek-ai/cordis`
 * without declaring it, so a manifest walk stops four packages short and fails
 * with a module-not-found that looks like this script's bug rather than the
 * runtime's layout.
 *
 * @param {string} vendorRoot - a directory to populate as `node_modules`.
 * @returns {Promise<void>} resolves once the registry imports cleanly.
 */
async function vendor(vendorRoot) {
  if (!existsSync(ASAR)) {
    throw new Error(`app.asar not found at ${ASAR}. Set DSH_ASAR to the real path.`);
  }
  const fd = openSync(ASAR, 'r');
  const head = Buffer.alloc(16);
  readSync(fd, head, 0, 16, 0);
  const jsonLen = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLen);
  readSync(fd, jsonBuf, 0, jsonLen, 16);
  const header = JSON.parse(jsonBuf.toString('utf8'));
  const dataStart = 16 + jsonLen;

  const done = new Set();
  let files = 0;
  const pull = (name) => {
    if (done.has(name)) return;
    done.add(name);
    files += copyPackage(header, dataStart, fd, name, vendorRoot);
  };

  for (const name of SEED) pull(name);
  // Then chase whatever the import graph still wants, one package per round.
  //
  // Two error shapes have to be handled. Usually Node names the package
  // ("Cannot find package '@deepseek-ai/dsh-llm'"). But when the missing
  // package's own manifest points at a file that does not exist — `cordis` and
  // `dsh-llm` both do — the message contains the resolved *path* instead, so the
  // name has to be recovered from it. Missing that case is what made an earlier
  // version of this script stop six packages short.
  for (const entry of ROOTS) {
    const file = join(vendorRoot, '@deepseek-ai', entry, 'lib', 'index.js');
    for (let round = 0; round < 80; round += 1) {
      // Each probe runs in a **child process**, and that is not incidental.
      //
      // Node's ESM resolver caches a failed `package.json` lookup as a negative
      // result for the life of the process. The first probe therefore poisons
      // every later one: a package vendored *after* the first probe still resolves
      // by legacy `main`, which for `dsh-llm` means looking for a root `index.js`
      // that has never existed — and reports it as a missing *package*, not a
      // missing file. A fresh process per probe is what makes the discovery
      // terminate.
      const probe = `import(${JSON.stringify(pathToFileURL(file).href)}).then(() => {}, (e) => { process.stderr.write(String(e && e.message || e)); process.exit(1); });`;
      let problem = '';
      try {
        execFileSync(process.execPath, ['-e', probe], { stdio: ['ignore', 'ignore', 'pipe'] });
        break;
      } catch (error) {
        problem = String(error?.stderr ?? '');
        if (!problem.includes('Cannot find package')) throw error;
      }

      // Two message shapes. Usually Node names the package. But when the missing
      // package's manifest points at a file that does not exist, the message
      // carries a resolved *path* instead, so the name is recovered from it —
      // folding Windows separators first.
      const named = /Cannot find package '([^']+)'/u.exec(problem)?.[1] ?? '';
      const normalised = named.replaceAll('\\', '/');
      const fromPath = /node_modules\/((?:@[^/]+\/)?[^/]+)/u.exec(normalised)?.[1] ?? '';
      const specifier = normalised.startsWith('@deepseek-ai/') ? normalised : fromPath;
      if (!specifier.startsWith('@deepseek-ai/')) {
        throw new Error(`the runtime wants a package this script cannot vendor: ${specifier || named}`);
      }

      const wanted = specifier.slice('@deepseek-ai/'.length);
      if (done.has(wanted)) {
        throw new Error(`@deepseek-ai/${wanted} is vendored but unresolvable from ${entry}:\n    ${problem.trim()}`);
      }
      process.stdout.write(`    + @deepseek-ai/${wanted}  (needed by ${entry})\n`);
      pull(wanted);
    }
  }
  closeSync(fd);
  process.stdout.write(`  vendored ${done.size} packages (${files} files) from the asar\n`);
}

// ------------------------------------------------------------------ harness

const RESULTS = [];
async function check(label, fn) {
  try {
    await fn();
    RESULTS.push(['ok  ', label]);
  } catch (error) {
    RESULTS.push(['FAIL', `${label} :: ${error.message}`]);
  }
}

async function main() {
  const keep = process.env.DSH_VERIFY_KEEP === '1';
  const workDir = keep ? join(tmpdir(), 'cyrene-verify-keep') : mkdtempSync(join(tmpdir(), 'cyrene-verify-'));
  if (keep) { rmSync(workDir, { recursive: true, force: true }); mkdirSync(workDir, { recursive: true }); }
  const vendorRoot = join(workDir, 'node_modules');
  mkdirSync(vendorRoot, { recursive: true });
  await vendor(vendorRoot);

  // The plugins come from this checkout, reached through a link so that
  // `import.meta.url` inside them still points at the real `dist/`.
  const link = join(vendorRoot, 'cyrene-agent');
  try {
    symlinkSync(PACKAGE_ROOT, link, 'junction');
  } catch {
    cpSync(PACKAGE_ROOT, link, { recursive: true });
  }

  // Memory must not touch the real store.
  process.env.DSH_HOME = join(workDir, 'home');

  const require = createRequire(join(workDir, 'noop.cjs'));
  // `require.resolve` hands back a Windows path, which the ESM loader rejects
  // outright — it only takes file:, data: or node:. Convert every time.
  const load = async (spec) => import(pathToFileURL(require.resolve(spec)).href);

  const { Context } = await load('@deepseek-ai/cordis');
  const { SystemPrompt, renderPrompt } = await load('@deepseek-ai/dsh-system-prompt');
  const personaModule = await load('cyrene-agent/persona');
  const memoryModule = await load('cyrene-agent/memory');
  const worldbookModule = await load('cyrene-agent/worldbook');

  /** Configured the way the preset's persona row ends up configuring it. */
  const config = {
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
    personaPrefix: '{{cyrene_persona}}'
  };

  const build = async () => {
    const ctx = new Context();
    await ctx.plugin(SystemPrompt, config);
    const service = ctx.get('systemPrompt');
    for (const plugin of [worldbookModule, memoryModule, personaModule]) {
      await ctx.plugin({ apply: plugin.apply, inject: ['systemPrompt'] });
    }
    return service;
  };

  const render = async (service) => renderPrompt(await service.assemble({}));
  const service = await build();
  const prompt = await render(service);

  await check('the real service accepts every registration the plugins make', () => {
    assert.equal(typeof prompt, 'string');
    assert.ok(prompt.length > 1000, `suspiciously short prompt: ${prompt.length} chars`);
  });

  await check('the persona body arrives through the placeholder', () => {
    // The body is the adopted soul now, so the markers are its own.
    assert.ok(prompt.includes('# 昔涟 · Soul'), 'the soul must be present');
    assert.ok(prompt.includes('明亮而不轻浮'), 'and its character core with it');
    assert.ok(prompt.includes('伙伴'), 'the address must survive interpolation');
    const leftover = prompt.match(/\{\{[^}]*\}\}/u);
    assert.equal(leftover, null, `an uninterpolated placeholder survived: ${leftover?.[0]}`);
  });

  await check('the assembled prompt is the persona, not the harness preamble', () => {
    // The soul opens the prompt. What matters is that the harness's own preamble
    // is absent, which `includeHarnessIdentity: false` is responsible for.
    assert.ok(prompt.startsWith('# 系统规则'), `prompt starts with ${JSON.stringify(prompt.slice(0, 40))}`);
    assert.ok(!prompt.includes('You are DeepSeek'), 'no harness identity may leak in');
  });

  await check('the worldbook always-on block reaches the model', () => {
    // It cannot travel through the prompt registry: `complete: true` replaces
    // every other section and `includeRuntimeContext: false` empties the context
    // channel. It is composed into the body instead, so this asserts on the
    // rendered prompt rather than on a registration.
    const always = worldbookModule.readAlwaysBlock();
    assert.ok(always.length > 0, 'the always-on block should not be empty');
    assert.ok(prompt.includes(always.trim()), 'the always-on lore must appear in the prompt');
  });

  await check('memory is composed in, and is empty on a fresh home', async () => {
    const { BLOCK_OPEN } = await import(new URL('../memory-logic.mjs', import.meta.url).href);
    const block = memoryModule.readMemoryBlock();
    assert.equal(block, '', 'a fresh home has nothing remembered');
    // Checked against the block's own delimiter, not the words 长期记忆 — the soul
    // has a section by that name, so the word alone proves nothing.
    assert.ok(!prompt.includes(BLOCK_OPEN), 'and must not leave an empty frame behind');
  });

  await check('the remember tool writes, and the next assembly carries it', async () => {
    // Drive the real plugin with a stand-in tools service, the way a scoped
    // inject would supply one.
    const ctx = new Context();
    await ctx.plugin(SystemPrompt, config);
    const scoped = ctx.get('systemPrompt');
    const tools = new Map();
    const fake = {
      systemPrompt: scoped,
      inject(names, scope) {
        if (names.includes('tools')) scope({ tools: { register: (tool) => tools.set(tool.name, tool) } });
      }
    };
    personaModule.apply(fake);
    memoryModule.apply(fake);
    const remember = tools.get('remember');
    assert.notEqual(remember, undefined, 'the remember tool must register');
    await remember.execute({ text: '喜欢栀子花' });
    const next = await render(scoped);
    assert.ok(next.includes('喜欢栀子花'), 'the write must be visible to the next assembly');
  });

  await check('an edit to the persona file reaches the very next assembly', async () => {
    const file = join(PACKAGE_ROOT, 'dist', 'system-prompt.md');
    const original = readFileSync(file, 'utf8');
    const marker = '这是一行只在这一轮存在的测试文字。';
    try {
      writeFileSync(file, `${original}\n\n## 临时标记\n${marker}\n`);
      assert.ok((await render(service)).includes(marker), 'the edit did not reach the next assembly');
    } finally {
      writeFileSync(file, original);
    }
    assert.ok(!(await render(service)).includes(marker), 'restoring the file did not take effect');
  });

  await check('a provider returning undefined fails the assembly loudly', async () => {
    const ctx = new Context();
    await ctx.plugin(SystemPrompt, config);
    const broken = ctx.get('systemPrompt');
    broken.variable('cyrene_persona', () => undefined);
    await assert.rejects(() => render(broken), /has no value/u);
  });

  await check('an unregistered variable fails the assembly loudly', async () => {
    const ctx = new Context();
    await ctx.plugin(SystemPrompt, { ...config, personaPrefix: '{{nobody_registered_this}}' });
    await assert.rejects(() => render(ctx.get('systemPrompt')), /unknown prompt variable/u);
  });

  // ---------------------------------------------------------------- tools
  //
  // `memory.mjs` hand-writes its tool descriptors instead of importing
  // `@deepseek-ai/dsh-tools`, because the package installs with `link:` and a
  // linked package's own dependencies are the least reliable thing about it. The
  // cost of hand-writing is that nothing type-checks the shape — and the first
  // version got it wrong, in the way that costs the most: `parameters` written as
  // a JSON Schema rather than a property map, which registers cleanly and offers
  // the model three parameters named `type`, `properties` and `required`.
  //
  // The previous fix was verified against a *replica* of the compiler. This runs
  // the real one.

  const { valueSchemaSpecToJsonSchema } = await load('@deepseek-ai/dsh-tools');

  /** Collect the descriptors the memory plugin registers. */
  function memoryTools() {
    const tools = new Map();
    const fake = {
      systemPrompt: { variable() {}, context() {} },
      inject(names, scope) {
        if (names.includes('tools')) scope({ tools: { register: (tool) => tools.set(tool.name, tool) } });
      }
    };
    memoryModule.apply(fake);
    return tools;
  }

  await check('the descriptors carry the schema the model will be given', () => {
    const tools = memoryTools();
    assert.deepEqual([...tools.keys()].sort(), ['forget', 'forgotten', 'remember', 'restore']);

    // Every tool's parameters, stated rather than assumed. A single shape for all
    // of them stopped being true when forget grew a required reason and forgotten
    // was added with an optional keyword.
    const shapes = {
      remember: { properties: ['text'], required: ['text'] },
      forget: { properties: ['keyword', 'reason'], required: ['keyword', 'reason'] },
      forgotten: { properties: ['keyword'], required: [] },
      restore: { properties: ['keyword'], required: ['keyword'] }
    };

    for (const [name, shape] of Object.entries(shapes)) {
      const schema = tools.get(name).parameters;
      // ⚠️ This is the check the previous version got wrong. It ran
      // `parameterSchemaSpecToJsonSchema` over the descriptor — the function
      // `defineTool` calls — while the plugin uses `register`, which stores
      // `parameters` verbatim and never compiles it. The verification passed and
      // the live session still failed, because it was asked about the wrong path.
      assert.equal(schema.type, 'object', `${name}.parameters must already be an object schema`);
      assert.deepEqual(Object.keys(schema.properties), shape.properties, `${name} parameter names`);
      assert.deepEqual(schema.required ?? [], shape.required, `${name} required list`);
      for (const parameter of shape.properties) {
        assert.equal(schema.properties[parameter].type, 'string', `${name}.${parameter} is a string`);
        assert.notEqual(schema.properties[parameter].required, true, 'no defineTool spec may leak into register');
      }
      assert.deepEqual(valueSchemaSpecToJsonSchema(tools.get(name).output.schema), { type: 'string' });
    }
  });

  await check('register accepts the descriptors and keeps them as written', async () => {
    // The real registry, mounted the way the preset mounts it. `ToolRuntime`
    // declares `static inject = ["systemPrompt"]`, so it only comes up on a
    // context that already has the prompt service — mounting it bare is a no-op
    // that looks like a missing service.
    const { default: ToolRuntime } = await load('@deepseek-ai/dsh-tools');
    const ctx = new Context();
    await ctx.plugin(SystemPrompt, config);
    await ctx.plugin(ToolRuntime, {});
    const registry = ctx.get('tools');
    assert.notEqual(registry, undefined, 'the tools service must mount');

    for (const tool of memoryTools().values()) {
      registry.register(tool);
    }
    // Accepted without throwing — and `register` validates `output.schema` on the
    // way in, so a value schema there is genuinely required.
    assert.ok(true);
  });

  await check('the real JSON Schema validator enforces the declared parameters', async () => {
    // ⚠️ `validateArgs(spec, …)` is the wrong tool here, and reaching for it was
    // the third time this file asked a defineTool-path function about a
    // register-path value: internally it calls `parameterSchemaSpecToJsonSchema`,
    // so it expects the author spec. The register path is checked by
    // `validateJsonSchemaValue`, which takes the JSON Schema as written.
    const { validateJsonSchemaValue } = await load('@deepseek-ai/dsh-tools');

    // Per tool, because "a good call" now means different things: `forgotten` may
    // be called with no arguments at all, and `forget` needs both of its own. The
    // blanket shape this replaced is what reported 「forget rejects a good call」
    // when the signature changed — which is the check doing its job.
    const calls = {
      remember: { good: { text: 'x' }, missing: {} },
      forget: { good: { keyword: 'x', reason: 'y' }, missing: { keyword: 'x' } },
      forgotten: { good: {}, missing: null },
      restore: { good: { keyword: 'x' }, missing: {} }
    };

    for (const [name, shape] of Object.entries(calls)) {
      const schema = memoryTools().get(name).parameters;
      assert.deepEqual(validateJsonSchemaValue(schema, shape.good, ''), [], `${name} rejects a good call`);
      if (shape.missing !== null) {
        assert.ok(
          validateJsonSchemaValue(schema, shape.missing, '').length > 0,
          `${name} must reject a call missing a required argument`
        );
      }
      const first = Object.keys(shape.good)[0];
      if (first !== undefined) {
        assert.ok(
          validateJsonSchemaValue(schema, { ...shape.good, [first]: 1 }, '').length > 0,
          `${name} must reject a non-string ${first}`
        );
      }
    }
  });

  for (const [status, label] of RESULTS) process.stdout.write(`  ${status}  ${label}\n`);
  process.stdout.write(`\n  prompt: ${prompt.length} characters, ${prompt.split('\n').length} lines\n`);

  if (!keep) rmSync(workDir, { recursive: true, force: true });
  process.exit(RESULTS.some(([status]) => status === 'FAIL') ? 1 : 0);
}

await main();
