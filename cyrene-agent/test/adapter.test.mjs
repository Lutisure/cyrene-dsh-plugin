/**
 * Tests for the Star Rail message adapter.
 *
 * The fixtures mirror the real schema, and the two rules that matter most are
 * the ones the real data forced: `System` messages must not break a turn, and a
 * `Choice` menu entry followed by an actual `Player` line is one turn, not two.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  enumeratePaths,
  extract,
  normaliseName,
  resolveContacts,
  turnsFromPath
} from '../tools/adapters/starrail-messages.mjs';

const HER = new Set(['200']);

/** One section from a `Messages` map plus its start id. */
function section(messages, start = '1') {
  return { Id: 's', StartingMessageId: start, Messages: messages };
}

/** A text message. */
function msg(id, sender, text, next, contactId = '200') {
  const out = { Id: id, MessageType: 'Text', SenderType: sender, Text: text };
  if (sender === 'NPC') out.SenderContactId = contactId;
  if (next !== undefined) out.NextMessageId = next;
  return out;
}

test('contacts are matched by alias, in both simplified and traditional forms', () => {
  const contacts = [
    { Id: '200', Name: '昔涟', Signature: '永恒属于每一刻', ConversationIds: ['1'], VersionAdded: '3.5' },
    { Id: '1415', Name: '昔漣', Signature: '要相信浪漫一如初见♪', ConversationIds: ['2'], VersionAdded: '3.7' },
    { Id: '1002', Name: '丹恒', ConversationIds: ['3'] }
  ];
  const matched = resolveContacts(contacts, ['昔涟', '昔漣']);
  assert.equal(matched.length, 2);
  assert.deepEqual(matched.map((contact) => contact.id), ['200', '1415']);
  assert.equal(matched[1].signature, '要相信浪漫一如初见♪', 'the signature is kept; it is persona material');
  assert.equal(resolveContacts(contacts, ['Cyrene']).length, 0, 'a name that is not there must not match');
  assert.equal(normaliseName('昔 涟'), '昔涟');
});

test('every branch of a Choice is enumerated, with the option text injected', () => {
  const store = {
    '1': msg('1', 'NPC', '嗨，是我，想我了吗？', 'c1'),
    c1: {
      Id: 'c1',
      MessageType: 'Choice',
      Choices: [
        { ChoiceType: 'Text', Text: '想你了', NextMessageId: '2' },
        { ChoiceType: 'Text', Text: '别开玩笑啦', NextMessageId: '3' }
      ]
    },
    '2': msg('2', 'NPC', '我也想你呀'),
    '3': msg('3', 'NPC', '才没有开玩笑呢')
  };
  const paths = enumeratePaths(store, '1');
  assert.equal(paths.length, 2, 'one path per option');

  const texts = paths.map((path) => path.map((message) => message.Text));
  assert.deepEqual(texts[0], ['嗨，是我，想我了吗？', '想你了', '我也想你呀']);
  assert.deepEqual(texts[1], ['嗨，是我，想我了吗？', '别开玩笑啦', '才没有开玩笑呢']);
  // The synthetic player entry is flagged, so the turn builder knows its weight.
  assert.equal(paths[0][1].__fromChoice, true);
  assert.equal(paths[0][1].SenderType, 'Player');
});

test('a system notice between the player and her reply does not break the pair', () => {
  // This is the real shape from conversation 14537: the message fails to send
  // while she is out of range, and an earlier version dropped the pair.
  const path = [
    msg('1', 'System', '信号搜索中', '2', '8001'),
    msg('2', 'NPC', '嗨，是我，想我了吗？', 'c1'),
    { Id: 'c1', MessageType: 'Choice', SenderType: undefined, Choices: [{ Text: '想你了', NextMessageId: '3' }] },
    { ...msg('choice', 'Player', '想你了', '3'), __fromChoice: true },
    msg('3', 'Player', '你在哪儿呀', '4', '8001'),
    msg('4', 'System', '消息发送失败', '5', '8001'),
    msg('5', 'System', '用户不在通信服务区内', '6', '8001'),
    msg('6', 'NPC', '让我猜猜…', '7'),
    msg('7', 'NPC', '答案是——魔法技巧~')
  ];
  const turns = turnsFromPath(path, HER, '14537');
  assert.equal(turns.length, 1, 'the narration must not split the turn');
  // The actually-sent line wins over the menu option, which differs here.
  assert.equal(turns[0].user, '你在哪儿呀');
  assert.equal(turns[0].assistant, '让我猜猜…\n答案是——魔法技巧~', 'her bubbles are joined into one reply');
});

test('the menu option is used when no Player line follows it', () => {
  const path = [
    msg('1', 'NPC', '先开场说一句', 'c1'),
    { ...msg('c1', 'Player', '约好了，一起看星星', '2'), __fromChoice: true },
    msg('2', 'NPC', '好呀，那就说定了')
  ];
  const turns = turnsFromPath(path, HER, 'x');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].user, '约好了，一起看星星');
});

test('another character speaking ends the turn instead of being absorbed', () => {
  const path = [
    msg('1', 'NPC', '先开场说一句'),
    { ...msg('c1', 'Player', '你们都在吗', '2'), __fromChoice: true },
    msg('2', 'NPC', '我在的哦', '3', '1002'), // 丹恒, not her
    msg('3', 'NPC', '我也在', '4') // her
  ];
  const turns = turnsFromPath(path, HER, 'x');
  // Her line after another contact does not silently attach to the player turn.
  assert.equal(turns.length, 0);
});

test('her line with no preceding player turn is not invented into a pair', () => {
  const path = [msg('1', 'NPC', '自言自语的一句'), msg('2', 'NPC', '又一句')];
  assert.deepEqual(turnsFromPath(path, HER, 'x'), []);
});

test('extract keeps only conversations she takes part in, and de-duplicates pairs', () => {
  const conversations = [
    {
      Id: '14537',
      Sections: [section({
        '1': msg('1', 'NPC', '嗨，是我呀', 'c1'),
        c1: { Id: 'c1', MessageType: 'Choice', Choices: [{ Text: '嗨，你在吗', NextMessageId: '2' }] },
        '2': msg('2', 'NPC', '你也好呀')
      })]
    },
    {
      Id: '999',
      Sections: [section({ '1': msg('1', 'NPC', '我是别人', undefined, '1002') })]
    }
  ];
  const result = extract(conversations, HER, { 1002: '丹恒' });

  assert.deepEqual(result.conversationIds, ['14537'], 'a conversation without her is skipped');
  assert.equal(result.turns.length, 1);
  assert.deepEqual(result.messages.map((message) => message.speaker), ['HER', 'HER']);
  assert.ok(result.messages.every((message) => message.conversationId === '14537'));
});

test('a cyclic NextMessageId chain terminates instead of hanging', () => {
  const store = { '1': msg('1', 'NPC', '甲说的一句话', '2'), '2': msg('2', 'NPC', '乙说的一句话', '1') };
  const paths = enumeratePaths(store, '1');
  assert.equal(paths.length, 1);
  assert.ok(paths[0].length <= 2, `expected the loop to be cut, got ${paths[0].length}`);
});

test('a dangling NextMessageId ends the path cleanly', () => {
  const paths = enumeratePaths({ '1': msg('1', 'NPC', '甲说的一句话', 'missing') }, '1');
  assert.equal(paths.length, 1);
  assert.equal(paths[0].length, 1);
});
