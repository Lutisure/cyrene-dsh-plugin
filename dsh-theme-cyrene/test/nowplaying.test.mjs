// Now Playing: the host-side reader and transport.
//
// Two properties are worth more than the happy path here:
//
//   1. **The right methods get called.** The transport methods live on the
//      *session*, not on `PlaybackInfo.Controls` — the first version of the
//      module got that wrong and PowerShell answered "does not contain a method
//      named TryTogglePlayPauseAsync". The spawn is injected so the script text
//      can be inspected without running it, which also keeps the suite from
//      starting and pausing whatever the machine happens to be playing.
//   2. **Nothing throws.** Every failure — no media session, no PowerShell, a
//      player that refuses — has to come back as a value, because the caller is
//      a route handler.
//
// (The asset-serving half of the module has its own file, `media.test.mjs`.)

import assert from 'node:assert/strict';
import test from 'node:test';

import { controlMedia, readMedia, resetMediaCache, __setSpawn } from '../lib/media.js';

/** Decode the `-EncodedCommand` argument back into script text. */
function scriptOf(args) {
  const at = args.indexOf('-EncodedCommand');
  assert.ok(at > 0, 'the script must travel as -EncodedCommand');
  return Buffer.from(args[at + 1], 'base64').toString('utf16le');
}

/** Install a spawn that answers with a fixed payload. */
function stubSpawn(payload, options = {}) {
  const seen = [];
  __setSpawn((file, args) => {
    seen.push({ file, script: scriptOf(args) });
    if (options.throw === true) throw new Error('no powershell');
    if (options.raw !== undefined) return options.raw;
    return JSON.stringify(payload);
  });
  return seen;
}

const SAMPLE = {
  session: true,
  app: 'com.example.player',
  title: '一首歌',
  artist: '歌手',
  album: '专辑',
  subtitle: '',
  status: 'Playing',
  canNext: true,
  canPrev: false,
  canSeek: true,
  position: 12.5,
  duration: 200
};

test('a session is read into a plain document', () => {
  const seen = stubSpawn(SAMPLE);
  const result = readMedia(true);

  assert.equal(result.ok, true);
  assert.equal(result.media.title, '一首歌');
  assert.equal(result.media.artist, '歌手');
  assert.equal(result.media.status, 'Playing');
  assert.equal(result.media.canNext, true);
  assert.equal(result.media.canPrev, false);
  assert.equal(result.media.position, 12.5);
  assert.equal(result.media.duration, 200);

  // The script must force UTF-8 before writing, or a Chinese title arrives at
  // Node as mojibake. That was a real bug, found by looking at the output.
  assert.ok(seen[0].script.includes('[Console]::OutputEncoding'), 'UTF-8 must be forced');
  assert.ok(seen[0].script.includes('AsTask'), 'the reflected await preamble must be present');
});

test('no session is a value, not an error', () => {
  stubSpawn({ session: false });
  const result = readMedia(true);
  assert.equal(result.ok, true, 'the query itself worked');
  assert.equal(result.media, null, 'there is simply nothing playing');
});

test('a failing PowerShell is reported rather than thrown', () => {
  stubSpawn(null, { throw: true });
  const result = readMedia(true);
  assert.equal(result.ok, false);
  assert.equal(result.media, null);
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
});

test('unparseable output does not crash the reader', () => {
  stubSpawn(null, { raw: 'Add-Type : something went wrong\nnot json at all' });
  const result = readMedia(true);
  assert.equal(result.ok, false, 'the reader reports a miss');
});

test('warnings above the payload are skipped', () => {
  stubSpawn(null, { raw: 'WARNING: preparing modules for first use\n' + JSON.stringify(SAMPLE) });
  const result = readMedia(true);
  assert.equal(result.ok, true);
  assert.equal(result.media.title, '一首歌');
});

test('the transport methods are called on the session, not on Controls', () => {
  const cases = [
    ['play', 'TryPlayAsync'],
    ['pause', 'TryPauseAsync'],
    ['toggle', 'TryTogglePlayPauseAsync'],
    ['next', 'TrySkipNextAsync'],
    ['previous', 'TrySkipPreviousAsync'],
    ['stop', 'TryStopAsync']
  ];
  for (const [action, method] of cases) {
    const seen = stubSpawn({ ok: true });
    const result = controlMedia(action);
    assert.equal(result.ok, true, `${action} must be accepted`);
    assert.equal(result.accepted, true);

    const script = seen[0].script;
    assert.ok(script.includes(`$session.${method}(`), `${action} must call $session.${method}`);
    // The regression this test exists for: `$controls` carries capability flags
    // and no transport methods at all.
    assert.equal(
      new RegExp(`\\$controls\\.${method}`, 'u').test(script),
      false,
      `${method} must not be called on $controls`
    );
  }
});

test('an unknown action never reaches the script', () => {
  const seen = stubSpawn({ ok: true });
  const result = controlMedia('; Remove-Item -Recurse C:\\');
  assert.equal(result.ok, false);
  assert.equal(seen.length, 0, 'nothing may be spawned for an unrecognised action');
  assert.ok(result.reason.includes('不认识'));
});

test('a player that refuses is reported as refused, not as success', () => {
  stubSpawn({ ok: false });
  const result = controlMedia('next');
  assert.equal(result.ok, true, 'the call was made');
  assert.equal(result.accepted, false, 'but the session said no');
});

test('a control call that cannot reach a session is a value', () => {
  stubSpawn(null, { throw: true });
  const result = controlMedia('toggle');
  assert.equal(result.ok, false);
  assert.equal(result.action, 'toggle');
});

test('readings are reused inside the cache window, and fresh bypasses it', () => {
  const seen = stubSpawn(SAMPLE);
  resetMediaCache();

  const first = readMedia();
  const second = readMedia();
  assert.equal(first.cached, false);
  assert.equal(second.cached, true, 'the second read is served from the cache');
  assert.equal(seen.length, 1, 'and spawns nothing');

  const fresh = readMedia(true);
  assert.equal(fresh.cached, false);
  assert.equal(seen.length, 2, 'an explicit refresh spawns again');
});

test('a control call invalidates the cached reading', () => {
  stubSpawn(SAMPLE);
  resetMediaCache();
  readMedia();

  // The player is the authority on what happened, so a stale reading must not be
  // served after an action.
  const seen = stubSpawn({ ok: true });
  controlMedia('toggle');
  assert.equal(seen.length, 1);
  stubSpawn(SAMPLE);
  const after = readMedia();
  assert.equal(after.cached, false, 'the reading is taken again');
});
