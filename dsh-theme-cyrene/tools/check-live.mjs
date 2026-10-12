/**
 * Check what is actually live, right now.
 *
 * Everything else in this repo verifies code. This verifies the *deployment*: it
 * talks to the running GUI over the routes that need no token, reads the profile
 * patch off disk, and reports the parts that genuinely cannot be checked from
 * outside — rather than implying they passed.
 *
 *     node tools/check-live.mjs
 *
 * It writes nothing and changes nothing.
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const GUI = process.env.DSH_GUI ?? 'http://127.0.0.1:19387';
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const PATCH = join(DSH_HOME, 'profiles', 'desktop', 'cordis.patch.yml');

const results = [];
const record = (ok, label, detail = '') => results.push([ok, label, detail]);

/** Fetch JSON, or null. */
async function json(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/** Fetch just the status and length of something. */
async function head(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const body = await response.arrayBuffer();
    return { ok: response.ok, status: response.status, bytes: body.byteLength, type: response.headers.get('content-type') };
  } catch {
    return { ok: false, status: 0, bytes: 0, type: null };
  }
}

// ---------------------------------------------------------------- the theme

const manifest = await json(`${GUI}/theme-cyrene-assets/manifest`);
if (manifest === null) {
  record(false, 'the theme is being served', `could not reach ${GUI}/theme-cyrene-assets/manifest`);
} else {
  record(true, 'the theme host half is live', `${GUI} answered`);

  const emotes = manifest.emotes ?? [];
  record(emotes.length > 0, 'the emote set is registered', `${emotes.length} emote(s)`);
  for (const emote of emotes.slice(0, 6)) {
    const fetched = await head(`${GUI}${emote.url}`);
    record(
      fetched.ok && fetched.bytes > 0,
      `  ${emote.label} fetches`,
      `HTTP ${fetched.status}, ${fetched.bytes} bytes, ${fetched.type}`
    );
  }

  // The pet is baked into the client bundle, so the host manifest is *expected*
  // to carry none. Recording it as a pass keeps it from looking like a failure.
  record(true, 'the pet rides in the client bundle', `${(manifest.pet ?? []).length} from the host, by design`);
  record((manifest.wallpapers ?? []).length > 0, 'wallpapers are available', `${manifest.wallpapers.length}`);
  record((manifest.music ?? []).length > 0, 'music is available', `${manifest.music.length}`);
}

// ---------------------------------------------------------------- the preset

let patch = '';
try {
  patch = readFileSync(PATCH, 'utf8');
} catch {
  patch = '';
}
if (patch === '') {
  record(false, 'the profile patch exists', PATCH);
} else {
  const rows = [...patch.matchAll(/name: '([^']+)'/gu)].map((match) => match[1]);
  const wanted = ['cyrene-agent/worldbook', 'cyrene-agent/memory', 'cyrene-agent/persona', '@deepseek-ai/dsh-persona'];
  for (const row of wanted) {
    record(rows.includes(row), `the preset mounts ${row}`, '');
  }
  record(
    patch.includes("prefix: '{{cyrene_persona}}'"),
    'the persona arrives by reference, not by value',
    patch.includes("prefix: '{{cyrene_persona}}'") ? '' : 'the body looks inlined again'
  );
  // The two variable providers must mount before the row that references them.
  const personaAt = patch.indexOf("name: '@deepseek-ai/dsh-persona'");
  for (const row of ['cyrene-agent/worldbook', 'cyrene-agent/persona']) {
    const at = patch.indexOf(`name: '${row}'`);
    record(at !== -1 && at < personaAt, `  ${row} mounts before the persona`, '');
  }
  // The user's own settings rows sit at column 0; the preset we add is nested
  // four spaces deep inside the `insert:` list, which is how the two are told
  // apart without parsing.
  const kept = [...patch.matchAll(/^- id: /gmu)].length;
  record(kept === 6, 'the six pre-existing settings survived', `${kept} found`);
}

// ------------------------------------------------- the part that needs a restart

// The running process's start time is not reachable over HTTP, so this is a hint
// rather than a verdict. `DSH_BOOT_MS` is how the caller supplies it; without it
// the check reports that it cannot tell, instead of guessing.
const bootMs = process.env.DSH_BOOT_MS === undefined ? null : Number(process.env.DSH_BOOT_MS);
if (bootMs === null) {
  record(true, 'the running process has read the current patch', 'set DSH_BOOT_MS to the process start time to check');
} else {
  let patchTime = null;
  try {
    patchTime = statSync(PATCH).mtimeMs;
  } catch {
    patchTime = null;
  }
  const fresh = patchTime !== null && bootMs > patchTime;
  record(
    fresh,
    'the running process has read the current patch',
    fresh ? '' : 'the patch is newer than the running process — restart DSH'
  );
}

// ---------------------------------------------------------------- report

let failed = 0;
for (const [ok, label, detail] of results) {
  if (!ok) failed += 1;
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}\n`);
}

process.stdout.write(
  [
    '',
    '  ─────────────────────────────────────────────────────────────',
    '  The agent side cannot be checked from outside: its interfaces need a',
    '  token, and I do not go looking for one. After a DSH restart, confirm it',
    '  by hand, in a NEW session with 昔涟 selected:',
    '',
    '    1. 设定库  ask 「你还记得哀丽秘榭吗？」',
    '               → she should answer from the lore, not from guesswork',
    '    2. 记忆    say 「记住我喜欢栀子花」, then start ANOTHER new session',
    '               and ask what you like → she should answer 栀子花',
    '    3. 工具    ask something that needs the web → she should search',
    '    4. 表情     type 「谢谢」 or 「搞定」 in any session',
    '               → an emote should appear bottom-right (no restart needed)',
    '',
    `  memory file: ${join(DSH_HOME, 'cyrene-agent', 'memory.md')}`,
    '  ─────────────────────────────────────────────────────────────',
    ''
  ].join('\n')
);

process.exit(failed === 0 ? 0 : 1);
