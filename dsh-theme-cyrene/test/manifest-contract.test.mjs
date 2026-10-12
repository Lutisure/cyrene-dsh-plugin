/**
 * The manifest URL contract.
 *
 * Every URL the host hands the client has to resolve to a file that exists. That
 * sounds obvious, and it was violated in the running application: emotes carry
 * the bucket `emotes` (the user upload directory, and the key the client filters
 * on) but the bundled ones live at `GIF/emotes/` on disk, so the manifest said
 * `pkg/emotes/…` and every emote answered **404**. The easter egg could never
 * show an image.
 *
 * Nothing caught it, because the client tests hard-coded the URL they expected
 * — `/theme-cyrene-assets/pkg/GIF/<name>` — instead of the one `entry()`
 * produced. A fixture that agrees with itself proves nothing; the two ends of the
 * contract have to meet.
 *
 * `covers` had the same latent defect (`covers` bucket, `music/figure` on disk)
 * with nothing in the directory yet, which is exactly why this is tested through
 * the produced manifest rather than through a hand-written example.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { before } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// `lib/index.js` derives its storage paths at load time, so `$DSH_HOME` has to be
// redirected before it is imported — hence the dynamic import inside `before()`
// rather than a static one, which ESM would hoist above the assignment.
const SCRATCH_HOME = mkdtempSync(join(tmpdir(), 'cyrene-contract-'));
process.env.DSH_HOME = SCRATCH_HOME;

/** One uploaded file per user bucket, so the user half of every URL is exercised. */
const UPLOADS = {
  wallpapers: 'Default_probe.webp',
  covers: 'probe.webp',
  emotes: 'probe.webp',
  boot: 'probe.webp',
  music: 'probe.mp3'
};

let host;
before(async () => {
  host = await import('../lib/index.js');
  // Write the probes *after* importing, because `USER_DIR` is derived at load
  // time from `$DSH_HOME` and is not simply `$DSH_HOME/<bucket>`.
  for (const [bucket, name] of Object.entries(UPLOADS)) {
    mkdirSync(join(host.USER_DIR, bucket), { recursive: true });
    writeFileSync(join(host.USER_DIR, bucket, name), 'probe');
  }
});

/** Turn a manifest URL back into the file it claims to serve. */
function fileFor(url) {
  const prefix = `${host.PREFIX}/`;
  assert.ok(url.startsWith(prefix), `unexpected url prefix: ${url}`);
  const rest = url.slice(prefix.length).split('/');
  const scope = rest.shift();
  const root = scope === 'pkg' ? host.PKG_ROOT : scope === 'user' ? host.USER_DIR : null;
  assert.notEqual(root, null, `unknown scope in ${url}`);
  return join(root, ...rest.map((segment) => decodeURIComponent(segment)));
}

test('every bundled url points at a file that is really there', async () => {
  const manifest = host.buildManifest();
  const builtin = [
    ...manifest.wallpapers,
    ...manifest.music,
    ...manifest.covers,
    ...manifest.boot,
    ...manifest.emotes
  ].filter((entry) => entry.source === 'builtin');

  assert.ok(builtin.length > 0, 'the package ships media, so there must be builtin entries');
  for (const entry of builtin) {
    assert.ok(existsSync(fileFor(entry.url)), `${entry.id} points at ${entry.url}, which does not exist`);
  }
  // The emote set specifically: this is the one that was broken, and a future
  // refactor that drops the set entirely would otherwise pass this file.
  const emotes = manifest.emotes.filter((entry) => entry.source === 'builtin');
  assert.ok(emotes.length > 0, 'the bundled emote set must appear in the manifest');
  assert.ok(
    emotes.some((entry) => entry.url.includes('/pkg/GIF/emotes/')),
    `bundled emotes live under GIF/emotes, so their urls must say so: ${emotes[0].url}`
  );
});

test('every uploaded url points at a file that is really there', async () => {
  const manifest = host.buildManifest();
  const uploaded = [
    ...manifest.wallpapers,
    ...manifest.music,
    ...manifest.covers,
    ...manifest.boot,
    ...manifest.emotes
  ].filter((entry) => entry.source === 'user');

  assert.ok(uploaded.length > 0, 'the probe files should show up');
  for (const entry of uploaded) {
    assert.ok(existsSync(fileFor(entry.url)), `${entry.id} points at ${entry.url}, which does not exist`);
  }
});

test('the bucket in an id is what the client filters on, whatever the path is', () => {
  // The id keeps the bucket, the url carries the served path. Collapsing them
  // into one name is what caused the bug, so the distinction is asserted rather
  // than left to whoever edits `entry()` next.
  const manifest = host.buildManifest();
  const emote = manifest.emotes.find((entry) => entry.source === 'builtin');
  assert.ok(emote.id.startsWith('builtin:emotes/'), `id should carry the bucket: ${emote.id}`);
  assert.ok(emote.url.includes('/pkg/GIF/emotes/'), `url should carry the path: ${emote.url}`);
});

test('the route actually serves the shape the manifest advertises', async () => {
  // `safeRelPath` is what the /pkg/ route runs before touching disk. If it
  // rejected the nested path, the manifest would be advertising something the
  // route refuses — the same class of mismatch, one layer down.
  const manifest = host.buildManifest();
  for (const entry of manifest.emotes.filter((candidate) => candidate.source === 'builtin')) {
    const segments = entry.url
      .slice(`${host.PREFIX}/pkg/`.length)
      .split('/')
      .map((segment) => decodeURIComponent(segment));
    assert.notEqual(host.safeRelPath(segments), null, `the route would refuse ${entry.url}`);
  }
});
