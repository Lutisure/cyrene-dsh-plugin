// The font system.
//
// Three facts from the host reconnaissance (2026-10-10) drive every assertion
// here, and each of them was a way to write a control that looks like it works
// and changes nothing:
//
//   1. The size ladder is declared on `body`, not `:root`. An override on
//      `:root` alone is inert for the ladder.
//   2. The ladder is a `font:` **shorthand**; substitution happens before the
//      shorthand is parsed, so a partial edit invalidates the declaration. A
//      change to family, size or weight has to re-emit the whole token.
//   3. `--dsl-terminal-font` is declared on the terminal card itself, so
//      rebinding that name from outside loses. The way in is its upstream
//      `--dsw-font-markdown-code-block`.

import assert from 'node:assert/strict';
import test from 'node:test';

import {PLUGIN_ID,  mountPlugin } from './harness.mjs';

/** The font sheet's text, or null when it is not mounted. */
function fontSheet(sandbox) {
  const sheet = sandbox.document.head
    .querySelectorAll('style')
    .find((node) => node.dataset.pluginCss === `${PLUGIN_ID}/fonts`);
  return sheet === undefined ? null : sheet.textContent;
}

/** The dock button with a given label. */
function dockButton(sandbox, label) {
  const button = sandbox.document.querySelectorAll('.cy-btn').find((node) => node.textContent === label);
  assert.notEqual(button, undefined, `the dock must offer a ${label} button`);
  return button;
}

/** Open the 字体 panel. */
async function openFonts(sandbox) {
  dockButton(sandbox, 'Type').click();
  await new Promise((resolve) => setImmediate(resolve));
  const panel = sandbox.document.querySelector('.cy-pop');
  assert.notEqual(panel, null, 'the panel must open');
  return panel;
}

/** Type a face into the row for a setting and fire the change a user would. */
function setFace(sandbox, key, value) {
  const row = sandbox.document
    .querySelectorAll('[data-face]')
    .find((node) => node.dataset.face === key);
  assert.notEqual(row, undefined, `no face row for ${key}`);
  const input = row.querySelectorAll('input')[0];
  assert.notEqual(input, undefined, `${key} must have a text field`);
  input.value = value;
  input.dispatchEvent({ type: 'change', target: input });
}

test('a fresh install emits an empty sheet, so the host keeps its own fonts', async () => {
  const { sandbox } = await mountPlugin();
  assert.equal(fontSheet(sandbox), '', 'nothing customised, nothing emitted');
});

test('a face change lands on body, not only on :root', async () => {
  const { sandbox } = await mountPlugin();
  await openFonts(sandbox);
  setFace(sandbox, 'fontBodyFamily', 'Inter, sans-serif');

  const sheet = fontSheet(sandbox);
  assert.notEqual(sheet, '', 'a face change must emit CSS');
  assert.ok(sheet.includes('--dsw-font-family: Inter, sans-serif'), 'the host token is rebound');

  // The reconnaissance fact: the ladder lives on body, so the override has to
  // name body or it loses to body's own declaration.
  assert.ok(/html\[data-cyrene-theme="on"\] body \{/.test(sheet), 'the block must target body');
  assert.ok(/html\[data-cyrene-theme="on"\], html\[data-cyrene-theme="on"\] body \{/.test(sheet),
    'the root token must be set on both scopes');
});

test('a face change re-emits the ladder as whole `font:` values', async () => {
  const { sandbox } = await mountPlugin();
  await openFonts(sandbox);
  setFace(sandbox, 'fontBodyFamily', 'Georgia, serif');

  const sheet = fontSheet(sandbox);
  // Every step is re-emitted whole — a partial edit inside a `font:` shorthand
  // is invalid CSS, so the family cannot be swapped on its own.
  for (const step of ['xxxs-11', 'xxs-12', 'xs-13', 's-14', 'base-16', 'm-18', 'l-20', 'xl-24']) {
    assert.ok(sheet.includes('--dsw-font-' + step + ': 400 '), `step ${step} must be re-emitted`);
  }
  assert.ok(sheet.includes('Georgia, serif'), 'and carry the new face');
  // The longhands the host also declares.
  assert.ok(sheet.includes('--dsw-font-xs-13-font-family: Georgia, serif'), 'longhands follow');
});

test('a size change moves the markdown base, not only the tokens', async () => {
  const { sandbox } = await mountPlugin();
  const panel = await openFonts(sandbox);

  const scale = panel.querySelectorAll('.cy-seek')[0];
  assert.notEqual(scale, undefined, 'the panel must offer a size slider');
  scale.value = '7'; // 1.2 in FONT_SCALES
  scale.dispatchEvent({ type: 'input', target: scale });

  const sheet = fontSheet(sandbox);
  // The markdown step rides on one base plus a delta; moving the tokens alone
  // would leave the delta behind and half the page would keep the old size.
  assert.ok(sheet.includes('--dsh-content-font-size: 16.8px'), 'the content base must move: ' + sheet.slice(0, 200));
  assert.ok(sheet.includes('--dsw-font-s-14: 400 16.8px/26.4px'), 'the ladder must scale too');
});

test('a weight change re-emits every step with that weight', async () => {
  const { sandbox } = await mountPlugin();
  const panel = await openFonts(sandbox);

  const group = panel.querySelectorAll('.cy-seg').find((node) => node.dataset.key === 'fontWeight');
  assert.notEqual(group, undefined, 'the panel must offer weights');
  const bold = group.querySelectorAll('button').find((node) => node.textContent === '粗');
  bold.click();

  const sheet = fontSheet(sandbox);
  assert.ok(sheet.includes('--dsw-font-s-14: 700 14px/22px'), 'every step carries the weight');
  assert.ok(sheet.includes('--dsw-font-s-14-font-weight: 700'), 'and so does the longhand');
});

test('the monospace face goes through the upstream token, never the terminal one', async () => {
  const { sandbox } = await mountPlugin();
  await openFonts(sandbox);
  setFace(sandbox, 'fontMonoFamily', 'Consolas, monospace');

  const sheet = fontSheet(sandbox);
  assert.ok(sheet.includes('--ds-font-family-code: Consolas, monospace'), 'the host code token is rebound');
  assert.ok(sheet.includes('--dsw-font-markdown-code-block: 400 '), 'the terminal card reads this upstream token');

  // Regression guard: rebinding `--dsl-terminal-font` itself is the mistake the
  // reference implementation makes — the card declares it on itself and wins.
  assert.equal(sheet.includes('--dsl-terminal-font'), false, 'the terminal token must NOT be rebound directly');
});

test('restoring the host defaults empties the sheet again', async () => {
  const { sandbox } = await mountPlugin();
  const panel = await openFonts(sandbox);
  setFace(sandbox, 'fontBodyFamily', 'Inter');
  assert.notEqual(fontSheet(sandbox), '', 'something is customised');

  const reset = panel.querySelectorAll('.cy-act').find((node) => node.textContent.includes('恢复宿主默认'));
  assert.notEqual(reset, undefined, 'the panel must offer a reset');
  reset.click();

  assert.equal(fontSheet(sandbox), '', 'and the sheet goes back to empty');
});

test('a semicolon in a typed face cannot escape the declaration', async () => {
  const { sandbox } = await mountPlugin();
  await openFonts(sandbox);
  // A face name never contains these, and letting one through would end the
  // declaration and turn the rest into unrelated rules.
  setFace(sandbox, 'fontBodyFamily', 'Inter; } html { display: none } .x {');

  const sheet = fontSheet(sandbox);
  assert.ok(sheet.includes('--dsw-font-family: Inter'), 'the usable part survives');

  // What matters is not that the text is absent — the leftover words become
  // inert text inside the value, and three of the four braces cancel out — but
  // that no *rule* came out of it. So: braces balance, and no line closes a
  // block before it opens one, which is what a breakout would look like.
  assert.equal((sheet.match(/\{/g) ?? []).length, (sheet.match(/\}/g) ?? []).length, 'braces stay balanced');
  for (const line of sheet.split('\n')) {
    const close = line.indexOf('}');
    const open = line.indexOf('{');
    if (close === -1 || open === -1) continue;
    assert.ok(open < close, 'no line may close a block before opening one: ' + line.slice(0, 80));
  }
  assert.equal(sheet.includes('} html'), false, 'the breakout sequence does not survive');
});

/** Read the saved settings document out of the fake localStorage. */
function settingsOf(sandbox) {
  const raw = sandbox.localStorage.getItem('dsh-theme-cyrene:settings');
  return raw === null ? {} : JSON.parse(raw);
}

/** The set list rows, keyed by the set id they carry. */
function setRows(sandbox) {
  return sandbox.document
    .querySelectorAll('[data-set-row]')
    .map((row) => ({
      id: row.dataset.setRow,
      label: row.querySelectorAll('button')[0].textContent,
      buttons: row.querySelectorAll('button')
    }));
}

/** Type a name into the save field and press the save button. */
function saveSet(sandbox, name) {
  const panel = sandbox.document.querySelector('.cy-pop');
  // `getAttribute`, not `.placeholder`: the shim keeps attributes in one store
  // and mirrors only `dataset` onto it, so property access that a real DOM
  // would serve from the attribute returns undefined here.
  const field = panel.querySelectorAll('input')
    .find((input) => input.getAttribute('placeholder') === '新字体集的名字');
  assert.notEqual(field, undefined, 'the panel must offer a name field');
  field.value = name;
  const save = panel.querySelectorAll('.cy-act').find((button) => button.textContent === '存为字体集');
  assert.notEqual(save, undefined, 'the panel must offer a save button');
  save.click();
}

/** The hidden file field the import path reads. */
function fileField(sandbox) {
  const input = sandbox.document.querySelector('.cy-pop')
    .querySelectorAll('input')
    .find((node) => node.getAttribute('type') === 'file');
  assert.notEqual(input, undefined, 'the panel must carry a file field');
  return input;
}

test('the built-in sets are listed, and 宿主默认 starts active', async () => {
  const { sandbox } = await mountPlugin();
  await openFonts(sandbox);

  const rows = setRows(sandbox);
  assert.deepEqual(rows.map((row) => row.label), ['宿主默认', '柔和圆体', '紧凑等宽']);
  assert.equal(settingsOf(sandbox).fontActiveSet, 'host');
  // A built-in is the library's floor, not something to delete.
  for (const row of rows) {
    assert.equal(row.buttons.some((button) => button.textContent === '删除'), false, 'built-ins are not deletable');
  }
});

test('saving the current settings adds a set holding exactly those values', async () => {
  const { sandbox } = await mountPlugin();
  await openFonts(sandbox);
  setFace(sandbox, 'fontBodyFamily', 'Georgia, serif');
  saveSet(sandbox, '我的衬线');

  const saved = settingsOf(sandbox);
  const added = saved.fontSets.find((set) => set.name === '我的衬线');
  assert.notEqual(added, undefined, 'the set must be persisted');
  assert.deepEqual(added.values, {
    fontBodyFamily: 'Georgia, serif',
    fontMonoFamily: '',
    fontScale: 1,
    fontWeight: 0
  });
  // Saving also selects what was just saved, so the list agrees with the sheet.
  assert.equal(saved.fontActiveSet, added.id);
  assert.equal(setRows(sandbox).some((row) => row.label === '我的衬线'), true, 'and it appears in the list');
});

test('applying a saved set restores it after other changes', async () => {
  const { sandbox } = await mountPlugin();
  await openFonts(sandbox);
  setFace(sandbox, 'fontMonoFamily', 'Consolas, monospace');
  saveSet(sandbox, '等宽测试');

  // Move away, so the restore has something to undo.
  setFace(sandbox, 'fontMonoFamily', 'Courier, monospace');
  assert.ok(fontSheet(sandbox).includes('Courier, monospace'), 'the change took');

  const row = setRows(sandbox).find((candidate) => candidate.label === '等宽测试');
  row.buttons[0].click();

  const sheet = fontSheet(sandbox);
  assert.ok(sheet.includes('--ds-font-family-code: Consolas, monospace'), 'the saved face is back');
  assert.equal(sheet.includes('Courier'), false, 'and the other one is gone');
});

test('applying 宿主默认 clears every customisation', async () => {
  const { sandbox } = await mountPlugin();
  await openFonts(sandbox);
  setFace(sandbox, 'fontBodyFamily', 'Georgia, serif');
  assert.notEqual(fontSheet(sandbox), '', 'something is customised');

  const host = setRows(sandbox).find((row) => row.label === '宿主默认');
  host.buttons[0].click();

  // The bug this guards: a merge that skips empty strings would refuse to clear
  // the face, so 宿主默认 would look like it did nothing.
  assert.equal(fontSheet(sandbox), '', 'the sheet must go back to empty');
  assert.equal(settingsOf(sandbox).fontBodyFamily, '', 'and the stored face is cleared');
});

test('saving a name twice updates the set instead of duplicating it', async () => {
  const { sandbox } = await mountPlugin();
  await openFonts(sandbox);
  setFace(sandbox, 'fontBodyFamily', 'Georgia, serif');
  saveSet(sandbox, '同名');
  setFace(sandbox, 'fontBodyFamily', 'Inter, sans-serif');
  saveSet(sandbox, '同名');

  const sets = settingsOf(sandbox).fontSets.filter((set) => set.name === '同名');
  assert.equal(sets.length, 1, 'two sets with one name would both be reachable');
  assert.equal(sets[0].values.fontBodyFamily, 'Inter, sans-serif', 'and it holds the latest values');
});

test('the reserved built-in name cannot be taken', async () => {
  const { sandbox } = await mountPlugin();
  await openFonts(sandbox);
  saveSet(sandbox, '宿主默认');

  assert.equal((settingsOf(sandbox).fontSets ?? []).length, 0, 'nothing may shadow the built-in entry');
});

test('deleting a set takes two clicks, and the first one only arms', async () => {
  const { sandbox } = await mountPlugin();
  await openFonts(sandbox);
  saveSet(sandbox, '待删');

  /** The delete button currently in the document for a set. */
  const removeFor = (label) => {
    const row = setRows(sandbox).find((candidate) => candidate.label === label);
    assert.notEqual(row, undefined, `no row for ${label}`);
    const button = row.buttons.find((node) => node.textContent === '删除' || node.textContent === '确认删除');
    assert.notEqual(button, undefined, 'the row must offer a delete button');
    return button;
  };

  removeFor('待删').click();
  assert.equal(settingsOf(sandbox).fontSets.length, 1, 'the first click must not delete');
  // Re-read rather than reusing the node: arming rebuilds the row, so the node
  // captured before the click is detached and keeps its old label for ever.
  assert.equal(removeFor('待删').textContent, '确认删除', 'it asks first');

  removeFor('待删').click();
  assert.equal(settingsOf(sandbox).fontSets.length, 0, 'the second click deletes');
});

test('export writes every set into a readable JSON document', async () => {
  const { sandbox } = await mountPlugin();
  await openFonts(sandbox);
  saveSet(sandbox, '导出测试');

  const panel = sandbox.document.querySelector('.cy-pop');
  const exportButton = panel.querySelectorAll('.cy-act').find((button) => button.textContent === '导出');
  exportButton.click();

  assert.equal(sandbox.__downloads.length, 1, 'exactly one download');
  const text = sandbox.__downloads[0].parts.join('');
  const parsed = JSON.parse(text);
  assert.equal(parsed.kind, 'dsh-theme-cyrene-fontsets', 'the document names itself');
  assert.equal(parsed.version, 1, 'and carries a version to migrate against');
  // Built-ins travel too, so an exported file is a complete library rather than
  // a fragment whose meaning depends on the reader's build.
  assert.ok(parsed.sets.length >= 4, 'built-ins are included');
  assert.equal(parsed.sets.some((set) => set.name === '导出测试'), true);
});

test('import merges a file, skipping names that would collide', async () => {
  const { sandbox } = await mountPlugin();
  await openFonts(sandbox);

  const file = sandbox.__readFile(JSON.stringify({
    kind: 'dsh-theme-cyrene-fontsets',
    version: 1,
    sets: [
      { name: '外来甲', values: { fontBodyFamily: 'Inter', fontScale: 1.1 } },
      { name: '宿主默认', values: { fontBodyFamily: 'Inter' } },
      { name: '外来甲', values: { fontBodyFamily: 'Georgia' } },
      { name: '', values: { fontBodyFamily: 'Inter' } },
      { name: '空的', values: {} },
      'not an object'
    ]
  }));

  const input = fileField(sandbox);
  input.files = [file];
  input.dispatchEvent({ type: 'change', target: input });

  const sets = settingsOf(sandbox).fontSets;
  assert.deepEqual(sets.map((set) => set.name), ['外来甲'], 'only the one usable, non-colliding set');
  assert.equal(sets[0].values.fontBodyFamily, 'Inter');
  // An import must not change how the interface renders until the user says so.
  assert.equal(fontSheet(sandbox), '', 'importing alone applies nothing');
});

test('an unreadable file is refused rather than half-applied', async () => {
  const { sandbox } = await mountPlugin();
  await openFonts(sandbox);

  const input = fileField(sandbox);
  input.files = [sandbox.__readFile('{ this is not json')];
  input.dispatchEvent({ type: 'change', target: input });

  assert.equal((settingsOf(sandbox).fontSets ?? []).length, 0, 'nothing may be added');
  assert.equal(fontSheet(sandbox), '', 'and nothing is applied');
});

/** The caret row for a given mode key. */
function caretRow(sandbox, modeKey) {
  const row = sandbox.document
    .querySelectorAll('[data-caret]')
    .find((node) => node.dataset.caret === modeKey);
  assert.notEqual(row, undefined, `no caret row for ${modeKey}`);
  return row;
}

/** Choose a caret mode by its visible label. */
function chooseCaret(sandbox, modeKey, label) {
  const row = caretRow(sandbox, modeKey);
  const pick = row.querySelectorAll('select')[0];
  assert.notEqual(pick, undefined, 'the row must offer a mode select');
  const at = Array.prototype.findIndex.call(
    pick.querySelectorAll('option'),
    (option) => option.textContent === label
  );
  assert.ok(at >= 0, `no option labelled ${label}`);
  pick.value = String(at);
  pick.dispatchEvent({ type: 'change', target: pick });
}

test('the caret is left alone by default, in both positions', async () => {
  const { sandbox } = await mountPlugin();
  await openFonts(sandbox);
  // Both default to `auto`, which must emit nothing at all — the composer
  // already carries a deliberate colour of the host's choosing, and every other
  // field already inherits the text colour.
  assert.equal(fontSheet(sandbox), '', '跟随宿主 must emit nothing');
});

test('a global caret colour is written on html so it inherits everywhere', async () => {
  const { sandbox } = await mountPlugin();
  await openFonts(sandbox);
  chooseCaret(sandbox, 'caretColor', '青色');

  const sheet = fontSheet(sandbox);
  // `caret-color` inherits, so one declaration on html reaches the sidebar
  // search box — which has no stable selector of its own, only a hashed class.
  assert.ok(sheet.includes('html[data-cyrene-theme="on"] { caret-color: #8fe8ff !important; }'), 'expected an html-scoped rule: ' + sheet);
  assert.equal(sheet.includes('[data-composer-input]'), false, 'the composer stays untouched by the global value');
});

test('主题强调色 spells out the token the composer already uses', async () => {
  const { sandbox } = await mountPlugin();
  await openFonts(sandbox);
  chooseCaret(sandbox, 'caretColor', '主题强调色');

  const sheet = fontSheet(sandbox);
  assert.ok(sheet.includes('caret-color: var(--dsw-alias-state-business-primary)'),
    'the accent mode must reference the host token, not a copy of its value');
});

test('the composer caret can be set separately, on its one stable hook', async () => {
  const { sandbox } = await mountPlugin();
  await openFonts(sandbox);
  chooseCaret(sandbox, 'caretComposerColor', '琥珀');

  const sheet = fontSheet(sandbox);
  assert.ok(sheet.includes('[data-composer-input] { caret-color: #ffcf8f !important; }'), 'expected the composer rule: ' + sheet);
});

test('both positions co-exist without one flattening the other', async () => {
  const { sandbox } = await mountPlugin();
  await openFonts(sandbox);
  chooseCaret(sandbox, 'caretColor', '粉色');
  chooseCaret(sandbox, 'caretComposerColor', '紫色');

  const sheet = fontSheet(sandbox);
  assert.ok(sheet.includes('caret-color: #f2a7d5'), 'the global value is emitted');
  assert.ok(sheet.includes('caret-color: #b9a6f2'), 'and so is the composer value');
  // The composer rule comes second, so it wins where both match — the point of
  // having two settings rather than one.
  assert.ok(sheet.indexOf('#f2a7d5') < sheet.indexOf('#b9a6f2'), 'the composer rule must come last');
});

test('the caret colour picker only shows for 自定义', async () => {
  const { sandbox } = await mountPlugin();
  await openFonts(sandbox);

  const swatch = () => caretRow(sandbox, 'caretColor').querySelectorAll('input')[0];
  assert.equal(swatch().style.display, 'none', 'hidden while the mode is a preset');

  chooseCaret(sandbox, 'caretColor', '自定义');
  assert.notEqual(swatch().style.display, 'none', 'shown once 自定义 is picked');

  swatch().value = '#123456';
  swatch().dispatchEvent({ type: 'input', target: swatch() });
  assert.ok(fontSheet(sandbox).includes('caret-color: #123456'), 'the picked colour is used');
});

test('the font sheet is released on unmount', async () => {
  const { sandbox, disposers } = await mountPlugin();
  assert.notEqual(fontSheet(sandbox), null, 'mounted with the rest');
  for (const entry of disposers) {
    if (entry !== null && typeof entry === 'object' && typeof entry.dispose === 'function') entry.dispose();
  }
  assert.equal(fontSheet(sandbox), null, 'and removed with the rest');
});
