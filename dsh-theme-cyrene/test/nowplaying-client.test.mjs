// Now Playing, client side.
//
// The host half has its own file (`nowplaying.test.mjs`). This one is about the
// block inside the music panel: that it asks the host, that it paints what came
// back, that a control press is a POST, and — the part that is easy to get wrong
// — that polling is tied to the panel being open rather than to the plugin being
// loaded.

import assert from 'node:assert/strict';
import test from 'node:test';

import { mountPlugin } from './harness.mjs';

const MEDIA = '/theme-cyrene-assets/media';

/** A canned host answer. */
function mediaResponse(media) {
  return { ok: true, cached: false, media };
}

/** Open the Cyrene panel, which carries the player. */
async function openMusic(sandbox) {
  const button = sandbox.document.querySelectorAll('.cy-btn')
    .find((node) => node.dataset.id === 'music');
  assert.notEqual(button, undefined, 'the dock must offer the music button');
  button.click();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const panel = sandbox.document.querySelector('.cy-pop');
  assert.notEqual(panel, null, 'the panel must open');
  return panel;
}

/** The Now Playing block, or null. */
function block(sandbox) {
  return sandbox.document.querySelector('[data-now-playing]');
}

/** Requests the client made, filtered to the media route. */
function mediaCalls(sandbox) {
  return sandbox.__fetchLog.filter((entry) => entry.path.startsWith(MEDIA));
}

test('the block is part of the player panel', async () => {
  const { sandbox } = await mountPlugin();
  const panel = await openMusic(sandbox);
  const node = panel.querySelector('[data-now-playing]');
  assert.notEqual(node, null, 'the block must exist in the panel');
  assert.notEqual(node.querySelector('.cy-np-bar'), null, 'with a progress strip');
  const controls = node.querySelectorAll('.cy-np-controls button');
  assert.equal(controls.length, 3, 'and three transport buttons');
  assert.deepEqual(
    controls.map((item) => item.dataset.media),
    ['previous', 'toggle', 'next']
  );
});

test('opening the panel asks the host about the current session', async () => {
  const { sandbox } = await mountPlugin({
    responses: new Map([[MEDIA, mediaResponse({
      app: 'com.example.player',
      title: '一首歌',
      artist: '歌手',
      album: '专辑',
      status: 'Playing',
      canNext: true,
      canPrev: false,
      canSeek: true,
      position: 30,
      duration: 120
    })]])
  });
  await openMusic(sandbox);

  assert.ok(mediaCalls(sandbox).length >= 1, 'the host must be asked');
  assert.equal(mediaCalls(sandbox)[0].method, 'GET');

  const node = block(sandbox);
  assert.equal(node.querySelector('.cy-np-title').textContent, '一首歌');
  const sub = node.querySelectorAll('.cy-np-sub')[0].textContent;
  assert.ok(sub.includes('歌手'), `the artist must show, saw ${sub}`);
  assert.ok(sub.includes('播放中'), `and the transport state, saw ${sub}`);

  // The playhead is drawn from the reading, so the strip is not left empty.
  const fill = node.querySelector('.cy-np-fill');
  assert.ok(/^\d+(\.\d+)?%$/u.test(fill.style.width), `expected a width, saw ${fill.style.width}`);
  const times = node.querySelectorAll('.cy-np-sub')[1].textContent;
  assert.ok(/\/\s*2:00$/u.test(times), `expected elapsed / duration, saw ${times}`);
});

test('no session disables the controls and says so', async () => {
  const { sandbox } = await mountPlugin({
    responses: new Map([[MEDIA, { ok: true, cached: false, media: null }]])
  });
  await openMusic(sandbox);

  const node = block(sandbox);
  assert.equal(node.querySelector('.cy-np-title').textContent, '没有正在播放的媒体');
  for (const control of node.querySelectorAll('.cy-np-controls button')) {
    assert.equal(control.disabled, true, 'a control with no session must be disabled');
  }
  assert.equal(node.querySelector('.cy-np-bar').dataset.on, 'false');
});

test('a host that cannot read the session says why', async () => {
  const { sandbox } = await mountPlugin({
    responses: new Map([[MEDIA, { ok: false, media: null, reason: '读不到系统媒体会话' }]])
  });
  await openMusic(sandbox);

  const node = block(sandbox);
  assert.equal(node.querySelector('.cy-np-title').textContent, '读不到系统媒体');
  assert.equal(node.querySelectorAll('.cy-np-sub')[0].textContent, '读不到系统媒体会话');
});

test('capability flags decide which transport buttons are usable', async () => {
  const { sandbox } = await mountPlugin({
    responses: new Map([[MEDIA, mediaResponse({
      app: 'x.y.player',
      title: 'can only go forward',
      artist: '',
      album: '',
      status: 'Paused',
      canNext: true,
      canPrev: false,
      canSeek: false,
      position: 0,
      duration: 0
    })]])
  });
  await openMusic(sandbox);

  const controls = block(sandbox).querySelectorAll('.cy-np-controls button');
  assert.equal(controls[0].disabled, true, 'previous is unavailable');
  assert.equal(controls[1].disabled, false, 'toggle always works');
  assert.equal(controls[2].disabled, false, 'next is available');

  // No duration means no playhead to draw, and the strip must go quiet rather
  // than claim a position it does not have.
  assert.equal(block(sandbox).querySelectorAll('.cy-np-sub')[1].textContent, '');
});

test('pressing a control posts the action to the host', async () => {
  const { sandbox } = await mountPlugin({
    responses: new Map([
      [MEDIA, mediaResponse({
        app: 'x.y.player', title: 't', artist: '', album: '',
        status: 'Playing', canNext: true, canPrev: true, canSeek: false, position: 0, duration: 0
      })]
    ])
  });
  await openMusic(sandbox);

  const toggle = block(sandbox).querySelectorAll('.cy-np-controls button')[1];
  toggle.click();
  await new Promise((resolve) => setImmediate(resolve));

  const posts = mediaCalls(sandbox).filter((entry) => entry.method === 'POST');
  assert.equal(posts.length, 1, 'exactly one control call');
});

test('closing the panel stops the polling', async () => {
  const { sandbox } = await mountPlugin({
    responses: new Map([[MEDIA, mediaResponse({
      app: 'x.y.player', title: 't', artist: '', album: '',
      status: 'Playing', canNext: false, canPrev: false, canSeek: false, position: 0, duration: 0
    })]])
  });
  await openMusic(sandbox);
  const opened = mediaCalls(sandbox).length;
  assert.ok(opened >= 1, 'it polled while open');

  // Close it the way the dock does.
  sandbox.document.querySelectorAll('.cy-btn')
    .find((node) => node.dataset.id === 'music')
    .click();
  await new Promise((resolve) => setImmediate(resolve));

  // Run every pending timer: a stopped block must leave none of its own behind,
  // and one that is still running would post another request here.
  sandbox.__flushTimers();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mediaCalls(sandbox).length, opened, 'a closed panel must not keep asking');

  // The block went with the panel, which is how the close hook fired at all.
  assert.equal(block(sandbox), null, 'the panel tree is gone');
});
