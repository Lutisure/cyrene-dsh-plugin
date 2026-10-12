/**
 * Real-media checks: the host half is mounted in front of whatever is actually
 * in `assets/` and `music/`, and every discovered file is requested back over
 * HTTP.
 *
 * This is the test that would have caught a wrong MIME type, a missing range
 * header, or a manifest that scans one directory layout but not the one the
 * files are stored in. It skips cleanly on a checkout with no media, so the
 * suite still passes before anyone drops assets in.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import test, { after, before } from 'node:test';

import { PLUGIN_ID } from './plugin-id.mjs';

const SCRATCH_HOME = mkdtempSync(join(tmpdir(), 'cyrene-media-'));
process.env.DSH_HOME = SCRATCH_HOME;

const PREFIX = '/theme-cyrene-assets';
const ROOT = new URL('..', import.meta.url);

/** Extensions the host half advertises, mirroring `MEDIA_EXT`. */
const MEDIA_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif',
  '.mp4', '.webm', '.mov',
  '.mp3', '.m4a', '.flac', '.ogg', '.oga', '.opus', '.wav'
]);

/** Files present in a package subdirectory, ignoring dotfiles. */
function filesIn(...segments) {
  try {
    return readdirSync(new URL(`${segments.join('/')}/`, ROOT))
      .filter((name) => !name.startsWith('.') && MEDIA_EXT.has(extname(name).toLowerCase()));
  } catch {
    return [];
  }
}

const WALLPAPERS = filesIn('assets');
const TRACKS = filesIn('music');

let server;
let port;

before(async () => {
  const { apply } = await import('../lib/index.js');
  let registration;
  apply({
    inject: (_services, callback) => callback({
      webServer: {
        register(options) {
          registration = options;
          return () => {};
        }
      },
      effect: (factory) => {
        factory();
        return () => {};
      },
      get: () => undefined
    })
  });
  server = http.createServer((req, res) => registration.handler(req, res));
  await new Promise((settle) => server.listen(0, '127.0.0.1', settle));
  port = server.address().port;
});

after(async () => {
  if (server !== undefined) await new Promise((settle) => server.close(settle));
  rmSync(SCRATCH_HOME, { recursive: true, force: true });
  delete process.env.DSH_HOME;
});

/** One raw request against the mounted route. */
function request(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const call = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    call.on('error', reject);
    call.end();
  });
}

const EXPECTED_TYPE = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.avif': 'image/avif',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav'
};

test('the manifest lists every file that is actually on disk', async (t) => {
  if (WALLPAPERS.length === 0 && TRACKS.length === 0) {
    t.skip('no media in assets/ or music/');
    return;
  }
  const response = await request(`${PREFIX}/manifest`);
  assert.equal(response.status, 200);
  const manifest = JSON.parse(response.body.toString('utf8'));

  const listedWallpapers = manifest.wallpapers.map((entry) => entry.name).sort();
  const listedMusic = manifest.music.map((entry) => entry.name).sort();
  assert.deepEqual(listedWallpapers, [...WALLPAPERS].sort(), 'every wallpaper on disk must appear');
  assert.deepEqual(listedMusic, [...TRACKS].sort(), 'every track on disk must appear');

  // The client marks the first "Default"-named entry per kind as the seed.
  for (const kind of ['image', 'video']) {
    const ofKind = manifest.wallpapers.filter((entry) => entry.kind === kind);
    if (ofKind.length === 0) continue;
    assert.ok(
      ofKind.some((entry) => entry.default === true),
      `expected a default ${kind} wallpaper so a fresh install is not blank`
    );
  }
});

test('every wallpaper is served whole, with the right type and a working range', async (t) => {
  if (WALLPAPERS.length === 0) {
    t.skip('no wallpapers in assets/');
    return;
  }
  for (const name of WALLPAPERS) {
    const size = statSync(new URL(`assets/${name}`, ROOT)).size;
    const whole = await request(`${PREFIX}/pkg/assets/${encodeURIComponent(name)}`);
    assert.equal(whole.status, 200, name);
    assert.equal(whole.headers['content-type'], EXPECTED_TYPE[extname(name).toLowerCase()], name);
    assert.equal(whole.headers['content-length'], String(size), name);
    assert.equal(whole.headers['accept-ranges'], 'bytes', name);
    assert.equal(whole.body.length, size, name);

    // A suffix range is what a media element uses to read the tail, and what
    // `preload="metadata"` relies on for a <video> thumbnail.
    const tail = await request(`${PREFIX}/pkg/assets/${encodeURIComponent(name)}`, { range: 'bytes=-64' });
    assert.equal(tail.status, 206, name);
    assert.equal(tail.headers['content-range'], `bytes ${size - 64}-${size - 1}/${size}`, name);
    assert.equal(tail.body.length, 64, name);
    assert.deepEqual(tail.body, whole.body.subarray(size - 64), `${name}: the tail must match the whole body`);

    // Seeking into the middle must work for a multi-megabyte file too.
    const middle = await request(`${PREFIX}/pkg/assets/${encodeURIComponent(name)}`, {
      range: `bytes=${Math.floor(size / 2)}-${Math.floor(size / 2) + 255}`
    });
    assert.equal(middle.status, 206, name);
    assert.equal(middle.body.length, 256, name);
  }
});

test('every track is served whole, with the right type and a working range', async (t) => {
  if (TRACKS.length === 0) {
    t.skip('no music in music/');
    return;
  }
  for (const name of TRACKS) {
    const size = statSync(new URL(`music/${name}`, ROOT)).size;
    const whole = await request(`${PREFIX}/pkg/music/${encodeURIComponent(name)}`);
    assert.equal(whole.status, 200, name);
    assert.equal(whole.headers['content-type'], EXPECTED_TYPE[extname(name).toLowerCase()], name);
    assert.equal(whole.headers['content-length'], String(size), name);
    assert.equal(whole.headers['accept-ranges'], 'bytes', name);

    // Seeking, which is the whole reason the host half implements ranges.
    const seek = await request(`${PREFIX}/pkg/music/${encodeURIComponent(name)}`, { range: 'bytes=1000-1999' });
    assert.equal(seek.status, 206, name);
    assert.equal(seek.body.length, 1000, name);
    assert.deepEqual(seek.body, whole.body.subarray(1000, 2000), `${name}: the seeked bytes must match`);
  }
});

test('a caller cannot walk out of the media directories', async (t) => {
  if (WALLPAPERS.length === 0) {
    t.skip('no media to anchor the traversal attempt against');
    return;
  }
  for (const attempt of [
    `${PREFIX}/pkg/assets/%2e%2e/package.json`,
    `${PREFIX}/pkg/assets/..%2fpackage.json`,
    `${PREFIX}/pkg/music/..%5c..%5cpackage.json`
  ]) {
    const response = await request(attempt);
    assert.ok(response.status >= 400, `${attempt} must not be served`);
    assert.ok(!response.body.includes(Buffer.from(PLUGIN_ID)), `${attempt} must not leak the manifest`);
  }
});
