/**
 * Integration tests for the host half.
 *
 * The real route handler is mounted on a real HTTP server and driven over
 * real sockets, because the behaviour that matters here is wire-level: status
 * codes, `Content-Range`, connection draining, and what a crafted path does.
 *
 * `$DSH_HOME` is redirected to a scratch directory *before* `lib/index.js` is
 * imported, since the module derives its storage paths at load time.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PLUGIN_ID } from './plugin-id.mjs';

// `lib/index.js` derives its storage paths at load time, so `$DSH_HOME` must be
// redirected before it is imported — hence a dynamic import in `before()`
// rather than a static one, which ESM would hoist above this assignment.
const SCRATCH_HOME = mkdtempSync(join(tmpdir(), 'cyrene-home-'));
process.env.DSH_HOME = SCRATCH_HOME;

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELFTEST_DIR = join(PKG_ROOT, 'assets', '_selftest');
const SAMPLE = join(SELFTEST_DIR, 'sample.mp4');
const SAMPLE_BYTES = Buffer.from(Array.from({ length: 64 }, (_, index) => index));

/** The route prefix is part of the contract, asserted here rather than trusted. */
const PREFIX = '/theme-cyrene-assets';

/** Captured route registration, filled in by the fake `apply`. */
let registration;

const webCtx = {
  webServer: {
    register(options) {
      registration = options;
      return () => {
        registration = undefined;
      };
    }
  },
  effect(factory) {
    const disposer = factory();
    return typeof disposer === 'function' ? disposer : () => {};
  },
  get(name) {
    return name === 'webServer' ? this.webServer : undefined;
  }
};

let server;
let port;

before(async () => {
  mkdirSync(SELFTEST_DIR, { recursive: true });
  writeFileSync(SAMPLE, SAMPLE_BYTES);

  const { apply } = await import('../lib/index.js');
  apply({ inject: (_services, callback) => callback(webCtx) });
  assert.ok(registration, 'apply() must register a route');
  assert.equal(registration.kind, 'prefix');
  assert.equal(registration.path, PREFIX);

  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) {
      res.writeHead(404).end();
      return;
    }
    // Mirrors the host webserver: a throwing handler becomes a 400.
    Promise.resolve(registration.handler(req, res)).catch(() => {
      res.writeHead(400).end();
    });
  });
  await new Promise((settle) => server.listen(0, '127.0.0.1', settle));
  port = server.address().port;
});

after(async () => {
  if (server !== undefined) await new Promise((settle) => server.close(settle));
  rmSync(SELFTEST_DIR, { recursive: true, force: true });
  rmSync(SCRATCH_HOME, { recursive: true, force: true });
  delete process.env.DSH_HOME;
  delete process.env.DSH_THEME_CYRENE_UPLOAD_CAP;
});

/**
 * Issue one raw request, without a client that would normalise the path.
 * @param {string} path - the exact request target.
 * @param {{method?: string, headers?: Record<string, string>, body?: Buffer|string}} [options] - request options.
 * @returns {Promise<{status: number, headers: Record<string, string>, body: Buffer}>} the response.
 */
function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const call = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers: options.headers ?? {}
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    call.on('error', reject);
    if (options.body !== undefined) call.write(options.body);
    call.end();
  });
}

const json = (response) => JSON.parse(response.body.toString('utf8'));

test('manifest lists the asset buckets and the persisted state', async () => {
  const response = await request(`${PREFIX}/manifest`);
  assert.equal(response.status, 200);
  const body = json(response);
  assert.equal(body.plugin, PLUGIN_ID);
  for (const key of ['wallpapers', 'music', 'covers', 'boot', 'emotes']) {
    assert.ok(Array.isArray(body[key]), `${key} must be an array`);
  }
  assert.equal(typeof body.state, 'object');
  assert.ok(body.limits.uploadCap > 0);
});

test('a bundled file is served whole with range advertisement', async () => {
  const response = await request(`${PREFIX}/pkg/assets/_selftest/sample.mp4`);
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'video/mp4');
  assert.equal(response.headers['content-length'], String(SAMPLE_BYTES.length));
  assert.equal(response.headers['accept-ranges'], 'bytes');
  assert.deepEqual(response.body, SAMPLE_BYTES);
});

test('a closed range answers 206 with an exact Content-Range', async () => {
  const response = await request(`${PREFIX}/pkg/assets/_selftest/sample.mp4`, { headers: { range: 'bytes=0-9' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers['content-range'], 'bytes 0-9/64');
  assert.equal(response.headers['content-length'], '10');
  assert.deepEqual(response.body, SAMPLE_BYTES.subarray(0, 10));
});

test('a suffix range answers 206 from the tail', async () => {
  const response = await request(`${PREFIX}/pkg/assets/_selftest/sample.mp4`, { headers: { range: 'bytes=-4' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers['content-range'], 'bytes 60-63/64');
  assert.deepEqual(response.body, SAMPLE_BYTES.subarray(60));
});

test('an unsatisfiable range answers 416, never a 200', async () => {
  const response = await request(`${PREFIX}/pkg/assets/_selftest/sample.mp4`, { headers: { range: 'bytes=1000-' } });
  assert.equal(response.status, 416);
  assert.equal(response.headers['content-range'], 'bytes */64');
  assert.equal(response.body.length, 0);
});

test('a malformed range answers 416 as well', async () => {
  const response = await request(`${PREFIX}/pkg/assets/_selftest/sample.mp4`, { headers: { range: 'bytes=0-9, 20-29' } });
  assert.equal(response.status, 416);
});

test('HEAD returns the headers without a body', async () => {
  const response = await request(`${PREFIX}/pkg/assets/_selftest/sample.mp4`, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-length'], '64');
  assert.equal(response.body.length, 0);
});

test('HEAD honours a range without sending the bytes', async () => {
  const response = await request(`${PREFIX}/pkg/assets/_selftest/sample.mp4`, {
    method: 'HEAD',
    headers: { range: 'bytes=10-19' }
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers['content-range'], 'bytes 10-19/64');
  assert.equal(response.body.length, 0);
});

test('the brand bucket serves the portrait and is not a wallpaper', async () => {
  // The portrait lives in its own bucket precisely so it is served but never
  // enumerated as a wallpaper: a 404 means the bucket gate rejected it, and a
  // manifest entry would mean it leaked into the Scene grid.
  const response = await request(`${PREFIX}/pkg/brand/cyrene-avatar.webp`);
  assert.equal(response.status, 200, 'brand/ must be served');
  assert.equal(response.headers['content-type'], 'image/webp');

  const manifest = JSON.parse((await request(`${PREFIX}/manifest`)).body.toString('utf8'));
  const urls = (manifest.wallpapers ?? []).map((entry) => String(entry.url ?? ''));
  assert.equal(urls.some((url) => url.includes('cyrene-avatar')), false, 'the portrait is not a wallpaper');
});

test('traversal is refused, encoded or not', async () => {
  // `%2e%2e` is a single-dot path segment to the WHATWG URL parser, so it is
  // collapsed before this plugin ever sees it; the surviving bucket name is
  // simply unknown. Safe, but for a reason outside this plugin's control.
  const dotSegments = await request(`${PREFIX}/pkg/assets/%2e%2e/package.json`);
  assert.equal(dotSegments.status, 404);
  assert.ok(!dotSegments.body.includes(Buffer.from('"name": "dsh-theme-cyrene"')));

  // An encoded separator survives URL normalisation and *does* reach the
  // segment decoder, which is where this plugin's own defence is exercised.
  const forwardSlash = await request(`${PREFIX}/pkg/assets/..%2fpackage.json`);
  assert.equal(forwardSlash.status, 400);

  const backSlash = await request(`${PREFIX}/pkg/assets/..%5cpackage.json`);
  assert.equal(backSlash.status, 400);

  const nested = await request(`${PREFIX}/pkg/assets/%2e%2e%2f%2e%2e%2fpackage.json`);
  assert.equal(nested.status, 400);

  // Double encoding is *not* traversal: it decodes once to the literal
  // directory name `%2e%2e`, which is safely contained and simply absent.
  const doubleEncoded = await request(`${PREFIX}/pkg/assets/%252e%252e/package.json`);
  assert.equal(doubleEncoded.status, 404);
});

test('climbing out of the prefix lands on an unknown route, not a file', async () => {
  for (const attempt of ['/package.json', '/../package.json', '/pkg/%2e%2e/package.json']) {
    const response = await request(attempt);
    assert.ok(response.status >= 400, `${attempt} must not be served (got ${response.status})`);
    assert.ok(!response.body.includes(Buffer.from('"name": "dsh-theme-cyrene"')));
  }
});

test('an unknown bucket is a 404, not a filesystem probe', async () => {
  assert.equal((await request(`${PREFIX}/pkg/etc/passwd`)).status, 404);
  // An encoded separator reaches the decoder and is rejected outright.
  assert.equal((await request(`${PREFIX}/user/wallpapers/%2e%2e%2fx`)).status, 400);
  assert.equal((await request(`${PREFIX}/user/nosuchbucket/a.png`)).status, 404);
});

test('state round-trips through disk', async () => {
  const saved = await request(`${PREFIX}/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ wallpaper: 'builtin:assets/a.jpg', particles: 'trail' })
  });
  assert.equal(saved.status, 200);
  assert.equal(json(saved).state.particles, 'trail');

  const read = await request(`${PREFIX}/state`);
  assert.equal(read.status, 200);
  assert.equal(json(read).state.wallpaper, 'builtin:assets/a.jpg');

  // The document is merged, not replaced.
  await request(`${PREFIX}/state`, {
    method: 'POST',
    headers: { origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ volume: 0.5 })
  });
  const merged = json(await request(`${PREFIX}/state`)).state;
  assert.equal(merged.particles, 'trail');
  assert.equal(merged.volume, 0.5);

  const onDisk = JSON.parse(readFileSync(join(SCRATCH_HOME, 'theme-cyrene', 'state.json'), 'utf8'));
  assert.equal(onDisk.particles, 'trail');
});

test('a cross-origin state change is rejected; a same-origin or proxied one is not', async () => {
  const hostile = await request(`${PREFIX}/state`, {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
    body: JSON.stringify({ hijacked: true })
  });
  assert.equal(hostile.status, 403);

  const opaque = await request(`${PREFIX}/state`, {
    method: 'POST',
    headers: { origin: 'null' },
    body: JSON.stringify({ hijacked: true })
  });
  assert.equal(opaque.status, 403);

  // No Origin at all is how the Desktop shell's proxy presents the request.
  const proxied = await request(`${PREFIX}/state`, { method: 'POST', body: JSON.stringify({ proxied: true }) });
  assert.equal(proxied.status, 200);
  assert.equal(json(proxied).state.proxied, true);
});

test('malformed state is refused without touching the stored document', async () => {
  const before = json(await request(`${PREFIX}/state`)).state;
  assert.equal((await request(`${PREFIX}/state`, { method: 'POST', body: 'not json' })).status, 400);
  assert.equal((await request(`${PREFIX}/state`, { method: 'POST', body: '[1,2,3]' })).status, 400);
  assert.deepEqual(json(await request(`${PREFIX}/state`)).state, before);
});

test('an upload is sanitised, stored, and then served with ranges', async () => {
  const payload = Buffer.from('cyrene-wallpaper-bytes');
  const uploaded = await request(`${PREFIX}/upload?kind=wallpaper&name=${encodeURIComponent('../../evil name.png')}`, {
    method: 'POST',
    body: payload
  });
  assert.equal(uploaded.status, 200);
  const body = json(uploaded);
  assert.equal(body.bucket, 'wallpapers');
  assert.equal(body.name, 'evil name.png');
  assert.equal(body.size, payload.length);

  const stored = join(SCRATCH_HOME, 'theme-cyrene', 'uploads', 'wallpapers', 'evil name.png');
  assert.ok(existsSync(stored), 'the file must land inside the uploads bucket');
  assert.ok(!existsSync(join(SCRATCH_HOME, 'theme-cyrene', 'evil name.png')));

  const served = await request(`${PREFIX}/user/wallpapers/${encodeURIComponent('evil name.png')}`, {
    headers: { range: 'bytes=0-5' }
  });
  assert.equal(served.status, 206);
  assert.equal(served.headers['content-range'], `bytes 0-5/${payload.length}`);
  assert.deepEqual(served.body, payload.subarray(0, 6));
});

test('a second upload of the same name does not overwrite the first', async () => {
  const first = json(await request(`${PREFIX}/upload?kind=cover&name=cover.png`, { method: 'POST', body: 'one' }));
  const second = json(await request(`${PREFIX}/upload?kind=cover&name=cover.png`, { method: 'POST', body: 'two' }));
  assert.equal(first.name, 'cover.png');
  assert.equal(second.name, 'cover (1).png');
});

test('an extension the bucket does not accept is refused', async () => {
  const wrong = await request(`${PREFIX}/upload?kind=music&name=song.mp4`, { method: 'POST', body: 'x' });
  assert.equal(wrong.status, 415);
  const unknown = await request(`${PREFIX}/upload?kind=nonsense&name=a.png`, { method: 'POST', body: 'x' });
  assert.equal(unknown.status, 400);
});

test('an oversized upload is refused after the body is drained, not mid-flight', async () => {
  process.env.DSH_THEME_CYRENE_UPLOAD_CAP = '1024';
  try {
    const oversized = await request(`${PREFIX}/upload?kind=wallpaper&name=big.png`, {
      method: 'POST',
      body: Buffer.alloc(4096, 7)
    });
    assert.equal(oversized.status, 413);
    // A refused upload must leave neither a temp file nor a stored file.
    assert.ok(!existsSync(join(SCRATCH_HOME, 'theme-cyrene', 'uploads', 'wallpapers', 'big.png')));

    // The connection survived, which is the whole point of draining first.
    const after = await request(`${PREFIX}/upload?kind=wallpaper&name=small.png`, { method: 'POST', body: 'ok' });
    assert.equal(after.status, 200);
  } finally {
    delete process.env.DSH_THEME_CYRENE_UPLOAD_CAP;
  }
});

test('delete moves an upload to the trash, and restore brings it back', async () => {
  await request(`${PREFIX}/upload?kind=emote&name=happy.gif`, { method: 'POST', body: 'gifdata' });

  const removed = await request(`${PREFIX}/delete`, {
    method: 'POST',
    body: JSON.stringify({ bucket: 'emotes', name: 'happy.gif' })
  });
  assert.equal(removed.status, 200);
  const trashed = json(removed).trashed;
  assert.ok(!existsSync(join(SCRATCH_HOME, 'theme-cyrene', 'uploads', 'emotes', 'happy.gif')));

  const trash = json(await request(`${PREFIX}/trash`));
  assert.ok(trash.items.some((item) => item.bucket === 'emotes' && item.name === trashed));

  const restored = await request(`${PREFIX}/restore`, {
    method: 'POST',
    body: JSON.stringify({ bucket: 'emotes', name: trashed })
  });
  assert.equal(restored.status, 200);
  assert.equal(json(restored).name, 'happy.gif');
  assert.ok(existsSync(join(SCRATCH_HOME, 'theme-cyrene', 'uploads', 'emotes', 'happy.gif')));
});

test('emptying the trash clears it', async () => {
  await request(`${PREFIX}/upload?kind=emote&name=doomed.gif`, { method: 'POST', body: 'x' });
  await request(`${PREFIX}/delete`, { method: 'POST', body: JSON.stringify({ bucket: 'emotes', name: 'doomed.gif' }) });
  assert.ok(json(await request(`${PREFIX}/trash`)).items.length > 0);

  const emptied = await request(`${PREFIX}/trash/empty`, { method: 'POST' });
  assert.equal(emptied.status, 200);
  assert.deepEqual(json(await request(`${PREFIX}/trash`)).items, []);
});

test('deleting something that is not there is a 404', async () => {
  const missing = await request(`${PREFIX}/delete`, {
    method: 'POST',
    body: JSON.stringify({ bucket: 'emotes', name: 'nope.gif' })
  });
  assert.equal(missing.status, 404);
});

test('unknown routes under the prefix are 404', async () => {
  assert.equal((await request(`${PREFIX}/nonsense`)).status, 404);
  assert.equal((await request(`${PREFIX}/state`, { method: 'PUT' })).status, 404);
});
