#!/usr/bin/env node
/**
 * Adapter: Star Rail's in-game message data → speak/line pairs.
 *
 * Why this source specifically. The famous `Dimbreath/StarRailData` repository
 * is unavailable (HTTP 451, removed for legal reasons), and a plain text map is
 * `hash → string` with **no speaker**, so it cannot answer "which lines are
 * hers". A live mirror —
 * <https://github.com/theBowja/starrail-data> — publishes the message tables
 * per language, and those carry speaker attribution *and* the player's side of
 * the conversation. That makes real two-sided pairs possible, which is far
 * better for a persona than one-sided monologue.
 *
 * Input files (Chinese Simplified, from `data/CHS/`):
 *   messagecontacts.json        contacts: Id, Name, Signature, ConversationIds
 *   messageconversations.json   conversations: Sections[].Messages{} with
 *                               MessageType (Text/Choice/Image/Sticker),
 *                               SenderType (NPC/Player/PlayerAuto/System),
 *                               SenderContactId, Text, NextMessageId, Choices[]
 *
 * Shape of a conversation: a tree, not a transcript. `Choice` messages hold the
 * player's dialogue options and each option carries its own `NextMessageId`.
 * So the output is *per-branch*: several emitted pairs are alternatives that
 * never occur together in one playthrough. That is fine for voice calibration
 * and is called out in the emitted `why` field.
 *
 * Usage:
 *   node tools/adapters/starrail-messages.mjs \
 *     --contacts <messagecontacts.json> \
 *     --conversations <messageconversations.json> \
 *     --aliases 昔涟,昔漣,Cyrene --out corpus-raw
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';

// One cleaning implementation, shared. The adapter used to emit raw game text,
// which leaked `{NICKNAME}` and `[求摸摸]` straight into the few-shot examples.
import { clean, looksLikeNoise } from '../ingest.mjs';

/** Default speaker aliases. */
const DEFAULT_ALIASES = ['昔涟', '昔漣', 'Cyrene'];

/** Cap on enumerated root→leaf paths, so a pathological tree cannot hang. */
const PATH_CAP = 2000;

/** Normalise a name for comparison. */
export function normaliseName(value) {
  return String(value ?? '').replace(/[\s【】\[\]「」·._-]/gu, '').toLowerCase();
}

/**
 * Find the contacts whose name matches an alias.
 * @param {any} contacts - the parsed contacts table.
 * @param {string[]} [aliases] - names to match.
 * @returns {Array<{id: string, name: string, signature: string, versionAdded: string, conversationIds: string[]}>} matches.
 */
export function resolveContacts(contacts, aliases = DEFAULT_ALIASES) {
  const list = Array.isArray(contacts) ? contacts : Object.values(contacts ?? {});
  const wanted = aliases.map(normaliseName).filter(Boolean);
  return list
    .filter((contact) => {
      const name = normaliseName(contact?.Name);
      return name !== '' && wanted.some((alias) => name === alias || name.includes(alias));
    })
    .map((contact) => ({
      id: String(contact.Id),
      name: String(contact.Name),
      signature: String(contact.Signature ?? ''),
      versionAdded: String(contact.VersionAdded ?? ''),
      conversationIds: (contact.ConversationIds ?? []).map(String)
    }));
}

/**
 * Enumerate every root→leaf path through one section.
 *
 * A `Choice` message does not carry its own text; the player's line lives in
 * each option, so an option is injected into the trail as a synthetic
 * player-side message before its branch continues.
 *
 * @param {Record<string, any>} store - the section's `Messages` map.
 * @param {string} startId - the section's `StartingMessageId`.
 * @param {number} [cap] - maximum paths to enumerate.
 * @returns {Array<Array<any>>} the paths, each an ordered message list.
 */
export function enumeratePaths(store, startId, cap = PATH_CAP) {
  const out = [];
  const walk = (id, trail) => {
    if (out.length >= cap) return;
    let cursor = id === undefined ? undefined : String(id);
    const local = [...trail];
    const guard = new Set();
    while (cursor !== undefined && cursor !== '' && !guard.has(cursor)) {
      guard.add(cursor);
      const message = store[cursor];
      if (message === undefined) break;

      if (message.MessageType === 'Choice') {
        for (const choice of message.Choices ?? []) {
          if (typeof choice?.Text !== 'string') continue;
          const synthetic = {
            Id: `${message.Id}:${String(choice.NextMessageId ?? '')}`,
            SenderType: 'Player',
            SenderContactId: message.SenderContactId,
            MessageType: 'Text',
            Text: choice.Text,
            __fromChoice: true
          };
          walk(choice.NextMessageId, [...local, synthetic]);
        }
        return;
      }

      local.push(message);
      cursor = message.NextMessageId === undefined ? undefined : String(message.NextMessageId);
    }
    out.push(local);
  };
  walk(startId, []);
  return out;
}

/**
 * Turn one path into (user, her reply) pairs.
 *
 * Three rules, each learned from the real data:
 *
 *  - `System` messages are **transparent**. A conversation can run
 *    「player speaks → 消息发送失败 → 用户不在通信服务区内 → her reply」, and
 *    treating that narration as a turn boundary silently drops the pair — which
 *    is exactly what made an earlier version of this adapter report 2 pairs
 *    from 5 conversations.
 *  - A `Choice` option and the `Player` line that follows it are the same turn:
 *    the option is the menu text, the `Player` message is what was actually
 *    sent, and they can differ. The real line wins.
 *  - Only a *different character* speaking ends a pending turn.
 *
 * Her consecutive messages are joined, because the game delivers a multi-line
 * answer as several bubbles and an example should show one reply.
 *
 * @param {Array<any>} path - an ordered message list.
 * @param {Set<string>} herIds - the contact ids that count as "her".
 * @param {string} conversationId - for the `why` field.
 * @returns {Array<{user: string, assistant: string, why: string}>} pairs.
 */
export function turnsFromPath(path, herIds, conversationId) {
  const turns = [];
  let user = null;
  let buffer = [];

  const flush = () => {
    if (user !== null && buffer.length > 0) {
      turns.push({
        user,
        assistant: buffer.join('\n'),
        why: `来自游戏内短信会话 ${conversationId}；同一次会话里可能有多个分支选项，这些是并列的备选，不一定同一次经历`
      });
    }
    buffer = [];
    user = null;
  };

  for (const message of path) {
    // Clean as we read: game text carries `{NICKNAME}`, `[求摸摸]` and inline
    // markup, and none of it belongs in an example.
    const text = typeof message.Text === 'string' ? clean(message.Text, {}) : '';
    if (text === '' || looksLikeNoise(text)) continue;
    const sender = message.SenderType;

    if (sender === 'System') continue;

    const isHer = sender === 'NPC' && herIds.has(String(message.SenderContactId));

    if (sender === 'Player') {
      // The really-sent line replaces whatever the choice menu had queued.
      flush();
      user = text;
    } else if (message.__fromChoice === true || sender === 'PlayerAuto') {
      // Weaker evidence of a player turn: keep it only if nothing is pending.
      if (user === null) user = text;
    } else if (isHer) {
      if (user !== null) buffer.push(text);
    } else {
      // Another contact speaking does end the turn.
      flush();
    }
  }
  flush();
  return turns;
}

/**
 * Extract every attributed message and every turn pair from the conversations.
 * @param {any} conversations - the parsed conversations table.
 * @param {Set<string>} herIds - her contact ids.
 * @param {Record<string, string>} [otherNames] - contact id → display name.
 * @returns {{messages: object[], turns: object[], conversationIds: string[]}} the result.
 */
export function extract(conversations, herIds, otherNames = {}) {
  const list = Array.isArray(conversations) ? conversations : Object.values(conversations ?? {});
  const messages = [];
  const turns = [];
  const conversationIds = [];
  const seenMessage = new Set();

  const relevant = list.filter((conversation) => {
    const store = (conversation?.Sections ?? []).flatMap((section) => Object.values(section.Messages ?? {}));
    return store.some((message) => message?.SenderType === 'NPC' && herIds.has(String(message.SenderContactId)));
  });

  for (const conversation of relevant) {
    conversationIds.push(String(conversation.Id));
    for (const section of conversation.Sections ?? []) {
      const store = section.Messages ?? {};
      for (const message of Object.values(store)) {
        const text = typeof message.Text === 'string' ? clean(message.Text, {}) : '';
        if (text === '' || looksLikeNoise(text)) continue;
        const key = `${conversation.Id}:${message.Id}`;
        if (seenMessage.has(key)) continue;
        seenMessage.add(key);
        const isHer = message.SenderType === 'NPC' && herIds.has(String(message.SenderContactId));
        const speaker = isHer
          ? 'HER'
          : (message.SenderType === 'NPC' ? (otherNames[String(message.SenderContactId)] ?? 'OTHER') : 'Player');
        messages.push({ speaker, text, conversationId: String(conversation.Id) });
      }
      for (const path of enumeratePaths(store, section.StartingMessageId)) {
        turns.push(...turnsFromPath(path, herIds, String(conversation.Id)));
      }
    }
  }

  // Branch enumeration means the same pair can appear down several paths.
  const seenTurn = new Set();
  const uniqueTurns = turns.filter((turn) => {
    const key = `${turn.user}\u0000${turn.assistant}`;
    if (seenTurn.has(key)) return false;
    seenTurn.add(key);
    return true;
  });

  return { messages, turns: uniqueTurns, conversationIds };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

/** Read a valued CLI flag. */
function flag(argv, name, fallback) {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
}

function main() {
  const argv = process.argv.slice(2);
  const contactsPath = flag(argv, 'contacts', '');
  const conversationsPath = flag(argv, 'conversations', '');
  const outDir = resolve(flag(argv, 'out', 'corpus-raw'));
  const aliases = flag(argv, 'aliases', DEFAULT_ALIASES.join(',')).split(',').map((name) => name.trim()).filter(Boolean);

  if (contactsPath === '' || conversationsPath === '') {
    process.stderr.write('usage: node tools/adapters/starrail-messages.mjs --contacts <file> --conversations <file> [--aliases a,b] [--out dir]\n');
    process.exitCode = 1;
    return;
  }
  for (const path of [contactsPath, conversationsPath]) {
    if (!existsSync(path)) {
      process.stderr.write(`missing input: ${path}\n`);
      process.exitCode = 1;
      return;
    }
  }

  const contacts = JSON.parse(readFileSync(contactsPath, 'utf8'));
  const conversations = JSON.parse(readFileSync(conversationsPath, 'utf8'));

  const matched = resolveContacts(contacts, aliases);
  if (matched.length === 0) {
    // A silent empty result is the worst outcome here: the caller would assume
    // she simply has no lines.
    process.stderr.write(`no contact matched ${JSON.stringify(aliases)} — check the alias spelling and the language folder\n`);
    process.exitCode = 1;
    return;
  }

  const names = {};
  for (const contact of (Array.isArray(contacts) ? contacts : Object.values(contacts))) {
    names[String(contact.Id)] = String(contact.Name);
  }

  const herIds = new Set(matched.map((contact) => contact.id));
  const { messages, turns, conversationIds } = extract(conversations, herIds, names);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'pairs.jsonl'), messages.map((message) => JSON.stringify(message)).join('\n') + (messages.length === 0 ? '' : '\n'));
  writeFileSync(join(outDir, 'turns.yaml'), yaml.dump({ dialogues: turns }, { lineWidth: 200, noRefs: true }));
  writeFileSync(join(outDir, 'contacts.json'), `${JSON.stringify(matched, undefined, 2)}\n`);

  const herMessages = messages.filter((message) => message.speaker === 'HER').length;
  process.stdout.write(`\n匹配到 ${matched.length} 个联系人：\n`);
  for (const contact of matched) {
    process.stdout.write(`  Id ${contact.id}  ${contact.name}  签名「${contact.signature}」  版本 ${contact.versionAdded}\n`);
  }
  process.stdout.write(`\n会话 ${conversationIds.length} 个：${conversationIds.join(', ')}\n`);
  process.stdout.write(`台词 ${messages.length} 条（其中她的 ${herMessages} 条）\n`);
  process.stdout.write(`双向对话对 ${turns.length} 组\n`);
  process.stdout.write(`\n产物 ${outDir}\\\n`);
  process.stdout.write('  pairs.jsonl     说话人 + 台词，喂给 tools/ingest.mjs\n');
  process.stdout.write('  turns.yaml      dialogues: 格式，可直接并入 dialogues.yaml\n');
  process.stdout.write('  contacts.json   匹配到的联系人（含签名，可作人设细节）\n');
  process.stdout.write(`\n下一步：node tools/ingest.mjs --in ${join(outDir, 'pairs.jsonl')} --aliases HER --out corpus\n`);
  process.stdout.write('        然后看 corpus/style-profile.md，并把 turns.yaml 的条目挑进 dialogues.yaml\n');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
