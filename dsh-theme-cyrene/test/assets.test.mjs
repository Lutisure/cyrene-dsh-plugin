/**
 * Unit tests for the pure host-half helpers.
 *
 * These cover the two places a mistake is expensive: `parseRange` (a wrong
 * answer makes the music player unable to seek and the wallpaper grid
 * download every video in full) and `contain`/`safeName`/`verifyRegularFile`
 * (a wrong answer is a path-traversal hole).
 */

import assert from 'node:assert/strict';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';

import {
  acceptsUpload,
  contain,
  humanBytes,
  kindFor,
  mimeFor,
  parseRange,
  safeName,
  uniqueName,
  uploadCap,
  verifyRegularFile
} from '../lib/assets.js';

const ROOT = resolve('/srv/cyrene');
const inside = (...parts) => join(ROOT, ...parts);

test('parseRange: absent or blank means "serve the whole file"', () => {
  assert.deepEqual(parseRange(undefined, 100), { kind: 'none' });
  assert.deepEqual(parseRange(null, 100), { kind: 'none' });
  assert.deepEqual(parseRange('', 100), { kind: 'none' });
  assert.deepEqual(parseRange('   ', 100), { kind: 'none' });
});

test('parseRange: closed, open and suffix forms', () => {
  assert.deepEqual(parseRange('bytes=0-49', 100), { kind: 'satisfiable', start: 0, end: 49 });
  assert.deepEqual(parseRange('bytes=0-', 100), { kind: 'satisfiable', start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=99-', 100), { kind: 'satisfiable', start: 99, end: 99 });
  assert.deepEqual(parseRange('bytes=0-0', 100), { kind: 'satisfiable', start: 0, end: 0 });
  assert.deepEqual(parseRange('bytes=-10', 100), { kind: 'satisfiable', start: 90, end: 99 });
  // A suffix longer than the resource yields the whole resource.
  assert.deepEqual(parseRange('bytes=-500', 100), { kind: 'satisfiable', start: 0, end: 99 });
  // Surrounding whitespace is tolerated.
  assert.deepEqual(parseRange('  bytes=10-19  ', 100), { kind: 'satisfiable', start: 10, end: 19 });
});

test('parseRange: an end past the resource is clamped, not rejected', () => {
  assert.deepEqual(parseRange('bytes=90-1000', 100), { kind: 'satisfiable', start: 90, end: 99 });
});

test('parseRange: unsatisfiable ranges are distinguished from malformed ones', () => {
  // Well-formed but outside the resource.
  assert.deepEqual(parseRange('bytes=100-', 100), { kind: 'unsatisfiable' });
  assert.deepEqual(parseRange('bytes=200-300', 100), { kind: 'unsatisfiable' });
  assert.deepEqual(parseRange('bytes=50-10', 100), { kind: 'unsatisfiable' });
  assert.deepEqual(parseRange('bytes=-0', 100), { kind: 'unsatisfiable' });
  // Malformed.
  assert.deepEqual(parseRange('bytes=-', 100), { kind: 'invalid' });
  assert.deepEqual(parseRange('bytes=abc-def', 100), { kind: 'invalid' });
  assert.deepEqual(parseRange('items=0-1', 100), { kind: 'invalid' });
  assert.deepEqual(parseRange('bytes=0-49, 60-70', 100), { kind: 'invalid' });
});

test('parseRange: empty resources can never be satisfied', () => {
  assert.deepEqual(parseRange('bytes=0-', 0), { kind: 'unsatisfiable' });
  assert.deepEqual(parseRange('bytes=-1', 0), { kind: 'unsatisfiable' });
  assert.deepEqual(parseRange('bytes=0-0', 0), { kind: 'unsatisfiable' });
});

test('parseRange: absurd and non-integer offsets are rejected rather than overflowed', () => {
  assert.deepEqual(parseRange('bytes=99999999999999999999-', 100), { kind: 'invalid' });
  assert.deepEqual(parseRange('bytes=-99999999999999999999', 100), { kind: 'invalid' });
  assert.deepEqual(parseRange('bytes=1.5-3', 100), { kind: 'invalid' });
});

test('parseRange: a negative size is a programming error, not a served response', () => {
  assert.deepEqual(parseRange('bytes=0-1', -1), { kind: 'invalid' });
});

test('contain: paths inside the root resolve inside it', () => {
  assert.equal(contain(ROOT, 'a/b.jpg'), inside('a', 'b.jpg'));
  assert.equal(contain(ROOT, 'sub/../c.mp4'), inside('c.mp4'));
  assert.equal(contain(ROOT, './d.png'), inside('d.png'));
});

test('contain: every escape shape is refused', () => {
  assert.equal(contain(ROOT, ''), null);
  assert.equal(contain(ROOT, '.'), null);
  assert.equal(contain(ROOT, '..'), null);
  assert.equal(contain(ROOT, '../evil.mp4'), null);
  assert.equal(contain(ROOT, 'a/../../evil.mp4'), null);
  assert.equal(contain(ROOT, '/etc/passwd'), null);
  assert.equal(contain(ROOT, 'C:\\Windows\\win.ini'), null);
  assert.equal(contain(ROOT, 'a\0b.mp4'), null);
  // A sibling directory sharing a name prefix must not pass the startsWith check.
  assert.equal(contain(ROOT, `../${'cyrene'.concat('-evil')}/x.mp4`), null);
});

test('contain: a prefix-sharing sibling is not accepted as inside', () => {
  const target = contain(`${ROOT}${sep}assets`, '../assets-evil/x.png');
  assert.equal(target, null);
});

test('safeName: directory structure and traversal are stripped', () => {
  assert.equal(safeName('a/b.mp4'), 'b.mp4');
  assert.equal(safeName('..\\..\\x.mp4'), 'x.mp4');
  assert.equal(safeName('/absolute/path/y.png'), 'y.png');
  assert.equal(safeName('....//z.mp3'), 'z.mp3');
});

test('safeName: hostile characters and reserved names are neutralised', () => {
  assert.equal(safeName('a<b>c:d"e|f?g*h.mp3'), 'abcdefgh.mp3');
  assert.equal(safeName('CON.mp3'), 'CON_.mp3');
  assert.equal(safeName('nul.png'), 'nul_.png');
  assert.equal(safeName('...hidden.png'), 'hidden.png');
  assert.equal(safeName('trailing... '), 'trailing');
  assert.equal(safeName(''), 'file');
  assert.equal(safeName(undefined), 'file');
  assert.equal(safeName('   '), 'file');
});

test('safeName: non-ASCII names survive, length is capped', () => {
  assert.equal(safeName('昔涟-壁纸 01.jpg'), '昔涟-壁纸 01.jpg');
  const long = `${'x'.repeat(300)}.mp3`;
  const capped = safeName(long);
  assert.equal(capped.length, 120);
  assert.ok(capped.endsWith('.mp3'));
});

test('uniqueName: collisions get a counter before the extension', () => {
  assert.equal(uniqueName([], 'a.mp3'), 'a.mp3');
  assert.equal(uniqueName(['a.mp3'], 'a.mp3'), 'a (1).mp3');
  assert.equal(uniqueName(['a.mp3', 'a (1).mp3'], 'a.mp3'), 'a (2).mp3');
  // Case-insensitive, because Windows and macOS default to case-folding volumes.
  assert.equal(uniqueName(['A.MP3'], 'a.mp3'), 'a (1).mp3');
  assert.equal(uniqueName(['noext'], 'noext'), 'noext (1)');
});

test('uploadCap: a share of free space, but never below the floor', () => {
  const gb = 1024 * 1024 * 1024;
  assert.deepEqual(uploadCap({ bavail: 100, bsize: gb }), { cap: 80 * gb, free: 100 * gb });
  // A full disk still accepts up to the floor rather than rejecting everything.
  assert.deepEqual(uploadCap({ bavail: 0, bsize: 0 }), { cap: 512 * 1024 * 1024, free: 0 });
  assert.deepEqual(uploadCap({ bavail: 1, bsize: 100 }), { cap: 512 * 1024 * 1024, free: 100 });
  assert.deepEqual(uploadCap({}, { share: 0.5, floor: 10 }), { cap: 10, free: 0 });
});

test('media typing and upload acceptance', () => {
  assert.equal(mimeFor('a.MP4'), 'video/mp4');
  assert.equal(mimeFor('a.jpeg'), 'image/jpeg');
  assert.equal(mimeFor('a.unknown'), 'application/octet-stream');
  assert.equal(kindFor('a.mp3'), 'audio');
  assert.equal(kindFor('a.webm'), 'video');
  assert.equal(kindFor('a.gif'), 'image');
  assert.equal(kindFor('a.zip'), undefined);

  assert.equal(acceptsUpload('music', 'song.flac'), true);
  assert.equal(acceptsUpload('music', 'clip.mp4'), false);
  assert.equal(acceptsUpload('wallpaper', 'bg.webp'), true);
  assert.equal(acceptsUpload('wallpaper', 'bg.mov'), false);
  assert.equal(acceptsUpload('nonsense', 'bg.png'), false);
});

test('verifyRegularFile: symlinks, directories and escaping real paths are refused', () => {
  const file = () => ({ isSymbolicLink: () => false, isFile: () => true });
  const link = () => ({ isSymbolicLink: () => true, isFile: () => false });
  const dir = () => ({ isSymbolicLink: () => false, isFile: () => false });
  const missing = () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  const identity = (path) => path;
  const escapes = (path) => (path === ROOT ? ROOT : join(resolve('/elsewhere'), 'x.mp4'));

  const target = inside('assets', 'a.mp4');
  assert.deepEqual(verifyRegularFile(ROOT, target, file, identity), { ok: true, path: target });
  assert.equal(verifyRegularFile(ROOT, target, link, identity).reason, 'symlink');
  assert.equal(verifyRegularFile(ROOT, target, dir, identity).reason, 'not-a-file');
  assert.equal(verifyRegularFile(ROOT, target, missing, identity).reason, 'missing');
  assert.equal(verifyRegularFile(ROOT, target, file, escapes).reason, 'escapes-root');
});

test('humanBytes: readable output', () => {
  assert.equal(humanBytes(0), '0B');
  assert.equal(humanBytes(999), '999B');
  assert.equal(humanBytes(1024), '1.0KB');
  assert.equal(humanBytes(80 * 1024 * 1024 * 1024), '80GB');
});
