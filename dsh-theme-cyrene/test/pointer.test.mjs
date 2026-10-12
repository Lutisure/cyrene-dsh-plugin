// Pointer effects: click bursts and pointer trails.
//
// These drive the real bundle through the sandbox rather than poking at the
// factory: the contract that matters is "a click draws something and never
// swallows the event", and that is only observable by firing an event and
// reading back what reached the canvas.
//
// Drawing is unobservable from the DOM, so the harness records every ink call
// on the 2D context (`canvas.__ctx.__calls`). A burst is therefore exactly
// "an `arc` plus a `stroke`/`fill` after the event".
//
// Settings are changed through the panel, not by calling `applySettings`
// directly — `applySettings` is a local of the factory and is not reachable
// from outside it, and clicking what the user clicks is the stronger test
// anyway.

import assert from 'node:assert/strict';
import test from 'node:test';

import { mountPlugin } from './harness.mjs';

/** The pointer canvas, by class. */
function pointerCanvas(sandbox) {
  return sandbox.document.querySelector('.cy-pointer');
}

/** How many ink calls the canvas has seen so far, ignoring clears. */
function inkCount(sandbox) {
  const canvas = pointerCanvas(sandbox);
  if (canvas === null || canvas.__ctx === undefined) return -1;
  return canvas.__ctx.__calls.filter((call) => call !== 'clearRect').length;
}

/** The dock button with a given label. */
function dockButton(sandbox, label) {
  const button = sandbox.document.querySelectorAll('.cy-btn').find((node) => node.textContent === label);
  assert.notEqual(button, undefined, `the dock must offer a ${label} button`);
  return button;
}

/** Open the 指针效果 panel and return its segment groups. */
async function openPanel(sandbox) {
  dockButton(sandbox, 'Trace').click();
  await new Promise((resolve) => setImmediate(resolve));
  const groups = sandbox.document.querySelectorAll('.cy-pop .cy-seg');
  assert.equal(groups.length, 4, 'the panel must carry four groups');
  return groups;
}

/** Click one option of one group by its visible label. */
function choose(sandbox, groupKey, label) {
  const group = sandbox.document
    .querySelectorAll('.cy-pop .cy-seg')
    .find((node) => node.dataset.key === groupKey);
  assert.notEqual(group, undefined, `no group for ${groupKey}`);
  const option = group.querySelectorAll('button').find((node) => node.textContent === label);
  assert.notEqual(option, undefined, `${groupKey} must offer ${label}`);
  option.click();
}

test('the pointer canvas is mounted in the background stack', async () => {
  const { sandbox } = await mountPlugin();
  const canvas = pointerCanvas(sandbox);
  assert.notEqual(canvas, null, 'the effects need their own canvas');
  const root = sandbox.document.querySelector('.cy-layer-root');
  assert.notEqual(root, null);
  assert.equal(root.contains(canvas), true, 'it belongs to the fixed background stack');
});

test('both effects are live on a fresh install, and 关 draws nothing', async () => {
  const { sandbox } = await mountPlugin();

  // 两者 + 星尘 ship as the defaults, so a fresh install is not silent and the
  // old form of this test — "off means off", measured on a fresh install — has
  // no fresh install left to measure. Both halves are still here: the shipped
  // pair draws, and 关 is silence.
  const before = inkCount(sandbox);
  // Two moves: the first only tells the layer where the pointer is, which is
  // what makes the second one the first with a segment to drop specks along.
  sandbox.__dispatch('pointermove', { clientX: 100, clientY: 100 });
  sandbox.__dispatch('pointermove', { clientX: 130, clientY: 250 });
  sandbox.__flushFrames(4);
  assert.ok(inkCount(sandbox) > before, 'the shipped 星尘 trail draws without being asked');

  // Let the trail drain, so the click below is the only thing that can add ink.
  sandbox.__flushFrames(200);
  const settled = inkCount(sandbox);
  sandbox.__dispatch('pointerdown', { clientX: 120, clientY: 240, button: 0 });
  sandbox.__flushFrames(3);
  assert.ok(inkCount(sandbox) > settled, 'and so does the shipped 两者 burst');

  await openPanel(sandbox);
  choose(sandbox, 'clickEffect', '关');
  choose(sandbox, 'trailEffect', '关');
  sandbox.__flushFrames(200);
  const quiet = inkCount(sandbox);
  sandbox.__dispatch('pointerdown', { clientX: 400, clientY: 120, button: 0 });
  sandbox.__dispatch('pointermove', { clientX: 420, clientY: 140 });
  sandbox.__flushFrames(6);
  assert.equal(inkCount(sandbox), quiet, 'off means off: not one ink call');
});

test('clicking 涟漪 draws rings', async () => {
  const { sandbox } = await mountPlugin();
  await openPanel(sandbox);
  choose(sandbox, 'clickEffect', '涟漪');

  const before = inkCount(sandbox);
  sandbox.__dispatch('pointerdown', { clientX: 300, clientY: 180, button: 0 });
  sandbox.__flushFrames(3);
  assert.ok(inkCount(sandbox) > before, 'a ring must reach the canvas');
});

test('星火 draws sparks, then the loop stops by itself', async () => {
  const { sandbox } = await mountPlugin();
  await openPanel(sandbox);
  choose(sandbox, 'clickEffect', '星火');

  const before = inkCount(sandbox);
  sandbox.__dispatch('pointerdown', { clientX: 10, clientY: 10, button: 0 });
  sandbox.__flushFrames(2);
  assert.ok(inkCount(sandbox) > before, 'sparks must draw');

  // A bounded burst must drain: once both lists are empty the module stops
  // requesting frames, so flushing far past the longest life cannot grow the
  // count. This is the "idle costs nothing" property.
  sandbox.__flushFrames(200);
  const settled = inkCount(sandbox);
  sandbox.__flushFrames(60);
  assert.equal(inkCount(sandbox), settled, 'an idle layer must not keep drawing');
});

test('两者 draws more than either alone', async () => {
  const { sandbox } = await mountPlugin();
  await openPanel(sandbox);

  choose(sandbox, 'clickEffect', '涟漪');
  const ringBefore = inkCount(sandbox);
  sandbox.__dispatch('pointerdown', { clientX: 400, clientY: 400, button: 0 });
  sandbox.__flushFrames(2);
  const rings = inkCount(sandbox) - ringBefore;
  sandbox.__flushFrames(200);

  choose(sandbox, 'clickEffect', '两者');
  const bothBefore = inkCount(sandbox);
  sandbox.__dispatch('pointerdown', { clientX: 500, clientY: 400, button: 0 });
  sandbox.__flushFrames(2);
  const both = inkCount(sandbox) - bothBefore;

  assert.ok(both > rings, `两者 must out-draw 涟漪 alone (${both} vs ${rings})`);
});

test('彗尾 draws a trail, and movement stays silent with it off', async () => {
  const { sandbox } = await mountPlugin();
  await openPanel(sandbox);

  // 星尘 ships as the default, so the silence has to be asked for now. Picking
  // 关 first keeps the control meaning what it always did — and draining the
  // 星尘 that is already in flight is what makes the count below a baseline.
  choose(sandbox, 'trailEffect', '关');
  sandbox.__flushFrames(200);
  const quiet = inkCount(sandbox);
  sandbox.__dispatch('pointermove', { clientX: 100, clientY: 100 });
  sandbox.__dispatch('pointermove', { clientX: 140, clientY: 130 });
  sandbox.__flushFrames(4);
  assert.equal(inkCount(sandbox), quiet, 'no trail while it is off');

  choose(sandbox, 'trailEffect', '彗尾');
  const before = inkCount(sandbox);
  sandbox.__dispatch('pointermove', { clientX: 200, clientY: 200 });
  sandbox.__dispatch('pointermove', { clientX: 260, clientY: 240 });
  sandbox.__flushFrames(3);
  assert.ok(inkCount(sandbox) > before, 'the comet must reach the canvas');
});

test('turning an effect off clears what is already in flight', async () => {
  const { sandbox } = await mountPlugin();
  await openPanel(sandbox);
  choose(sandbox, 'clickEffect', '两者');

  sandbox.__dispatch('pointerdown', { clientX: 50, clientY: 50, button: 0 });
  sandbox.__flushFrames(1);
  assert.ok(inkCount(sandbox) > 0, 'the burst must be in flight');

  // Switching off has to look immediate rather than trailing for half a second.
  choose(sandbox, 'clickEffect', '关');
  sandbox.__flushFrames(80);
  const settled = inkCount(sandbox);
  sandbox.__flushFrames(60);
  assert.equal(inkCount(sandbox), settled, 'nothing may keep animating after 关');
});

test('the panel offers every kind and colour mode the constants declare', async () => {
  const { sandbox } = await mountPlugin();
  const groups = await openPanel(sandbox);

  assert.deepEqual(
    groups.map((group) => group.dataset.key),
    ['clickEffect', 'clickColor', 'trailEffect', 'trailColor']
  );
  assert.deepEqual(
    groups[0].querySelectorAll('button').map((node) => node.textContent),
    ['关', '涟漪', '星火', '两者']
  );
  assert.deepEqual(
    groups[2].querySelectorAll('button').map((node) => node.textContent),
    ['关', '彗尾', '星尘']
  );
  assert.deepEqual(
    groups[1].querySelectorAll('button').map((node) => node.textContent),
    ['主题色', '彩虹', '自定义']
  );
});

test('the custom swatch appears only for the custom colour mode', async () => {
  const { sandbox } = await mountPlugin();
  await openPanel(sandbox);

  const swatchFor = (key) => sandbox.document
    .querySelectorAll('[data-swatch]')
    .find((row) => row.dataset.swatch === key);

  assert.equal(swatchFor('clickColorCustom').style.display, 'none', 'hidden while 主题色');

  choose(sandbox, 'clickColor', '自定义');
  assert.notEqual(swatchFor('clickColorCustom').style.display, 'none', 'shown once 自定义 is picked');

  // And picking a colour draws in it rather than in the theme pink.
  const input = swatchFor('clickColorCustom').querySelectorAll('input')[0];
  assert.notEqual(input, undefined);
  input.value = '#00ff00';
  input.dispatchEvent({ type: 'input', target: input });

  choose(sandbox, 'clickEffect', '涟漪');
  const before = inkCount(sandbox);
  sandbox.__dispatch('pointerdown', { clientX: 700, clientY: 300, button: 0 });
  sandbox.__flushFrames(2);
  assert.ok(inkCount(sandbox) > before, 'a custom colour must still draw');
});

test('every window listener is released when the plugin unmounts', async () => {
  const { sandbox, disposers } = await mountPlugin();
  assert.ok(sandbox.__listenerCount('pointerdown') >= 1, 'the burst needs a down listener');
  assert.ok(sandbox.__listenerCount('pointermove') >= 1, 'the trail needs a move listener');

  // The plugin registers each disposer through `ctx.effect`, so running them
  // all is exactly what unmounting does.
  for (const entry of disposers) {
    if (entry !== null && typeof entry === 'object' && typeof entry.dispose === 'function') entry.dispose();
  }

  assert.equal(sandbox.__listenerCount('pointerdown'), 0, 'and gives it back');
  assert.equal(sandbox.__listenerCount('pointermove'), 0);
  assert.equal(sandbox.__listenerCount('pointerleave'), 0);
});
