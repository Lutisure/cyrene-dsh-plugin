// Reply avatar.
//
// The portrait is attached by a document-wide observer rather than by the panel
// machinery, so the things worth pinning down are the ones that observer is
// responsible for: that it decorates exactly the right nodes, that running it
// again does nothing (a streaming reply re-renders constantly, and a second
// portrait per reply would be very visible), and that turning it off takes them
// all back off rather than leaving some behind.

import assert from 'node:assert/strict';
import test from 'node:test';

import { mountPlugin } from './harness.mjs';

/**
 * Put one chat node into the document.
 *
 * @param {object} sandbox - the harness sandbox.
 * @param {string} kind - the value of `data-chat-flow-kind`.
 * @param {string} text - its text.
 * @returns {object} the node.
 */
function chatNode(sandbox, kind, text) {
  const node = sandbox.document.createElement('div');
  node.setAttribute('data-chat-flow-kind', kind);
  node.textContent = text;
  sandbox.document.body.appendChild(node);
  return node;
}

/** Let the batched pass run. */
async function settle(sandbox) {
  await new Promise((resolve) => setImmediate(resolve));
  sandbox.__flushFrames();
  await new Promise((resolve) => setImmediate(resolve));
}

test('a reply is led by her portrait', async () => {
  // Pinned to `builtin`: since 2026-10-11 the shipped default is the author's own
  // picture, so asking for the built-in file by name keeps this a statement about
  // "a reply gets a face" rather than about which face that happens to be.
  const { sandbox } = await mountPlugin({ settings: { avatarSource: 'builtin' } });
  chatNode(sandbox, 'assistant-step', 'her answer');
  await settle(sandbox);

  const images = sandbox.document.querySelectorAll('.cy-reply-avatar');
  assert.equal(images.length, 1, 'one reply, one portrait');
  assert.ok(
    String(images[0].getAttribute('src')).includes('cyrene-avatar'),
    `the built-in portrait, saw ${images[0].getAttribute('src')}`
  );
});

test('a reply leads with whatever face the dotted settings name', async () => {
  // The reply portrait is the same face as the dot's, read from the settings
  // document rather than from a constant. Here the stored value is the one this
  // build ships as its default, so a fresh install's replies carry the author's
  // picture the same way the collapsed dot does.
  const custom = 'data:image/webp;base64,AAAA';
  const { sandbox } = await mountPlugin({ settings: { avatarSource: 'custom', avatarCustom: custom } });
  chatNode(sandbox, 'assistant-step', 'her answer');
  await settle(sandbox);

  const images = sandbox.document.querySelectorAll('.cy-reply-avatar');
  assert.equal(images.length, 1, 'one reply, one portrait');
  assert.equal(images[0].getAttribute('src'), custom, 'and it is the stored face, byte for byte');
});

test('the reader\'s own words are not given one', async () => {
  const { sandbox } = await mountPlugin();
  chatNode(sandbox, 'user', 'what I said');
  await settle(sandbox);

  assert.equal(
    sandbox.document.querySelectorAll('.cy-reply-avatar').length,
    0,
    'a portrait beside the reader says nothing'
  );
});

test('tool calls and process blocks are not decorated either', async () => {
  // Only `assistant-step` is her reply. The same hook distinguishes five kinds,
  // and a portrait on a tool call would claim the tool's output as her words.
  const { sandbox } = await mountPlugin();
  for (const kind of ['turn-process', 'tool-call', 'turn-tail']) {
    chatNode(sandbox, kind, kind);
  }
  await settle(sandbox);

  assert.equal(sandbox.document.querySelectorAll('.cy-reply-avatar').length, 0);
});

test('a second pass does not add a second portrait', async () => {
  // This is the failure that would matter most in practice: a streaming reply
  // mutates the conversation many times a second, and every one of those
  // mutations runs the pass.
  const { sandbox } = await mountPlugin();
  const node = chatNode(sandbox, 'assistant-step', 'streaming…');
  await settle(sandbox);
  await settle(sandbox);
  const later = chatNode(sandbox, 'assistant-step', 'a second reply');
  await settle(sandbox);

  const images = node.querySelectorAll('.cy-reply-avatar');
  assert.equal(images.length, 1, 'still exactly one on the first reply');
  assert.equal(
    sandbox.document.querySelectorAll('.cy-reply-avatar').length,
    2,
    'and one on the new reply'
  );
  assert.notEqual(later, null);
});

test('turning it off takes every portrait back off', async () => {
  const { sandbox } = await mountPlugin();
  chatNode(sandbox, 'assistant-step', 'one');
  chatNode(sandbox, 'assistant-step', 'two');
  await settle(sandbox);
  assert.equal(sandbox.document.querySelectorAll('.cy-reply-avatar').length, 2);

  sandbox.__applySettings({ replyAvatar: false });
  await settle(sandbox);
  assert.equal(
    sandbox.document.querySelectorAll('.cy-reply-avatar').length,
    0,
    'nothing left behind'
  );
});

test('turning it back on decorates the replies already on screen', async () => {
  // The conversation is not rebuilt when a setting changes, so a toggle that only
  // affected future replies would look broken until the next turn.
  const { sandbox } = await mountPlugin({ settings: { replyAvatar: false } });
  chatNode(sandbox, 'assistant-step', 'already here');
  await settle(sandbox);
  assert.equal(sandbox.document.querySelectorAll('.cy-reply-avatar').length, 0);

  sandbox.__applySettings({ replyAvatar: true });
  await settle(sandbox);
  assert.equal(sandbox.document.querySelectorAll('.cy-reply-avatar').length, 1);
});

test('the portrait follows the chosen avatar source', async () => {
  const { sandbox } = await mountPlugin();
  chatNode(sandbox, 'assistant-step', 'her answer');
  await settle(sandbox);

  sandbox.__applySettings({ avatarSource: 'none' });
  await settle(sandbox);
  assert.equal(
    sandbox.document.querySelectorAll('.cy-reply-avatar').length,
    0,
    'no portrait chosen means no portrait'
  );
});
