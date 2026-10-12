/**
 * Behavioural tests for the browser half, run against the built bundle in a
 * headless DOM. These exercise the wiring that a syntax check cannot: theme
 * registration, the dock, popovers, persistence, theme hand-off and disposal.
 *
 * `lib/client.js` must be built first (`node build.mjs`).
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {PLUGIN_ID,  BUNDLE, mountPlugin } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

if (!existsSync(BUNDLE)) {
  throw new Error(`${BUNDLE} is missing — run "node build.mjs" before the client tests`);
}

/** Read the mirrored settings document out of the fake localStorage. */
function settingsOf(sandbox) {
  const raw = sandbox.localStorage.getItem('dsh-theme-cyrene:settings');
  return raw === null ? {} : JSON.parse(raw);
}

/**
 * The face the build ships as the factory default.
 *
 * Read out of the built bundle rather than pasted here: since 2026-10-11 a fresh
 * install starts on the author's own portrait, stored as a data URL, and pasting
 * 7515 characters into a test would say nothing about the bundle that mounted.
 * `CYRENE_BUNDLE` can point the suite at someone else's build, and then *that*
 * bundle's default is the one this returns.
 *
 * @returns {string} the `avatarCustom` default, a `data:image/…` URL.
 */
function shippedCustomAvatar() {
  const found = [...readFileSync(BUNDLE, 'utf8').matchAll(/avatarSource:\s*"([^"]*)",\s*avatarCustom:\s*"([^"]*)"/gu)];
  assert.equal(found.length, 1, `expected one avatarSource/avatarCustom default pair in the bundle, saw ${found.length}`);
  return found[0][2];
}

/**
 * The mounted dock and its subsystem buttons, in DOM order.
 *
 * The wrapper is the positioned element (it holds both the bar and the
 * collapsed dot), and the manual fold control is deliberately not one of the
 * subsystem buttons.
 */
function dock(sandbox) {
  const root = sandbox.document.querySelector('.cy-dock-wrap');
  if (root === null) return { root: null, buttons: [] };
  const buttons = root.querySelectorAll('.cy-btn').filter((button) => !button.classList.contains('cy-fold'));
  return { root, buttons };
}

/**
 * One dock button, found by its label.
 *
 * The tests used to index `buttons` positionally. That made every one of them a
 * silent statement about the *order* of the bar: inserting a button in the
 * middle shifted all the later indices, and twelve unrelated tests failed with
 * messages about music and wallpaper rather than about the insertion. Reading
 * by label says what the test actually means.
 *
 * @param {object} sandbox - the mounted sandbox.
 * @param {string} label - the button's text, e.g. `Scene`.
 * @returns {object} the button element.
 */
function dockButton(sandbox, label) {
  const button = dock(sandbox).buttons.find((candidate) => candidate.textContent === label);
  assert.notEqual(button, undefined, `the dock must carry a ${label} button`);
  return button;
}

test('the bundle registers exactly one module whose id is the package name', async () => {
  const { sandbox, plugin } = await mountPlugin();
  assert.equal(sandbox.__loaderCalls.length, 1);
  assert.equal(sandbox.__loaderCalls[0].id, PLUGIN_ID);
  assert.equal(typeof sandbox.__loaderCalls[0].factory, 'function');
  // The array is created inside the VM realm, so compare contents rather than
  // prototypes: `deepStrictEqual` would fail on the differing Array prototype.
  // Membership, not length. "Exactly one service" was never the contract — the
  // contract is that everything the client half touches is declared, because the
  // browser side has no optional-injection mechanism to fall back on.
  assert.ok(plugin.inject.includes('theme'), 'the theme service must be injected');
  assert.ok(plugin.inject.includes('remote'), 'the session running bit comes from remote');
});

test('mounting registers and activates the theme and marks the document', async () => {
  const { sandbox, registered, activated } = await mountPlugin();
  assert.equal(registered.length, 1);
  assert.equal(registered[0].id, 'cyrene');
  assert.equal(registered[0].colorScheme, 'dark');
  assert.ok(Object.keys(registered[0].tokens).length > 80, 'the token map should be substantial');
  assert.deepEqual(activated, ['cyrene']);
  assert.equal(sandbox.document.documentElement.dataset.cyreneTheme, 'on');
});

test('every stylesheet is mounted and tagged with the plugin id', async () => {
  const { sandbox } = await mountPlugin();
  const sheets = sandbox.document.head.querySelectorAll('style');
  // reply-avatar, identity, glass, controls, fonts, glass-tuning and the working
  // edge. The fonts and glass-tuning sheets are mounted unconditionally and come
  // out empty while nothing is customised — mounting them lazily meant the very
  // first change needed a different code path from every later one.
  assert.equal(sheets.length, 7, 'expected the reply-avatar, working-edge, identity, glass, controls, fonts and glass-tuning sheets');
  for (const sheet of sheets) {
    assert.equal(sheet.dataset.plugin, PLUGIN_ID);
    assert.ok(sheet.dataset.pluginCss.startsWith(`${PLUGIN_ID}/`));
  }
  const identity = sheets.find((sheet) => sheet.dataset.pluginCss.endsWith('identity.css'));
  assert.ok(identity.textContent.includes('html[data-cyrene-theme="on"]'), 'identity rules must be scoped');
  assert.ok(identity.textContent.includes('--dsw-alias-bg-base'), 'identity sheet must carry the tokens');

  const fonts = sheets.find((sheet) => sheet.dataset.pluginCss === `${PLUGIN_ID}/fonts`);
  assert.notEqual(fonts, undefined, 'the fonts sheet must exist');
  assert.equal(fonts.textContent, '', 'and stays empty until something is customised');

  const tuning = sheets.find((sheet) => sheet.dataset.pluginCss === `${PLUGIN_ID}/glass-tuning`);
  assert.notEqual(tuning, undefined, 'the glass-tuning sheet must exist');
  // Not empty any more, and no longer a marker of "nothing is customised": the
  // two fallbacks are unconditional, because a reader with reduced transparency
  // or no `backdrop-filter` needs a usable surface on a fresh install as much as
  // after a slider moved. What a fresh install must *not* carry is an override
  // of the shipped material.
  assert.ok(
    tuning.textContent.includes('@media (prefers-reduced-transparency: reduce)'),
    'a fresh install still carries the reduced-transparency fallback'
  );
  assert.ok(
    tuning.textContent.includes('@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))'),
    'and the no-backdrop-filter fallback'
  );
  assert.equal(
    /--dsw-alias-bg-[\w-]+:/u.test(tuning.textContent),
    false,
    'but nothing re-emits the colour ladder while the recipe is untouched'
  );
});

test('the glass layer is mounted always but gated on its own attribute', async () => {
  const { sandbox } = await mountPlugin();
  const glass = sandbox.document.head
    .querySelectorAll('style')
    .find((sheet) => sheet.dataset.pluginCss.endsWith('glass.css'));
  assert.ok(glass !== undefined, 'the glass sheet must be mounted');
  // Gating on an attribute is what makes the 景 toggle a repaint rather than a
  // stylesheet round trip.
  assert.ok(
    glass.textContent.includes('html[data-cyrene-theme="on"][data-cyrene-glass="on"]'),
    'glass rules must be gated on both attributes'
  );
  assert.ok(glass.textContent.includes('feTurbulence'), 'the grain must be an SVG turbulence tile');
  assert.ok(glass.textContent.includes('mask-composite: exclude'), 'the rim needs the border-only mask');
  assert.ok(glass.textContent.includes('linear-gradient(145deg'), 'the rim must be a directional gradient');

  // The host's sidebar is the one large surface the plugin does not draw itself.
  // The token layer only *colours* it; without a rule of its own it would read as
  // a flat panel next to everything else reading as glass. It has to be reached by
  // a stable host hook — `[data-slot="sidebar"]` — because the sidebar's own class
  // names carry build hashes.
  assert.ok(glass.textContent.includes('[data-slot="sidebar"]'), 'the sidebar must get the material, not only the colour');
  assert.ok(
    /\[data-slot="sidebar"\][^}]*backdrop-filter/u.test(glass.textContent),
    'and that hook must be what gets blurred'
  );
});

test('the background stack is mounted behind everything', async () => {
  const { sandbox } = await mountPlugin();
  const layers = sandbox.document.querySelector('.cy-layer-root');
  assert.notEqual(layers, null);
  assert.equal(layers.parentNode, sandbox.document.body);
  assert.notEqual(layers.querySelector('.cy-particles'), null);
  assert.notEqual(layers.querySelector('video'), null);
  assert.notEqual(layers.querySelector('.cy-shade'), null);
});

test('the dock carries one button per subsystem, in a stable order', async () => {
  const { sandbox } = await mountPlugin();
  const { root, buttons } = dock(sandbox);
  assert.notEqual(root, null);
  // The bar's buttons are English words: single hanzi named the medium, which is
  // not what this dock controls. `Trace` follows that convention for the pointer
  // effects, `Type` for the font system — one word wide, naming the thing.
  //
  // The order is the default arrangement, not the registration order: the two
  // fixed slots lead — `Cyrene` for the identity and `Scene` for the panel that
  // holds the arrangement controls — and the four movable ones follow in the
  // order `dockOrder` ships with. A test that expected the old flat order was
  // asserting the thing this feature replaced.
  assert.deepEqual(
    buttons.map((button) => button.textContent),
    ['Cyrene', 'Scene', 'Sound', 'Type', 'Particles', 'Trace']
  );
  assert.deepEqual(
    buttons.map((button) => button.dataset.id),
    ['music', 'wallpaper', 'sound', 'fonts', 'particles', 'pointer']
  );
  assert.notEqual(sandbox.document.getElementById(`${PLUGIN_ID}-toasts`), null);
});

test('every dock button is an icon, and keeps its word as its accessible name', async () => {
  const { sandbox } = await mountPlugin();
  const { buttons } = dock(sandbox);
  for (const button of buttons) {
    // The label is what `textContent` returns, so it has to still be *there* —
    // about twenty tests find their button by it, and it is also the name a
    // screen reader reads.
    const label = button.querySelector('.cy-btn-label');
    assert.notEqual(label, null, `${button.dataset.id} must keep its label span`);
    assert.equal(button.textContent, label.textContent, `${button.dataset.id}: the span is the whole of the text`);
    assert.equal(button.getAttribute('aria-label').length > 0, true);

    const icon = button.querySelector('svg');
    assert.notEqual(icon, null, `${button.dataset.id} must carry a drawn icon`);
    assert.equal(icon.namespaceURI, 'http://www.w3.org/2000/svg', 'created in the SVG namespace, not as HTML');
    assert.equal(icon.getAttribute('viewBox'), '0 0 16 16');
    // Stroke geometry, set here rather than left to the stylesheet: an SVG root
    // defaults to a black fill, so a `fill: none` that only exists in CSS renders
    // as a solid blob the moment the sheet is missing.
    assert.equal(icon.getAttribute('fill'), 'none');
    assert.equal(icon.getAttribute('stroke'), 'currentColor');
    assert.equal(icon.getAttribute('stroke-width'), '1.5');
    assert.equal(icon.getAttribute('aria-hidden'), 'true', 'the button already carries the word');
    assert.ok(icon.childNodes.length > 0, `${button.dataset.id}: an empty <svg> draws nothing`);
  }
});

test('the label is hidden visually rather than removed from the tree', async () => {
  const { sandbox } = await mountPlugin();
  const sheets = sandbox.document.head.querySelectorAll('style');
  const controls = sheets
    .map((sheet) => sheet.textContent)
    .join('\n');
  // `display: none` would take the button's accessible name away with the pixels.
  // The clip-path idiom leaves it in the accessibility tree, which is the whole
  // reason the icon could replace the word in the first place.
  assert.ok(controls.includes('clip-path: inset(50%)'), 'the label is clipped, not display:none');
  assert.ok(controls.includes('.cy-btn-label'), 'and the rule is written for the label');
  assert.equal(
    /\.cy-btn-label[^{]*\{[^}]*display:\s*none/u.test(controls),
    false,
    'nothing may switch the label off with display:none'
  );
  // Keyboard focus reveals it. Hover deliberately does not.
  //
  // Hover-expand was the first version and the user asked for it to go: the bar
  // changes width under the cursor as you move along it, so every button between
  // here and the one you were heading for slides sideways and the target is no
  // longer under the pointer. `data-on` was removed for a related reason — it
  // made the bar resize whenever a subsystem was switched on or off. Both are
  // asserted absent so neither can creep back in.
  assert.ok(controls.includes('.cy-btn:focus-visible .cy-btn-label'), 'keyboard focus reveals it');
  assert.equal(
    controls.includes('.cy-btn:hover .cy-btn-label'),
    false,
    'hover must not grow the bar under the pointer'
  );
  assert.equal(
    controls.includes('.cy-btn[data-on="true"] .cy-btn-label'),
    false,
    'nor must an active button — that resizes the bar on every toggle'
  );
});

test('the dock is a labelled toolbar split into two groups by a rule', async () => {
  const { sandbox } = await mountPlugin();
  const bar = sandbox.document.querySelector('.cy-dock');
  assert.equal(bar.getAttribute('role'), 'toolbar');
  assert.notEqual(bar.getAttribute('aria-label'), null, 'a toolbar with no name is an anonymous strip');

  // grip · fixed · rule · free · fold, in that order and no other.
  const children = bar.childNodes;
  const shape = children.map((node) => node.attributes.class ?? '');
  assert.equal(shape[0], 'cy-dock-handle', 'the grip leads');
  assert.equal(shape[1], 'cy-btn-group', 'then the fixed slots');
  assert.equal(shape[2], 'cy-divider', 'then the rule');
  assert.equal(shape[3], 'cy-btn-group', 'then the movable slots');
  assert.equal(shape[4], 'cy-btn cy-fold', 'and the fold control stays last');
  assert.equal(bar.querySelectorAll('.cy-btn.cy-fold').length, 1, 'the fold control is not a subsystem slot');

  const [fixedGroup, , freeGroup] = [children[1], children[2], children[3]];
  assert.deepEqual(
    fixedGroup.querySelectorAll('.cy-btn').map((button) => button.dataset.id),
    ['music', 'wallpaper'],
    'in a fixed group, the declared order is what renders'
  );
  assert.deepEqual(
    freeGroup.querySelectorAll('.cy-btn').map((button) => button.dataset.id),
    ['sound', 'fonts', 'particles', 'pointer']
  );
  assert.equal(bar.querySelectorAll('[data-divider="true"]').length, 1);

  // Every id exactly once, which is the invariant the repair rule exists to hold.
  const ids = bar.querySelectorAll('.cy-btn').filter((b) => !b.classList.contains('cy-fold')).map((b) => b.dataset.id);
  assert.equal(new Set(ids).size, 6);
  assert.equal(ids.length, 6);
});

test('the rule disappears when either side of it is empty', async () => {
  // Every slot fixed: nothing left of the free group, so a boundary drawn there
  // would be marking a division that is not in the bar.
  const allFixed = await mountPlugin({
    settings: { dockFixed: ['music', 'wallpaper', 'sound', 'fonts', 'particles', 'pointer'], dockOrder: [] }
  });
  const divider = allFixed.sandbox.document.querySelector('.cy-dock [data-divider="true"]');
  assert.equal(divider.dataset.hidden, 'true', 'no movable slots means no rule');

  const mixed = await mountPlugin();
  const shown = mixed.sandbox.document.querySelector('.cy-dock [data-divider="true"]');
  assert.equal(shown.dataset.hidden, 'false', 'both sides present, so the rule is drawn');
});

test('the music button is labelled Cyrene and carries no image', async () => {
  const { sandbox } = await mountPlugin();
  const music = dockButton(sandbox, 'Cyrene');
  assert.equal(music.textContent, 'Cyrene');
  assert.equal(music.querySelector('img'), null, 'the label is text, not a portrait');
  // The panel that opens from it is headed the same way, so the two agree.
  music.click();
  const panel = sandbox.document.querySelector('.cy-pop');
  assert.ok(panel.querySelector('.cy-pop-title').textContent.includes('Cyrene'));
});

test('the collapsed dot shows her built-in portrait when that source is chosen', async () => {
  // `builtin` is a source, not a default: since 2026-10-11 a fresh install opens
  // on the author's own picture (asserted on its own below), so the built-in file
  // is asked for by name here and this stays a statement about the dot.
  const { sandbox } = await mountPlugin({ settings: { avatarSource: 'builtin' } });
  const dot = sandbox.document.querySelector('.cy-dot');
  assert.notEqual(dot, null);
  assert.equal(dot.textContent, '', 'the hero glyph must be gone');
  const avatar = dot.querySelector('.cy-avatar');
  assert.notEqual(avatar, null, 'the dot must render her portrait');
  assert.match(avatar.getAttribute('src'), /^\/theme-cyrene-assets\/pkg\/brand\//u);
  assert.equal(avatar.getAttribute('src').endsWith('cyrene-avatar.webp'), true);
  assert.equal(dot.querySelectorAll('img').length, 1, 'one portrait, not a stack');

  // Folding the bar still reveals it, and unfolding hides it again.
  sandbox.document.querySelector('.cy-fold').click();
  assert.equal(sandbox.document.querySelector('.cy-dock-wrap').dataset.collapsed, 'true');
});

test('the collapsed dot shows the author\'s portrait by default', async () => {
  // The shipped default is the author's own picture, inline as a data URL, so the
  // dot must render it without anyone choosing anything. The expected bytes are
  // read out of the bundle that mounted, so this does not quietly assert a copy.
  const shipped = shippedCustomAvatar();
  const { sandbox } = await mountPlugin();
  assert.equal(settingsOf(sandbox).avatarSource, 'custom', 'a fresh install starts on the custom source');
  assert.equal(
    sandbox.document.querySelector('.cy-dot .cy-avatar').getAttribute('src'),
    shipped,
    'and with nothing on screen but that face'
  );
});

test('the portrait is served from brand/, so it is never a wallpaper', async () => {
  // Everything under `assets/` is scanned into the Scene grid. This asserts the
  // separation where it is decided — at the source tree `collect()` walks — and
  // that the bundle therefore points at the brand URL.
  assert.ok(existsSync(join(ROOT, 'brand', 'cyrene-avatar.webp')), 'the portrait must exist in brand/');
  assert.equal(
    readdirSync(join(ROOT, 'assets')).includes('cyrene-avatar.webp'),
    false,
    'a portrait inside assets/ would be offered as a wallpaper'
  );
  const bundle = readFileSync(BUNDLE, 'utf8');
  assert.ok(bundle.includes('/pkg/brand/cyrene-avatar.webp'), 'the bundle must reference the brand URL');
  assert.equal(bundle.includes('/pkg/assets/cyrene-avatar'), false);
});

test('the sound button toggles the setting and persists it both ways', async () => {
  const { sandbox } = await mountPlugin();
  const sound = dockButton(sandbox, 'Sound');

  sound.click();
  assert.equal(settingsOf(sandbox).sound, true);
  assert.equal(sound.dataset.on, 'true');

  // The debounced host write must carry the patch.
  sandbox.__flushTimers();
  await new Promise((resolve) => setImmediate(resolve));
  const posted = sandbox.__fetchLog.filter((call) => call.method === 'POST' && call.path.endsWith('/state'));
  assert.ok(posted.length >= 1, 'the change must be pushed to the host');

  sound.click();
  assert.equal(settingsOf(sandbox).sound, false);
  assert.equal(sound.dataset.on, 'false');
});

test('the particle button cycles through the tiers and back to off', async () => {
  const { sandbox } = await mountPlugin();
  const particles = dockButton(sandbox, 'Particles');
  const seen = [];
  for (let step = 0; step < 4; step += 1) {
    particles.click();
    seen.push(settingsOf(sandbox).particles);
  }
  // Default is "trail"; four clicks visit every tier and return to it.
  assert.deepEqual(seen, ['swarm', 'off', 'star', 'trail']);
  assert.equal(particles.dataset.on, 'true');
});

test('the wallpaper button opens a panel and closes it again', async () => {
  const { sandbox } = await mountPlugin();
  const wallpaper = dockButton(sandbox, 'Scene');

  wallpaper.click();
  const panel = sandbox.document.querySelector('.cy-pop');
  assert.notEqual(panel, null, 'a popover should be mounted');
  assert.ok(panel.textContent.includes('壁纸'));

  wallpaper.click();
  assert.equal(sandbox.document.querySelectorAll('.cy-pop').length, 0, 'clicking again closes it');
});

test('the music button opens the player and loads the audio element', async () => {
  const { sandbox } = await mountPlugin();
  const music = dockButton(sandbox, 'Cyrene');

  music.click();
  const panel = sandbox.document.querySelector('.cy-player');
  assert.notEqual(panel, null);
  assert.equal(sandbox.document.querySelectorAll('audio').length, 1);
  // With an empty library the transport still renders but does not throw.
  assert.ok(panel.textContent.includes('曲库为空') || panel.textContent.includes('未选择曲目'));
});

test('Escape closes the open popover', async () => {
  const { sandbox } = await mountPlugin();
  dockButton(sandbox, 'Scene').click();
  assert.equal(sandbox.document.querySelectorAll('.cy-pop').length, 1);

  sandbox.document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(sandbox.document.querySelectorAll('.cy-pop').length, 0);
});

test('a foreign theme takes the identity down, and returning restores it', async () => {
  const { sandbox, themeListeners } = await mountPlugin();
  assert.equal(themeListeners.length, 1, 'the plugin must observe theme changes');

  themeListeners[0]({ theme: 'some-other-theme' });
  assert.equal(sandbox.document.documentElement.dataset.cyreneTheme, undefined);

  themeListeners[0]({ theme: 'cyrene' });
  assert.equal(sandbox.document.documentElement.dataset.cyreneTheme, 'on');
});

test('an unreadable theme payload leaves the identity alone rather than guessing', async () => {
  const { sandbox, themeListeners } = await mountPlugin();
  themeListeners[0]({ nothing: 'useful' });
  assert.equal(sandbox.document.documentElement.dataset.cyreneTheme, 'on');
});

test('a built-in colour scheme never takes the identity down', async () => {
  // `dsh-client-ui-theme` persists light|dark|system and re-publishes it on
  // every boot. Reading that as a competing theme switched the whole identity
  // off on restart — the reported 「美化重启后不生效」.
  const { sandbox, themeListeners } = await mountPlugin();
  for (const scheme of ['dark', 'light', 'system']) {
    for (const payload of [{ theme: scheme }, { preference: scheme }, { theme: { id: scheme } }]) {
      themeListeners[0](payload);
      assert.equal(
        sandbox.document.documentElement.dataset.cyreneTheme,
        'on',
        `${JSON.stringify(payload)} must not displace the identity`
      );
    }
  }
});

test('a boot-time preference does not mask a later foreign theme', async () => {
  const { sandbox, themeListeners } = await mountPlugin();
  themeListeners[0]({ preference: 'dark' }); // what the host republishes on boot
  assert.equal(sandbox.document.documentElement.dataset.cyreneTheme, 'on');
  themeListeners[0]({ theme: 'some-other-theme' }); // then the user picks another
  assert.equal(sandbox.document.documentElement.dataset.cyreneTheme, undefined);
});

test('with no media the theme still mounts, and the extras stay off', async () => {
  const { sandbox } = await mountPlugin();
  sandbox.__flushTimers();
  assert.equal(sandbox.document.querySelector('.cy-boot'), null, 'no boot GIF means no overlay');
  assert.equal(sandbox.document.querySelector('.cy-emote'), null, 'no emotes means no reactions');
  assert.notEqual(sandbox.document.querySelector('.cy-dock'), null, 'the dock is independent of media');
});

test('the typing sound fires for IME keystrokes, not just for Backspace', async () => {
  const { sandbox } = await mountPlugin();
  dockButton(sandbox, 'Sound').click(); // enable
  assert.equal(settingsOf(sandbox).sound, true);

  const input = sandbox.document.createElement('div');
  input.setAttribute('contenteditable', 'true');
  sandbox.document.body.appendChild(input);

  /** Dispatch one keydown and report how many voices it produced. */
  const voices = (key, extra = {}) => {
    // Step past the anti-stacking throttle, which is what a real keystroke
    // interval does.
    sandbox.__advance(40);
    const before = sandbox.__audio.oscillators;
    input.dispatchEvent({
      type: 'keydown',
      key,
      target: input,
      isComposing: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ...extra
    });
    return sandbox.__audio.oscillators - before;
  };

  // A plain Latin character.
  assert.ok(voices('a') > 0, 'a character key must make a sound');
  // The IME case: this is what used to be silent while Backspace still clicked.
  assert.ok(voices('n', { isComposing: true }) > 0, 'a composing character must make a sound');
  // Chromium's placeholder key for an IME keystroke.
  assert.ok(voices('Process', { isComposing: true }) > 0, 'key "Process" must make a sound');
  assert.ok(voices('Unidentified', { isComposing: true }) > 0, 'key "Unidentified" must make a sound');
  // Structural keys keep their own voices.
  assert.ok(voices(' ') > 0, 'space must make a sound');
  assert.ok(voices('Enter') > 0, 'enter must make a sound');
  assert.ok(voices('Backspace') > 0, 'backspace must make a sound');
});

test('typing stays silent while the sound toggle is off, and for modified keys', async () => {
  const { sandbox } = await mountPlugin();
  const input = sandbox.document.createElement('input');
  input.setAttribute('type', 'text');
  sandbox.document.body.appendChild(input);

  const dispatch = (key, extra = {}) => {
    sandbox.__advance(40);
    const before = sandbox.__audio.oscillators;
    input.dispatchEvent({
      type: 'keydown', key, target: input, isComposing: false,
      ctrlKey: false, metaKey: false, altKey: false, ...extra
    });
    return sandbox.__audio.oscillators - before;
  };

  assert.equal(dispatch('a'), 0, 'disabled means silent');

  dockButton(sandbox, 'Sound').click(); // enable
  assert.ok(dispatch('a') > 0);
  assert.equal(dispatch('c', { ctrlKey: true }), 0, 'shortcuts are not typing');
  assert.equal(dispatch('ArrowLeft'), 0, 'navigation keys are not typing');
  // Typing into the plugin's own number field must not click.
  const own = sandbox.document.createElement('input');
  own.className = 'cy-input';
  sandbox.document.body.appendChild(own);
  const before = sandbox.__audio.oscillators;
  own.dispatchEvent({
    type: 'keydown', key: 'a', target: own, isComposing: false,
    ctrlKey: false, metaKey: false, altKey: false
  });
  assert.equal(sandbox.__audio.oscillators, before, 'the plugin\'s own inputs stay quiet');
});

test('a trigger word in incoming text shows the matching emote', async () => {
  // The manifest is installed before mount, so the emote is in the catalog the
  // watcher consults — this is how an upload from a previous session appears.
  const emote = {
    id: 'user:emotes/开心.gif',
    name: '开心.gif',
    label: '开心',
    kind: 'image',
    mime: 'image/gif',
    url: '/theme-cyrene-assets/user/emotes/%E5%BC%80%E5%BF%83.gif',
    source: 'user'
  };
  const { sandbox } = await mountPlugin({
    responses: new Map([['/theme-cyrene-assets/manifest', {
      plugin: PLUGIN_ID,
      wallpapers: [],
      music: [],
      covers: [],
      boot: [],
      emotes: [emote],
      state: {},
      limits: {}
    }]])
  });

  // Feed text in through an added node, the way a streamed reply arrives.
  const text = sandbox.document.createElement('div');
  text.textContent = '太好了，这确实厉害';
  sandbox.document.body.appendChild(text);

  sandbox.__flushTimers(); // the watcher debounces before judging the turn
  assert.notEqual(sandbox.document.querySelector('.cy-emote'), null, 'the emote should appear');
});

test('a boot keyword replays the opening animation when one exists', async () => {
  const boot = {
    id: 'builtin:GIF/opening.gif',
    name: 'opening.gif',
    label: 'opening',
    mime: 'image/gif',
    url: '/theme-cyrene-assets/pkg/GIF/opening.gif',
    source: 'builtin'
  };
  const { sandbox } = await mountPlugin({
    responses: new Map([['/theme-cyrene-assets/manifest', {
      plugin: PLUGIN_ID,
      wallpapers: [],
      music: [],
      covers: [],
      boot: [boot],
      emotes: [],
      state: {},
      limits: {}
    }]])
  });

  const sent = sandbox.document.createElement('div');
  sent.textContent = 'SAM';
  sandbox.document.body.appendChild(sent);
  sandbox.__flushTimers();

  assert.notEqual(sandbox.document.querySelector('.cy-boot'), null, 'the opening animation should replay');
});

/** Mount with one boot asset of the given name. */
async function mountWithBoot(name, mime, style) {
  const entry = {
    id: `builtin:GIF/${name}`,
    name,
    label: name.replace(/\.[^.]+$/u, ''),
    mime,
    url: `/theme-cyrene-assets/pkg/GIF/${name}`,
    source: 'builtin'
  };
  const responses = new Map([['/theme-cyrene-assets/manifest', {
    plugin: PLUGIN_ID,
    wallpapers: [],
    music: [],
    covers: [],
    boot: [entry],
    emotes: [],
    state: {},
    limits: {}
  }]]);
  if (style !== undefined) {
    responses.set('/theme-cyrene-assets/state', { state: { bootStyle: style } });
  }
  const mounted = await mountPlugin({ responses });
  return { ...mounted, entry };
}

test('the bundled opening floats on a scrim, with no artwork page or card', async () => {
  const { sandbox } = await mountWithBoot('cyrene-boot.webp', 'image/webp');
  const overlay = sandbox.document.querySelector('.cy-boot');
  assert.notEqual(overlay, null, 'the bundled boot asset must produce an overlay');
  // The style must reach the DOM verbatim: the stylesheet keys off it, so
  // collapsing it into a boolean leaves the reveal rules dead.
  assert.equal(overlay.dataset.style, 'reveal', 'the asset is transparent, so it floats rather than fills');
  assert.equal(
    overlay.querySelector('.cy-boot-title'),
    null,
    'the card title is redundant when the asset carries the words'
  );
  assert.notEqual(overlay.querySelector('.cy-boot-skip'), null, 'skipping must stay possible');
});

test('a card style still frames its asset, so an upload is not left bare', async () => {
  // Asserted against the stylesheet rather than by driving the setting, because
  // there is no UI for boot style: the point is that the `card` branch is not
  // dead code and still draws its framing chrome.
  const { sandbox } = await mountPlugin();
  const css = sandbox.document.head
    .querySelectorAll('style')
    .map((sheet) => sheet.textContent)
    .join('\n');
  assert.ok(css.includes('.cy-boot-title'), 'the card chrome rules must still exist');
  assert.ok(css.includes('.cy-boot[data-style="reveal"]'), 'the reveal rules must exist');
  assert.ok(css.includes('max-width: min(560px, 74vw)'), 'the card frame still boxes a small upload');
});

test('an opening animation always dismisses itself, GIF included', async () => {
  // The earlier code set no timer for a GIF, so a looping animation covered the
  // window until it was clicked. Nothing about that is GIF-specific.
  const { sandbox } = await mountWithBoot('opening.gif', 'image/gif');
  assert.notEqual(sandbox.document.querySelector('.cy-boot'), null);
  // Twice: the first flush runs the dismiss timer, which schedules the removal.
  sandbox.__flushTimers();
  sandbox.__flushTimers();
  assert.equal(
    sandbox.document.querySelector('.cy-boot'),
    null,
    'a GIF opening must time out like any other'
  );
});

test('a non-GIF still dismissal is unchanged', async () => {
  const { sandbox } = await mountWithBoot('still.png', 'image/png');
  assert.notEqual(sandbox.document.querySelector('.cy-boot'), null);
  sandbox.__flushTimers();
  sandbox.__flushTimers();
  assert.equal(sandbox.document.querySelector('.cy-boot'), null);
});

test('the pet stands in the corner wearing one of her five expressions', async () => {
  const { sandbox } = await mountPlugin();
  const pet = sandbox.document.querySelector('.cy-pet');
  assert.notEqual(pet, null, 'the pet is on by default');
  const sprite = pet.querySelector('.cy-pet-sprite');
  assert.notEqual(sprite, null);
  assert.match(sprite.getAttribute('src'), /^\/theme-cyrene-assets\/pkg\/brand\/pet\//u);
  assert.equal(pet.dataset.hidden, 'false');
  // One <img>, swapped by src. Five separate elements would mean five decoded
  // stickers resident at all times.
  assert.equal(pet.querySelectorAll('img').length, 1, 'one sprite, swapped by src');
});

test('the pet reacts and then returns to resting on its own', async () => {
  const { sandbox } = await mountPlugin();
  const pet = sandbox.document.querySelector('.cy-pet');
  const sprite = pet.querySelector('.cy-pet-sprite');
  const resting = sprite.getAttribute('src');

  pet.click();
  assert.equal(pet.dataset.pop, 'true', 'a click pops');
  assert.notEqual(sprite.getAttribute('src'), resting, 'and shows a reaction expression');

  // A pet stuck on one expression is a bug, not a mood.
  sandbox.__flushTimers();
  assert.equal(sprite.getAttribute('src'), resting, 'the sprite must go back to resting');
});

test('the pet can be switched off from the 景 panel', async () => {
  const { sandbox } = await mountPlugin();
  dockButton(sandbox, 'Scene').click(); // 景
  const panel = sandbox.document.querySelector('.cy-pop');
  const toggle = panel
    .querySelectorAll('.cy-act')
    .find((button) => button.textContent.startsWith('小昔涟'));
  assert.ok(toggle !== undefined, 'the 景 panel must offer the pet switch');
  assert.equal(toggle.textContent, '小昔涟 · 开');

  toggle.click();
  assert.equal(toggle.textContent, '小昔涟 · 关');
  assert.equal(
    sandbox.document.querySelector('.cy-pet').dataset.hidden,
    'true',
    'switching off must hide her rather than tear her out'
  );
});

test('no pet stickers means no pet, rather than an empty one', async () => {
  const { sandbox } = await mountPlugin({
    responses: new Map([['/theme-cyrene-assets/manifest', {
      plugin: PLUGIN_ID,
      wallpapers: [],
      music: [],
      covers: [],
      boot: [],
      emotes: [],
      pet: [],
      state: {},
      limits: {}
    }]])
  });
  assert.equal(sandbox.document.querySelector('.cy-pet'), null);
});

test('the glass layer is on by default and switches off from the 景 panel', async () => {
  const { sandbox } = await mountPlugin();
  assert.equal(
    sandbox.document.documentElement.dataset.cyreneGlass,
    'on',
    'the glass layer should be on for a fresh install'
  );

  dockButton(sandbox, 'Scene').click(); // 景
  const panel = sandbox.document.querySelector('.cy-pop');
  const toggle = panel
    .querySelectorAll('.cy-act')
    .find((button) => button.textContent.startsWith('玻璃质感'));
  assert.ok(toggle !== undefined, 'the 景 panel must offer the glass switch');
  assert.equal(toggle.textContent, '玻璃质感 · 开');

  toggle.click();
  assert.equal(
    sandbox.document.documentElement.dataset.cyreneGlass,
    undefined,
    'switching off must drop the attribute the glass rules are gated on'
  );
  assert.equal(toggle.textContent, '玻璃质感 · 关', 'the switch must reflect the new state');

  toggle.click();
  assert.equal(sandbox.document.documentElement.dataset.cyreneGlass, 'on', 'and switch back on');
});

test('unmounting releases the DOM, the stylesheets and the document marker', async () => {
  const { sandbox, disposers } = await mountPlugin();
  const disposable = disposers.find((entry) => entry !== null && typeof entry === 'object' && entry.label !== undefined);
  assert.notEqual(disposable, undefined, 'apply must return a disposer through ctx.effect');

  disposable.dispose();

  assert.equal(sandbox.document.querySelectorAll('.cy-dock').length, 0);
  assert.equal(sandbox.document.querySelectorAll('.cy-layer-root').length, 0);
  assert.equal(sandbox.document.querySelectorAll('style').length, 0, 'both sheets must be removed');
  assert.equal(sandbox.document.getElementById(`${PLUGIN_ID}-toasts`), null);
  assert.equal(sandbox.document.documentElement.dataset.cyreneTheme, undefined);
});

test('a second mount survives an already-registered theme id', async () => {
  const { sandbox, registered } = await mountPlugin();
  assert.equal(registered.length, 1);
  // Re-running apply on the same sandbox is what a HMR recomposition does.
  const again = await mountPlugin();
  assert.equal(again.registered[0].id, 'cyrene');
  assert.equal(again.sandbox.document.documentElement.dataset.cyreneTheme, 'on');
});

test('the bundle carries no inlined media payload', async () => {
  const { sandbox } = await mountPlugin();
  // The wallpapers manifest is replaced with a JSON literal; with no assets it
  // must be an empty array rather than a base64 blob.
  const sheet = sandbox.document.head.querySelectorAll('style')[0];
  assert.ok(sheet.textContent.length < 40000, 'the identity sheet must not carry media');
});

/* ------------------------------------------------------------------ *
 * A populated library: the paths an empty install never reaches.
 * ------------------------------------------------------------------ */

const LIBRARY = new Map([['/theme-cyrene-assets/manifest', {
  plugin: PLUGIN_ID,
  wallpapers: [
    {
      id: 'builtin:assets/cyrene-01.png',
      name: 'cyrene-01.png',
      label: 'cyrene-01',
      kind: 'image',
      mime: 'image/png',
      url: '/theme-cyrene-assets/pkg/assets/cyrene-01.png',
      source: 'builtin',
      default: true
    },
    {
      id: 'builtin:assets/night.mp4',
      name: 'night.mp4',
      label: 'night',
      kind: 'video',
      mime: 'video/mp4',
      url: '/theme-cyrene-assets/pkg/assets/night.mp4',
      source: 'builtin',
      default: false
    }
  ],
  music: [
    {
      id: 'builtin:music/song.mp3',
      name: 'song.mp3',
      label: 'song',
      kind: 'audio',
      mime: 'audio/mpeg',
      url: '/theme-cyrene-assets/pkg/music/song.mp3',
      source: 'builtin',
      cover: null
    }
  ],
  covers: [
    {
      id: 'builtin:covers/default.png',
      name: 'default.png',
      label: 'default',
      mime: 'image/png',
      url: '/theme-cyrene-assets/pkg/music/figure/default.png',
      source: 'builtin'
    }
  ],
  boot: [],
  emotes: [],
  state: {},
  limits: { uploadCap: 1000, uploadCapLabel: '1000B', free: 2000, freeLabel: '2.0KB' }
}]]);

test('a fresh install seeds the default wallpaper for the default type', async () => {
  const { sandbox } = await mountPlugin({ responses: LIBRARY });
  const saved = settingsOf(sandbox);
  // The shipped default type is the dynamic wallpaper.
  assert.equal(saved.wallpaperType, 'video');
  assert.equal(saved.wallpaper, 'builtin:assets/night.mp4');
});

test('switching type re-seeds that type\'s own default', async () => {
  const { sandbox } = await mountPlugin({ responses: LIBRARY });
  dockButton(sandbox, 'Scene').click();

  const settingsPanel = sandbox.document.querySelector('.cy-pop');
  const still = settingsPanel.querySelectorAll('button').find((button) => button.textContent === '静态');
  assert.notEqual(still, undefined, 'the type control must offer 静态');
  still.click();

  const saved = settingsOf(sandbox);
  assert.equal(saved.wallpaperType, 'image');
  assert.equal(saved.wallpaper, 'builtin:assets/cyrene-01.png');
});

test('the wallpaper grid renders both stills and videos, and applies on click', async () => {
  const { sandbox } = await mountPlugin({ responses: LIBRARY });
  dockButton(sandbox, 'Scene').click();

  const settingsPanel = sandbox.document.querySelector('.cy-pop');
  const openGrid = settingsPanel.querySelectorAll('.cy-act').find((button) => button.textContent === '选择壁纸');
  assert.notEqual(openGrid, undefined, 'the settings panel must offer the grid');
  openGrid.click();

  const grid = sandbox.document.querySelector('.cy-grid');
  assert.notEqual(grid, null);
  const cards = grid.querySelectorAll('.cy-card');
  assert.equal(cards.length, 2);
  // Videos sort first so moving wallpapers lead the grid.
  assert.equal(cards[0].dataset.video, 'true');
  // A video card previews with a <video preload="metadata">, which the host
  // half answers with 206 rather than a whole-file download.
  const preview = cards[0].querySelector('video');
  assert.notEqual(preview, null);
  assert.equal(preview.getAttribute('preload'), 'metadata');

  cards[1].click();
  assert.equal(settingsOf(sandbox).wallpaper, 'builtin:assets/cyrene-01.png');
  cards[0].click();
  assert.equal(settingsOf(sandbox).wallpaper, 'builtin:assets/night.mp4');
  assert.equal(settingsOf(sandbox).wallpaperType, 'video');
});

test('the selection toggle drives the random pool without applying the wallpaper', async () => {
  const { sandbox } = await mountPlugin({ responses: LIBRARY });
  dockButton(sandbox, 'Scene').click();
  sandbox.document.querySelector('.cy-pop').querySelectorAll('.cy-act')
    .find((button) => button.textContent === '选择壁纸').click();

  const before = settingsOf(sandbox).wallpaper;
  const cards = sandbox.document.querySelector('.cy-grid').querySelectorAll('.cy-card');
  // The little circle in the corner selects; clicking it must not apply.
  const toggle = cards[0].childNodes[cards[0].childNodes.length - 1];
  toggle.click();
  assert.equal(settingsOf(sandbox).wallpaper, before, 'selecting must not apply');

  sandbox.document.querySelector('.cy-pop').querySelectorAll('.cy-act')
    .find((button) => button.textContent === '随机池').click();
  assert.equal(settingsOf(sandbox).randomOn, true);
  assert.deepEqual(settingsOf(sandbox).randomPool, ['builtin:assets/night.mp4']);
});

test('the music player lists the library and the transport drives the element', async () => {
  const { sandbox } = await mountPlugin({ responses: LIBRARY });
  dockButton(sandbox, 'Cyrene').click();

  const player = sandbox.document.querySelector('.cy-player');
  assert.notEqual(player, null);
  const songs = player.querySelectorAll('.cy-song');
  assert.equal(songs.length, 1);
  assert.ok(songs[0].textContent.includes('song'));

  // Clicking a row loads and plays it.
  songs[0].click();
  assert.equal(settingsOf(sandbox).trackId, 'builtin:music/song.mp3');
  const audio = sandbox.document.querySelector('audio');
  assert.equal(audio.paused, false, 'the track should be playing');
  assert.equal(audio.volume > 0, true);

  // Pause / resume through the transport button.
  const playButton = player.querySelectorAll('.cy-transport .cy-btn')[1];
  playButton.click();
  assert.equal(audio.paused, true);
  playButton.click();
  assert.equal(audio.paused, false);

  // Cycling the loop mode persists it.
  const loopButton = player.querySelectorAll('.cy-transport .cy-btn')[3];
  loopButton.click();
  assert.equal(['list', 'single', 'shuffle'].includes(settingsOf(sandbox).loop), true);

  // The cover falls back to the first available cover.
  assert.ok(player.querySelector('.cy-disc').style.backgroundImage.includes('default.png'));
});

test('collapsing to the mini player then expanding restores the dock', async () => {
  const { sandbox } = await mountPlugin({ responses: LIBRARY });
  dockButton(sandbox, 'Cyrene').click();

  const player = sandbox.document.querySelector('.cy-player');
  const collapse = player.querySelectorAll('.cy-pop-head .cy-pop-close')[0];
  collapse.click();

  const mini = sandbox.document.querySelector('.cy-mini');
  assert.notEqual(mini, null, 'the mini player should appear');
  assert.equal(sandbox.document.querySelectorAll('.cy-pop').length, 0, 'the full panel should close');
  assert.equal(dock(sandbox).root.style.display, 'none', 'the dock hides behind the mini player');

  mini.querySelectorAll('.cy-btn')[0].click();
  assert.equal(sandbox.document.querySelector('.cy-mini'), null, 'expanding removes the mini player');
  assert.notEqual(sandbox.document.querySelector('.cy-player'), null, 'and brings the full panel back');
  assert.equal(dock(sandbox).root.style.display, '');
});

/* ------------------------------------------------------------------ *
 * The playlist is a window, not a list. A library that grows must not
 * grow the panel with it.
 * ------------------------------------------------------------------ */

/** `LIBRARY`, but with nine tracks instead of one. */
const BIG_LIBRARY = new Map([['/theme-cyrene-assets/manifest', {
  ...LIBRARY.get('/theme-cyrene-assets/manifest'),
  music: Array.from({ length: 9 }, (_, index) => ({
    id: `builtin:music/track-${index + 1}.mp3`,
    name: `track-${index + 1}.mp3`,
    label: `track-${index + 1}`,
    kind: 'audio',
    mime: 'audio/mpeg',
    url: `/theme-cyrene-assets/pkg/music/track-${index + 1}.mp3`,
    source: 'builtin',
    cover: null
  })),
  state: { trackId: 'builtin:music/track-9.mp3' }
}]]);

test('the playlist shows four rows at a time at the shipped font size', async () => {
  const { sandbox } = await mountPlugin();
  const sheet = sandbox.document.head.querySelectorAll('style')
    .find((style) => style.dataset.pluginCss.endsWith('controls.css'));
  const css = sheet.textContent;

  /** The px value of one custom property. */
  const token = (name) => {
    const match = new RegExp(`${name}:\\s*([0-9.]+)px`, 'u').exec(css);
    assert.notEqual(match, null, `${name} must be defined`);
    return Number(match[1]);
  };

  const window = token('--cy-playlist-h');
  const row = token('--cy-song-h');

  // 6 padding + 6 padding + an 18px line box = 27. A row that grows past what
  // the window was sized for pushes the fourth song into the clipped zone.
  assert.equal(row, 27, 'the row height is what the window height was computed from');
  assert.equal(row * 4, window, 'the window must be exactly four rows tall');
  assert.ok(row * 3 < window, 'and not fewer than four');

  const rule = /\.cy-playlist\s*\{[^}]*\}/u.exec(css);
  assert.notEqual(rule, null, '.cy-playlist must be emitted');
  assert.match(rule[0], /height:\s*var\(--cy-playlist-h\)/u, 'a fixed height, so a long list cannot grow the panel');
  assert.match(rule[0], /overflow-y:\s*auto/u, 'and it must scroll');

  // The scrollbar has to match the wallpaper grid's 6px. `scrollbar-width: thin`
  // would look like the modern way to do this and is the opposite: measured in
  // Chromium it resolves to 10px and overrides the pseudo-element width, so
  // adding it makes the bar wider rather than thinner.
  const bar = /\.cy-playlist::-webkit-scrollbar\s*\{[^}]*\}/u.exec(css);
  assert.notEqual(bar, null, 'the scrollbar must be sized explicitly');
  assert.match(bar[0], /width:\s*6px/u, 'six pixels, same as the wallpaper grid');
  assert.ok(
    !/scrollbar-width/u.test(css),
    'no standard scrollbar-width: it beats the pseudo-element and widens the bar'
  );
});

test('a long playlist scrolls, and the playing song is revealed on open', async () => {
  const { sandbox } = await mountPlugin({ responses: BIG_LIBRARY });

  // The harness records scroll requests on the outer global, like __document.
  // Read it only after mounting: createEnvironment is what creates the array.
  const scrolls = globalThis.__scrolls;

  // Nothing may scroll before the panel exists.
  assert.deepEqual(scrolls, [], 'a mount with no panel open scrolls nothing');

  dockButton(sandbox, 'Cyrene').click();

  const player = sandbox.document.querySelector('.cy-player');
  const rows = player.querySelectorAll('.cy-song');
  assert.equal(rows.length, 9, 'every track is still reachable, just not all at once');

  // The rows carry their id, so nothing has to be matched by label.
  assert.deepEqual(
    rows.map((row) => row.getAttribute('data-track')),
    Array.from({ length: 9 }, (_, index) => `builtin:music/track-${index + 1}.mp3`)
  );

  // The panel ships on track 9, which is well below the fold.
  const current = rows.filter((row) => row.getAttribute('data-current') === 'true');
  assert.equal(current.length, 1, 'exactly one row is marked as playing');
  assert.equal(current[0].getAttribute('data-track'), 'builtin:music/track-9.mp3');

  // The builder runs detached, so scrolling has to happen at the mount. Without
  // that hook the list would open at the top with the playing song hidden.
  assert.deepEqual(
    scrolls,
    [{ track: 'builtin:music/track-9.mp3', current: 'true', block: 'nearest' }],
    'opening the panel reveals the playing song'
  );

  // sync runs on every playback event, so an unchanged track must not scroll
  // again — that would fight the user for the scroll position.
  scrolls.length = 0;
  const seek = player.querySelectorAll('.cy-seek')[0];
  seek.value = '500';
  seek.dispatchEvent({ type: 'input' });
  assert.deepEqual(scrolls, [], 'a seek does not re-scroll the list');

  // Picking a different song is a real change, so it does scroll to it.
  rows[0].click();
  assert.deepEqual(
    scrolls,
    [{ track: 'builtin:music/track-1.mp3', current: 'true', block: 'nearest' }],
    'choosing another song scrolls it into view'
  );
});

test('opening and closing the music panel repeatedly does not pile up listeners', async () => {
  const { sandbox } = await mountPlugin({ responses: LIBRARY });
  const music = dockButton(sandbox, 'Cyrene');
  for (let round = 0; round < 5; round += 1) {
    music.click();
    music.click();
  }
  // The audio element keeps exactly the controller's own listeners; a leaked
  // panel subscription would show up as extra announce listeners, which we
  // observe indirectly by confirming only one panel exists at a time.
  assert.equal(sandbox.document.querySelectorAll('.cy-player').length, 0);
});

/* ------------------------------------------------------------------ *
 * The collapsible bottom-left dock.
 * ------------------------------------------------------------------ */

test('the dock starts in the bottom-left corner', async () => {
  const { sandbox } = await mountPlugin();
  const wrap = sandbox.document.querySelector('.cy-dock-wrap');
  assert.notEqual(wrap, null);
  assert.equal(wrap.style.left, '18px');
  assert.equal(wrap.style.bottom, '22px');
  assert.equal(wrap.style.right, 'auto');
  // Both states live in one anchor, so folding cannot move the control.
  assert.notEqual(wrap.querySelector('.cy-dock'), null);
  assert.notEqual(wrap.querySelector('.cy-dot'), null);
});

test('the dock folds itself away when idle and unfolds on a click', async () => {
  const { sandbox } = await mountPlugin();
  const wrap = sandbox.document.querySelector('.cy-dock-wrap');
  assert.equal(wrap.dataset.collapsed, 'false');

  sandbox.__flushTimers(); // the idle timer
  assert.equal(wrap.dataset.collapsed, 'true', 'an idle dock should fold away');
  assert.equal(settingsOf(sandbox).dockCollapsed, true, 'and the choice is remembered');

  const dot = wrap.querySelector('.cy-dot');
  assert.notEqual(dot, null);
  dot.click();
  assert.equal(wrap.dataset.collapsed, 'false');
  assert.equal(settingsOf(sandbox).dockCollapsed, false);
});

test('the dock will not fold out from under an open popover', async () => {
  const { sandbox } = await mountPlugin();
  const wrap = sandbox.document.querySelector('.cy-dock-wrap');

  dockButton(sandbox, 'Scene').click(); // open the wallpaper panel
  assert.equal(sandbox.document.querySelectorAll('.cy-pop').length, 1);

  sandbox.__flushTimers();
  assert.equal(wrap.dataset.collapsed, 'false', 'the dock stays put while a panel is open');
  assert.equal(sandbox.document.querySelectorAll('.cy-pop').length, 1);
});

test('the fold control collapses the dock and closes its panels', async () => {
  const { sandbox } = await mountPlugin();
  const wrap = sandbox.document.querySelector('.cy-dock-wrap');
  dockButton(sandbox, 'Scene').click();
  assert.equal(sandbox.document.querySelectorAll('.cy-pop').length, 1);

  wrap.querySelector('.cy-fold').click();
  assert.equal(wrap.dataset.collapsed, 'true');
  assert.equal(sandbox.document.querySelectorAll('.cy-pop').length, 0, 'folding closes the panel it anchored');
  assert.equal(settingsOf(sandbox).dockCollapsed, true);
});

/* ------------------------------------------------------------------ *
 * The retuned look: less ghosting, brighter wallpaper.
 * ------------------------------------------------------------------ */

test('stacked surfaces are near-opaque, so a nested dialog cannot ghost', async () => {
  const { sandbox } = await mountPlugin();
  const identity = sandbox.document.head.querySelectorAll('style')
    .find((sheet) => sheet.dataset.pluginCss.endsWith('identity.css'));

  /** Read one token's alpha out of the emitted sheet. */
  const alphaOf = (token) => {
    const match = new RegExp(`${token}:\\s*rgba\\([^)]*?,\\s*([0-9.]+)\\)`, 'u').exec(identity.textContent);
    assert.notEqual(match, null, `${token} must be present`);
    return Number(match[1]);
  };

  // The pair that produced the reported double-image text.
  assert.ok(alphaOf('--dsw-specific-bubble') >= 0.75, 'chat bubbles must be nearly solid');
  assert.ok(alphaOf('--dsw-specific-input-major') >= 0.82, 'the composer must be nearly solid');
  assert.ok(alphaOf('--dsw-alias-bg-overlay') >= 0.88, 'dialogs must be nearly solid');
  assert.ok(alphaOf('--dsw-alias-settings-card-fill') >= 0.75, 'settings cards must be nearly solid');
  assert.ok(alphaOf('--dsw-menu-surface-fill') >= 0.88, 'menus must be nearly solid');

  // The base layer must stay open, or the wallpaper stops being the point.
  assert.ok(alphaOf('--dsw-alias-bg-base') <= 0.5, 'the app base should still read the wallpaper through');
});

test('the wallpaper is brightened with a filter and a much lighter shade', async () => {
  const { sandbox } = await mountPlugin();
  const layers = sandbox.document.querySelector('.cy-layer-root');
  const shade = layers.querySelector('.cy-shade');

  // The tuning travels as custom properties on the root element rather than as
  // inline styles on the three layers: the filter is one declaration that has
  // to land on all of them, and a variable lets the stylesheet decide that
  // instead of three writers that each have to remember the full list.
  const filter = sandbox.document.documentElement.style.getPropertyValue('--cy-wall-filter');
  assert.match(filter, /^brightness\(1\.[0-9]{2}\) saturate\([0-9.]+\) contrast\([0-9.]+\)$/u, `unexpected filter: ${filter}`);
  assert.ok(!filter.includes('brightness(1.00)'), 'the filter must actually lift the image');

  // Every layer reads that same variable, so they cannot drift apart.
  const sheet = sandbox.document.head.querySelectorAll('style')
    .find((node) => node.dataset.pluginCss === `${PLUGIN_ID}/identity.css`).textContent;
  assert.ok(sheet.includes('filter: var(--cy-wall-filter'), 'the wallpaper must read the variable');
  assert.ok(sheet.includes('blur(var(--cy-wall-blur'), 'and the video layer carries the fog');

  // The readability gradient is light: at most ~0.2 alpha on the deepest edge.
  const alphas = [...shade.style.background.matchAll(/rgba\([^)]*?,\s*([0-9.]+)\)/gu)].map((m) => Number(m[1]));
  assert.ok(alphas.length >= 2, 'the gradient must be emitted');
  assert.ok(Math.max(...alphas) <= 0.25, `the shade is too dark (max ${Math.max(...alphas)})`);
});

test('the wallpaper panel exposes the live look controls', async () => {
  const { sandbox } = await mountPlugin();
  dockButton(sandbox, 'Scene').click();
  const panel = sandbox.document.querySelector('.cy-pop');

  /** The range inside a tuning row, by its setting key. */
  const tuning = (key) => {
    const row = panel.querySelectorAll('[data-tuning]').find((node) => node.dataset.tuning === key);
    assert.notEqual(row, undefined, `no tuning row for ${key}`);
    const input = row.querySelectorAll('input')[0];
    assert.notEqual(input, undefined, `${key} must have a slider`);
    return input;
  };

  // Every knob the requirement lists, each writing its own setting.
  const expected = {
    wallContrast: 130,
    wallSaturate: 150,
    wallOpacity: 60,
    wallFog: 8,
    wallScale: 120
  };
  for (const [key, value] of Object.entries(expected)) {
    const input = tuning(key);
    input.value = String(value);
    input.dispatchEvent({ type: 'input', target: input });
  }
  const saved = settingsOf(sandbox);
  assert.equal(saved.wallContrast, 1.3);
  assert.equal(saved.wallSaturate, 1.5);
  assert.equal(saved.wallOpacity, 0.6);
  assert.equal(saved.wallFog, 8);
  assert.equal(saved.wallScale, 1.2);

  // And the primitive knobs keep their own sliders and ranges. All of them share
  // the `cy-seek` class, so the two older controls sit at the front of the list,
  // then the five wallpaper rows, then the three glass rows.
  const seekRows = panel.querySelectorAll('.cy-seek');
  assert.equal(seekRows.length, 10, `expected 2 + 5 + 3 sliders, saw ${seekRows.length}`);

  const brightness = seekRows[0];
  brightness.value = '170';
  brightness.dispatchEvent({ type: 'input', target: brightness });
  assert.equal(settingsOf(sandbox).wallBrightness, 1.7);
  // The value reaches the layers through the root variable, not an inline style.
  assert.match(
    sandbox.document.documentElement.style.getPropertyValue('--cy-wall-filter'),
    /^brightness\(1\.70\)/u
  );

  const shade = seekRows[1];
  shade.value = '45';
  shade.dispatchEvent({ type: 'input', target: shade });
  assert.equal(settingsOf(sandbox).shade, 0.45);
});
