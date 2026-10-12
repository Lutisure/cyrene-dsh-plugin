// The dock's arrangement: fixed slots, movable slots, and the three ways to
// change which is which.
//
// Two things are worth knowing before reading the tests below.
//
// The first is that the *only* unrecoverable failure in this feature is a slot
// that stops being rendered. A slot rendered twice is odd; a slot rendered zero
// times has left the interface, and the control that could have brought it back
// went with it. That is why the repair tests below are the longest ones.
//
// The second is that a click and a reorder begin with the same `pointerdown`.
// Every threshold test is therefore really a test of which of the two gestures a
// given amount of movement belongs to — too small a threshold and the panels
// stop opening for anyone whose hand is not perfectly still, too large and the
// drag never starts.

import assert from 'node:assert/strict';
import test from 'node:test';

import { mountPlugin } from './harness.mjs';

/** The settings document as the plugin mirrored it. */
function settingsOf(sandbox) {
  const raw = sandbox.localStorage.getItem('dsh-theme-cyrene:settings');
  return raw === null ? {} : JSON.parse(raw);
}

/** Elements under a root. */
function all(root, selector) {
  return root.querySelectorAll(selector);
}

/** The bar itself. */
function bar(sandbox) {
  const node = sandbox.document.querySelector('.cy-dock');
  assert.notEqual(node, null, 'the dock must be mounted');
  return node;
}

/** One of the bar's two groups. */
function group(sandbox, which) {
  const node = bar(sandbox).querySelector(`[data-group="${which}"]`);
  assert.notEqual(node, null, `the ${which} group must exist`);
  return node;
}

/** The slot ids of a group, in DOM order. */
function idsOf(sandbox, which) {
  return all(group(sandbox, which), '.cy-btn').map((node) => node.dataset.id);
}

/** Every slot in the bar, fixed group then movable group, in render order. */
function renderOrder(sandbox) {
  return idsOf(sandbox, 'fixed').concat(idsOf(sandbox, 'free'));
}

/** A dock button by its slot id. */
function button(sandbox, id) {
  const found = all(bar(sandbox), '.cy-btn').find((node) => node.dataset.id === id);
  assert.notEqual(found, undefined, `the bar must carry a ${id} slot`);
  return found;
}

/**
 * Dispatch a pointer event at a node.
 *
 * The event bubbles, which is the whole point: the same `pointermove` reaches
 * the button's own drag handler and the window listener that moves the bar, and
 * a test has to be able to see which of the two acted on it.
 *
 * @param {object} node - the target.
 * @param {string} type - the event type.
 * @param {number} x - horizontal position.
 * @param {number} y - vertical position.
 * @returns {object} the event, so a test can read `defaultPrevented`.
 */
function fire(node, type, x, y) {
  const event = {
    type,
    target: node,
    button: 0,
    pointerId: 1,
    clientX: x,
    clientY: y,
    __stopped: false,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {
      event.__stopped = true;
    }
  };
  node.dispatchEvent(event);
  return event;
}

/**
 * Press, drag, release — as a browser would deliver it.
 *
 * The move is delivered in small steps rather than as one jump, because that is
 * what a real pointer produces and the two are not equivalent here: the drag
 * handler acts on the first move that crosses a slot boundary and ignores every
 * move after it, so a single jump measures the destination while a real drag
 * measures the route. Testing the first is how a rule that only works when the
 * pointer teleports passes.
 *
 * @param {object} node - the button to drag.
 * @param {number} dx - how far right to move.
 * @param {{release?: boolean, step?: number}} [options] - `release: false` leaves
 *   the gesture open; `step` sets how far each move travels.
 * @returns {{start: object, moves: object[]}} the events, for assertions.
 */
function drag(node, dx, options = {}) {
  const rect = node.getBoundingClientRect();
  const step = options.step ?? 5;
  const startX = rect.left + rect.width / 2;
  const startY = rect.top + rect.height / 2;
  const out = { start: fire(node, 'pointerdown', startX, startY), moves: [] };
  const steps = Math.max(1, Math.ceil(Math.abs(dx) / step));
  for (let at = 1; at <= steps; at += 1) {
    const travel = (dx * at) / steps;
    out.moves.push(fire(node, 'pointermove', startX + travel, startY));
  }
  if (options.release !== false) fire(node, 'pointerup', startX + dx, startY);
  return out;
}

/** Whether a panel from this plugin is currently open. */
function popoverOpen(sandbox) {
  return sandbox.document.querySelector('.cy-pop') !== null;
}

/** Open the Scene panel, which carries the arrangement rows. */
async function openScene(sandbox) {
  button(sandbox, 'wallpaper').click();
  await new Promise((resolve) => setImmediate(resolve));
  const panel = sandbox.document.querySelector('.cy-pop');
  assert.notEqual(panel, null, 'the Scene panel must open');
  return panel;
}

/** One arrangement row in the Scene panel. */
function dockRow(panel, id) {
  const row = panel.querySelector(`[data-dock-row="${id}"]`);
  assert.notEqual(row, null, `the panel must carry a row for ${id}`);
  return row;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

test('the default arrangement renders as two groups, fixed first', async () => {
  const { sandbox } = await mountPlugin();
  assert.deepEqual(idsOf(sandbox, 'fixed'), ['music', 'wallpaper'], 'the identity and the arrangement panel');
  assert.deepEqual(idsOf(sandbox, 'free'), ['sound', 'fonts', 'particles', 'pointer']);
  assert.deepEqual(renderOrder(sandbox), ['music', 'wallpaper', 'sound', 'fonts', 'particles', 'pointer']);
  // Every slot exactly once. The registry and the two settings arrays are three
  // separate declarations of the same six ids, and this is what catches them
  // drifting apart.
  const every = renderOrder(sandbox);
  assert.equal(new Set(every).size, 6);
  assert.equal(every.length, 6);
});

test('a stored arrangement is what renders', async () => {
  const { sandbox } = await mountPlugin({
    settings: { dockFixed: ['wallpaper', 'music'], dockOrder: ['pointer', 'particles', 'fonts', 'sound'] }
  });
  assert.deepEqual(idsOf(sandbox, 'fixed'), ['wallpaper', 'music'], 'fixed slots keep the declared order');
  assert.deepEqual(idsOf(sandbox, 'free'), ['pointer', 'particles', 'fonts', 'sound'], 'movable slots keep the saved one');
});

test('the fold control is outside the arrangement entirely', async () => {
  const { sandbox } = await mountPlugin({
    settings: { dockFixed: ['music'], dockOrder: ['sound', 'wallpaper', 'fonts', 'particles', 'pointer'] }
  });
  // `wallpaper` is movable in this document, so the bar's last slot is the free
  // group's — and the fold control still has to be after it, not inside it.
  const children = bar(sandbox).childNodes;
  assert.equal(children[children.length - 2].attributes.class, 'cy-btn cy-fold');
  assert.equal(group(sandbox, 'fixed').querySelector('.cy-fold'), null);
  assert.equal(group(sandbox, 'free').querySelector('.cy-fold'), null);
});

test('every id this build knows has a piece, an icon and a name', async () => {
  // A slot with no icon renders as an empty button, and the mapping from id to
  // drawn shape is the one thing no test above can see. `dockIcon` returning
  // null is exactly that failure.
  const { sandbox } = await mountPlugin();
  const drawn = all(bar(sandbox), '.cy-btn').filter((node) => node.dataset.id !== undefined);
  assert.equal(drawn.length, 6);
  for (const node of drawn) {
    assert.notEqual(node.querySelector('svg'), null, `${node.dataset.id} draws nothing`);
  }
  // And the same six in the management rows, from the same registry.
  const panel = await openScene(sandbox);
  const rows = all(panel, '[data-dock-row]').map((node) => node.dataset.dockRow);
  assert.deepEqual(rows, ['sound', 'fonts', 'particles', 'pointer', 'music', 'wallpaper']);
  for (const id of rows) {
    assert.notEqual(dockRow(panel, id).querySelector('svg'), null, `${id}'s row draws nothing`);
  }
});

/* ------------------------------------------------------------------ *
 * Repair: the invariant that no slot may be lost
 * ------------------------------------------------------------------ */

test('a short saved array is repaired rather than obeyed', async () => {
  // Two of the four movable slots are missing. There is no evidence anywhere in
  // the document of where they were meant to sit, so the whole arrangement goes
  // back to the default — all six slots, in the shipped order.
  const { sandbox } = await mountPlugin({
    settings: { dockFixed: ['music', 'wallpaper'], dockOrder: ['sound', 'fonts'] }
  });
  assert.deepEqual(renderOrder(sandbox), ['music', 'wallpaper', 'sound', 'fonts', 'particles', 'pointer']);
  // Repaired, not merely displayed repaired: the document is rewritten, so the
  // next mount starts from an arrangement that is already whole.
  const saved = settingsOf(sandbox);
  assert.deepEqual(saved.dockFixed, ['music', 'wallpaper']);
  assert.deepEqual(saved.dockOrder, ['sound', 'fonts', 'particles', 'pointer']);
});

test('a saved array naming a slot that does not exist is repaired', async () => {
  const { sandbox } = await mountPlugin({
    settings: { dockFixed: ['music'], dockOrder: ['sound', 'fonts', 'particles', 'pointer', 'ghost'] }
  });
  assert.deepEqual(renderOrder(sandbox), ['music', 'wallpaper', 'sound', 'fonts', 'particles', 'pointer']);
  assert.equal(renderOrder(sandbox).includes('ghost'), false);
  // `wallpaper` came back even though it was in neither saved array: the repair
  // restores the default rather than merging, so a slot missing from the
  // document cannot stay missing.
  assert.deepEqual(settingsOf(sandbox).dockFixed, ['music', 'wallpaper']);
});

test('a slot listed twice sends the whole document back to the default', async () => {
  // The subtle one. `["sound","sound","particles","pointer"]` is four entries
  // long and passes a length check, and a repair that only looked for missing
  // ids would accept it — rendering `sound` twice and `fonts` never.
  const { sandbox } = await mountPlugin({
    settings: { dockFixed: ['music', 'wallpaper'], dockOrder: ['sound', 'sound', 'particles', 'pointer'] }
  });
  const every = renderOrder(sandbox);
  assert.equal(new Set(every).size, 6, `saw ${JSON.stringify(every)}`);
  assert.equal(every.filter((id) => id === 'sound').length, 1, 'a slot must not render twice');
  assert.deepEqual(every, ['music', 'wallpaper', 'sound', 'fonts', 'particles', 'pointer']);
  assert.equal(every.includes('fonts'), true, 'and the slot crowded out must come back');
});

test('a saved array that is not an array at all is repaired', async () => {
  const { sandbox } = await mountPlugin({ settings: { dockFixed: null, dockOrder: 'sound' } });
  assert.deepEqual(renderOrder(sandbox), ['music', 'wallpaper', 'sound', 'fonts', 'particles', 'pointer']);
  assert.deepEqual(settingsOf(sandbox).dockOrder, ['sound', 'fonts', 'particles', 'pointer']);
});

test('a slot fixed twice, and one fixed nowhere, is repaired', async () => {
  // The two arrays are one partition. A document that lists `music` in both is
  // not two arrangements that happen to overlap; it is a document this build
  // cannot read, and the difference matters because obeying it drops `wallpaper`.
  const { sandbox } = await mountPlugin({
    settings: { dockFixed: ['music', 'music'], dockOrder: ['sound', 'fonts', 'particles', 'pointer'] }
  });
  assert.deepEqual(renderOrder(sandbox), ['music', 'wallpaper', 'sound', 'fonts', 'particles', 'pointer']);
});

/* ------------------------------------------------------------------ *
 * Fixed slots refuse to move
 * ------------------------------------------------------------------ */

test('a fixed slot cannot be dragged', async () => {
  const { sandbox } = await mountPlugin();
  const fixed = button(sandbox, 'music');
  const before = renderOrder(sandbox);
  // Well past the threshold, and far enough to the right to cross two movable
  // slots — which is the drag that would reorder it if fixed meant anything less
  // than "cannot be moved".
  drag(fixed, 200);
  assert.deepEqual(renderOrder(sandbox), before, 'the bar must be unchanged');
  assert.deepEqual(settingsOf(sandbox).dockFixed, ['music', 'wallpaper']);
  assert.deepEqual(settingsOf(sandbox).dockOrder, ['sound', 'fonts', 'particles', 'pointer']);
  // Not even the transient feedback for a drag it is refusing: `data-dragging`
  // is what dims the button and draws the gap.
  assert.equal(fixed.dataset.dragging, undefined, 'a fixed slot must not enter the drag state');
  assert.equal(bar(sandbox).querySelector('[data-drop="true"]'), null, 'and must not open a gap');
});

test('a fixed slot refuses the keyboard reorder too', async () => {
  const { sandbox } = await mountPlugin();
  const fixed = button(sandbox, 'wallpaper');
  fixed.dispatchEvent({ type: 'keydown', target: fixed, key: 'ArrowLeft', altKey: true });
  assert.deepEqual(renderOrder(sandbox), ['music', 'wallpaper', 'sound', 'fonts', 'particles', 'pointer']);
  assert.deepEqual(settingsOf(sandbox).dockOrder, ['sound', 'fonts', 'particles', 'pointer']);
});

/* ------------------------------------------------------------------ *
 * The 4 px threshold: click or drag, never both
 * ------------------------------------------------------------------ */

test('a 2 px move is still a click, and opens the panel', async () => {
  const { sandbox } = await mountPlugin();
  const sound = button(sandbox, 'sound');
  drag(sound, 2);
  // The click a browser would send after the pointerup, which the harness has no
  // reason to synthesise on a pointer gesture.
  sound.click();
  assert.equal(sound.dataset.dragging, undefined, 'a wobble must not start a drag');
  assert.equal(
    settingsOf(sandbox).sound,
    true,
    'the press has to reach the button, wobbly or not'
  );
  assert.deepEqual(settingsOf(sandbox).dockOrder, ['sound', 'fonts', 'particles', 'pointer'], 'and must not reorder');
});

test('a brief move is a drag, and only changes places once it crosses a slot', async () => {
  const { sandbox } = await mountPlugin();
  const sound = button(sandbox, 'sound');
  const free = group(sandbox, 'free');
  // Ten pixels: past the 4 px threshold, so this is a drag and not a click, but
  // still inside `sound`'s own slot — the boundary with the slot next door is a
  // full slot away from the middle of this one.
  const events = drag(sound, 10);
  assert.equal(events.moves[0].defaultPrevented, true, 'the default gesture is cancelled');
  assert.deepEqual(idsOf(sandbox, 'free'), ['sound', 'fonts', 'particles', 'pointer'], 'ten pixels stays in place');
  assert.deepEqual(settingsOf(sandbox).dockOrder, ['sound', 'fonts', 'particles', 'pointer'], 'and nothing was persisted');

  // Far enough to enter the next slot, and the two change places.
  drag(sound, 40);
  assert.deepEqual(idsOf(sandbox, 'free'), ['fonts', 'sound', 'particles', 'pointer'], 'forty pixels swaps them');
  // The gap marked where the button would land, and the button is now there.
  //
  // This line used to read `assert.equal(free.childNodes[1].attributes.class,
  // 'cy-drop', 'the gap sits where the button landed')` — asking the gap to
  // outlive the drop, which `a drag shows a gap rather than highlighting a slot`
  // pins in the opposite direction: "the gap goes away on drop". `drag()`
  // releases by default, so that assertion was checking a mid-gesture fact after
  // the gesture had ended. The mid-gesture form of the same claim is covered,
  // correctly, in `a drag across two slots moves two places` — which fires its
  // moves and asserts before its own pointerup. What is worth asserting here is
  // the half that survives the drop: the button occupies the slot, and the gap
  // is gone.
  assert.equal(free.childNodes[1], sound, 'the button took the slot the gap was drawn in');
  assert.equal(bar(sandbox).querySelector('[data-drop="true"]'), null, 'and the gap itself is gone');
  assert.deepEqual(settingsOf(sandbox).dockOrder, ['fonts', 'sound', 'particles', 'pointer'], 'and the order was persisted');

  // The click that follows a pointerup on a moved button is not a press anyone
  // made. Without the swallow, every reorder would also toggle a subsystem.
  sound.click();
  assert.equal(settingsOf(sandbox).sound, false, 'the click after a drag must be swallowed');
  // 星点 is the shipped default, and the swallowed click must leave it there.
  assert.equal(settingsOf(sandbox).particles, 'star', 'and it must not fire the next press either');
});

test('a drag across two slots moves two places, and carries its own gap', async () => {
  // The reason the gap is drawn as "where the button already is" rather than as a
  // separate marker: a preview computed by one rule and a drop computed by
  // another disagree the moment a drag crosses more than one slot, and the user
  // sees a gap in a place the button does not land.
  const { sandbox } = await mountPlugin();
  const sound = button(sandbox, 'sound');
  const free = group(sandbox, 'free');
  const rect = sound.getBoundingClientRect();
  const startX = rect.left + rect.width / 2;
  const startY = rect.top + rect.height / 2;
  fire(sound, 'pointerdown', startX, startY);
  fire(sound, 'pointermove', startX + 100, startY);
  assert.deepEqual(
    free.childNodes.map((node) => node.dataset.id ?? node.attributes.class),
    ['fonts', 'particles', 'cy-drop', 'sound', 'pointer'],
    'the gap and the button travel together'
  );
  fire(sound, 'pointerup', startX + 100, startY);
  assert.deepEqual(idsOf(sandbox, 'free'), ['fonts', 'particles', 'sound', 'pointer'], 'and the drop agrees with the gap');
});

test('a drag past every slot lands at the end of the group', async () => {
  const { sandbox } = await mountPlugin();
  const sound = button(sandbox, 'sound');
  drag(sound, 240);
  assert.deepEqual(idsOf(sandbox, 'free'), ['fonts', 'particles', 'pointer', 'sound']);
  assert.deepEqual(settingsOf(sandbox).dockOrder, ['fonts', 'particles', 'pointer', 'sound']);
});

test('a drag back to the front lands at the start of the group', async () => {
  const { sandbox } = await mountPlugin();
  const particles = button(sandbox, 'particles');
  // Far enough left to pass both slots in front of it, measured from its centre.
  drag(particles, -150);
  assert.deepEqual(idsOf(sandbox, 'free'), ['particles', 'sound', 'fonts', 'pointer']);
  assert.deepEqual(settingsOf(sandbox).dockOrder, ['particles', 'sound', 'fonts', 'pointer']);
});

test('a drag shows a gap rather than highlighting a slot', async () => {
  const { sandbox } = await mountPlugin();
  const sound = button(sandbox, 'sound');
  const rect = sound.getBoundingClientRect();
  const startX = rect.left;
  const startY = rect.top + rect.height / 2;
  fire(sound, 'pointerdown', startX, startY);
  assert.equal(sound.dataset.dragging, undefined, 'nothing happens below the threshold');
  assert.equal(bar(sandbox).querySelector('[data-drop="true"]'), null);

  fire(sound, 'pointermove', startX + 30, startY);
  const gap = bar(sandbox).querySelector('[data-drop="true"]');
  assert.notEqual(gap, null, 'past the threshold the insertion point is drawn');
  assert.equal(sound.dataset.dragging, 'true');
  // The gap is a slot-shaped spacer, and the button travels immediately after
  // it: that pair is what says "it lands here" instead of "it is near this".
  const free = group(sandbox, 'free').childNodes;
  assert.equal(free[free.indexOf(gap) + 1], sound, 'the button follows its gap');

  fire(sound, 'pointerup', startX + 30, startY);
  assert.equal(bar(sandbox).querySelector('[data-drop="true"]'), null, 'the gap goes away on drop');
  assert.equal(sound.dataset.dragging, undefined);
});

test('a drag never moves the bar as well as the button', async () => {
  const { sandbox } = await mountPlugin();
  const sound = button(sandbox, 'sound');
  const left = sandbox.document.querySelector('.cy-dock-wrap').style.left;
  drag(sound, 40);
  // The bar's own drag is bound to the wrapper and excludes `.cy-btn`. A button
  // press that leaked through to it would slide the whole control across the
  // screen every time someone rearranged a slot.
  assert.equal(sandbox.document.querySelector('.cy-dock-wrap').dataset.dragging, undefined, 'the bar must not be dragged');
  assert.equal(sandbox.document.querySelector('.cy-dock-wrap').style.left, left, 'and must not have moved');
});

test('a drag started on the bar itself still moves the bar', async () => {
  const { sandbox } = await mountPlugin();
  const wrap = sandbox.document.querySelector('.cy-dock-wrap');
  const handle = sandbox.document.querySelector('.cy-dock-handle');
  fire(handle, 'pointerdown', 400, 600);
  assert.equal(wrap.dataset.dragging, 'true', 'the grip is the bar drag, and it must keep working');
  fire(handle, 'pointermove', 500, 500);
  fire(handle, 'pointerup', 500, 500);
  assert.equal(wrap.dataset.dragging, undefined);
  assert.notEqual(settingsOf(sandbox).dockPos, null, 'the new position is remembered');
});

/* ------------------------------------------------------------------ *
 * Keyboard
 * ------------------------------------------------------------------ */

test('Alt+ArrowLeft swaps a movable slot with its neighbour', async () => {
  const { sandbox } = await mountPlugin();
  const fonts = button(sandbox, 'fonts');
  fonts.dispatchEvent({ type: 'keydown', target: fonts, key: 'ArrowLeft', altKey: true });
  assert.deepEqual(idsOf(sandbox, 'free'), ['fonts', 'sound', 'particles', 'pointer']);
  assert.deepEqual(settingsOf(sandbox).dockOrder, ['fonts', 'sound', 'particles', 'pointer'], 'and it is persisted');

  // The other direction: `particles` is third of four, so there is a slot to its
  // right and it takes it.
  const particles = button(sandbox, 'particles');
  particles.dispatchEvent({ type: 'keydown', target: particles, key: 'ArrowRight', altKey: true });
  assert.deepEqual(idsOf(sandbox, 'free'), ['fonts', 'sound', 'pointer', 'particles'], 'the other direction moves right');

  // At the end of the group there is nowhere to go, and that is not an error.
  const last = button(sandbox, 'particles');
  last.dispatchEvent({ type: 'keydown', target: last, key: 'ArrowRight', altKey: true });
  assert.deepEqual(idsOf(sandbox, 'free'), ['fonts', 'sound', 'pointer', 'particles']);
});

test('an arrow without Alt is left to the host', async () => {
  const { sandbox } = await mountPlugin();
  const fonts = button(sandbox, 'fonts');
  const event = {
    type: 'keydown',
    target: fonts,
    key: 'ArrowLeft',
    altKey: false,
    defaultPrevented: false,
    preventDefault() { event.defaultPrevented = true; },
    stopPropagation() {}
  };
  fonts.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false, 'the bar must not swallow plain arrow keys');
  assert.deepEqual(idsOf(sandbox, 'free'), ['sound', 'fonts', 'particles', 'pointer']);
});

test('a reorder is announced, because focus does not move', async () => {
  const { sandbox } = await mountPlugin();
  const live = bar(sandbox).querySelector('[data-live="dock"]');
  assert.notEqual(live, null, 'the bar must carry a live region');
  assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.equal(live.textContent, '', 'and start silent');

  const fonts = button(sandbox, 'fonts');
  fonts.dispatchEvent({ type: 'keydown', target: fonts, key: 'ArrowLeft', altKey: true });
  // Written on a later tick so a repeated message is still a change the live
  // region can announce; the same text written twice is silence.
  assert.equal(live.textContent, '', 'the clear comes first, on purpose');
  sandbox.__flushTimers();
  assert.match(live.textContent, /字体/, `saw ${JSON.stringify(live.textContent)}`);
  assert.match(live.textContent, /1/, 'and says where it landed');
});

/* ------------------------------------------------------------------ *
 * The management rows
 * ------------------------------------------------------------------ */

test('the Scene panel lists every slot, in the order the bar shows them', async () => {
  const { sandbox } = await mountPlugin();
  const panel = await openScene(sandbox);
  const rows = all(panel, '[data-dock-row]').map((node) => node.dataset.dockRow);
  // Movable slots in their saved order, then the fixed ones: the same order the
  // bar reads in, so a row and a slot can be matched by looking.
  assert.deepEqual(rows, ['sound', 'fonts', 'particles', 'pointer', 'music', 'wallpaper']);
  const toggles = all(panel, '[data-dock-row] .cy-dockrow-toggle').map((node) => node.textContent);
  assert.deepEqual(toggles, ['可排', '可排', '可排', '可排', '固定', '固定']);
});

test('the 固定 / 可排 toggle moves a slot between the groups', async () => {
  const { sandbox } = await mountPlugin();
  const panel = await openScene(sandbox);

  dockRow(panel, 'sound').querySelector('.cy-dockrow-toggle').click();
  assert.deepEqual(idsOf(sandbox, 'fixed'), ['music', 'wallpaper', 'sound'], 'it joins the fixed group');
  assert.deepEqual(idsOf(sandbox, 'free'), ['fonts', 'particles', 'pointer']);
  assert.deepEqual(settingsOf(sandbox).dockFixed, ['music', 'wallpaper', 'sound']);
  assert.deepEqual(settingsOf(sandbox).dockOrder, ['fonts', 'particles', 'pointer']);

  // And back, which is the direction that has to put it somewhere sensible: it
  // lands at the end of the movable group rather than vanishing from both lists.
  dockRow(panel, 'sound').querySelector('.cy-dockrow-toggle').click();
  assert.deepEqual(idsOf(sandbox, 'fixed'), ['music', 'wallpaper']);
  assert.deepEqual(idsOf(sandbox, 'free'), ['fonts', 'particles', 'pointer', 'sound']);
});

test('every slot can be unfixed, including by default the two that are', async () => {
  const { sandbox } = await mountPlugin();
  const panel = await openScene(sandbox);
  dockRow(panel, 'music').querySelector('.cy-dockrow-toggle').click();
  dockRow(panel, 'wallpaper').querySelector('.cy-dockrow-toggle').click();
  assert.deepEqual(idsOf(sandbox, 'fixed'), [], 'a group with nothing in it is allowed');
  assert.equal(idsOf(sandbox, 'free').length, 6, 'and no slot may be lost on the way');
  // With no fixed slots at all there is no boundary left to draw.
  assert.equal(bar(sandbox).querySelector('[data-divider="true"]').dataset.hidden, 'true');
});

test('the arrow buttons move a movable slot and are disabled on a fixed one', async () => {
  const { sandbox } = await mountPlugin();
  const panel = await openScene(sandbox);

  assert.equal(dockRow(panel, 'music').querySelector('[data-dock-move="up"]').disabled, true, 'a fixed slot does not move');
  assert.equal(dockRow(panel, 'music').querySelector('[data-dock-move="down"]').disabled, true);
  assert.equal(dockRow(panel, 'sound').querySelector('[data-dock-move="up"]').disabled, true, 'nothing left of the first');
  assert.equal(dockRow(panel, 'pointer').querySelector('[data-dock-move="down"]').disabled, true, 'nothing right of the last');

  dockRow(panel, 'fonts').querySelector('[data-dock-move="up"]').click();
  assert.deepEqual(idsOf(sandbox, 'free'), ['fonts', 'sound', 'particles', 'pointer']);
  // The rows are renumbered in place, so the list the reader is looking at is
  // the list they just changed.
  assert.equal(dockRow(panel, 'fonts').querySelector('[data-dock-state]').textContent, '1/4');
  assert.equal(dockRow(panel, 'sound').querySelector('[data-dock-state]').textContent, '2/4');
});

test('a reorder in the bar updates the open panel', async () => {
  const { sandbox } = await mountPlugin();
  const panel = await openScene(sandbox);
  drag(button(sandbox, 'sound'), 30);
  assert.deepEqual(idsOf(sandbox, 'free'), ['fonts', 'sound', 'particles', 'pointer']);
  // The panel and the bar are two views of one setting. A panel that kept
  // showing the old order would be quietly lying about the thing it controls.
  assert.equal(dockRow(panel, 'fonts').querySelector('[data-dock-state]').textContent, '1/4');
  assert.equal(dockRow(panel, 'sound').querySelector('[data-dock-state]').textContent, '2/4');
});

test('恢复默认 puts both arrays back', async () => {
  const { sandbox } = await mountPlugin({
    settings: { dockFixed: ['music', 'wallpaper', 'sound'], dockOrder: ['fonts', 'particles', 'pointer'] }
  });
  const panel = await openScene(sandbox);
  const reset = all(panel, '.cy-act').find((node) => node.textContent === '恢复默认');
  assert.notEqual(reset, undefined, 'the panel must carry a reset button');
  reset.click();
  assert.deepEqual(renderOrder(sandbox), ['music', 'wallpaper', 'sound', 'fonts', 'particles', 'pointer']);
  assert.deepEqual(settingsOf(sandbox).dockFixed, ['music', 'wallpaper']);
  assert.deepEqual(settingsOf(sandbox).dockOrder, ['sound', 'fonts', 'particles', 'pointer']);
});

test('a repaired arrangement reaches the panel as well as the bar', async () => {
  // The rows are built from the same resolution the bar renders from, so a
  // document that had to be repaired cannot leave the panel describing the
  // arrangement the user asked for while the bar shows the one they got.
  const { sandbox } = await mountPlugin({
    settings: { dockFixed: ['music'], dockOrder: ['sound', 'fonts'] }
  });
  const panel = await openScene(sandbox);
  const rows = all(panel, '[data-dock-row]').map((node) => node.dataset.dockRow);
  assert.deepEqual(rows, ['sound', 'fonts', 'particles', 'pointer', 'music', 'wallpaper']);
  assert.equal(rows.includes('wallpaper'), true, 'the slot the broken document dropped is listed');
});
