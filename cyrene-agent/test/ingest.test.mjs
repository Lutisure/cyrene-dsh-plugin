/**
 * Tests for the ingest tool.
 *
 * These concentrate on the two things that fail *silently*: the markup cleaner
 * (an over-eager rule eats real dialogue) and the statistics (a wrong rule
 * produces a confident number that is simply false, which then gets written
 * into persona.yaml as if it were measured).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clean,
  countMarks,
  describeLength,
  registerWeight,
  detectFormat,
  isTargetSpeaker,
  looksLikeNoise,
  parsePairs,
  parseText,
  parseTextMap,
  processPairs,
  profile,
  selectDiverse
} from '../tools/ingest.mjs';

test('clean strips ruby annotations but keeps the surface text', () => {
  const tally = {};
  assert.equal(clean('{RUBY_B#xī lián}昔涟{RUBY_E#}，这是我的名字。', tally), '昔涟，这是我的名字。');
  // An annotation whose closing tag is missing must not eat the rest of the line.
  assert.equal(clean('{RUBY_B#reading}正文', tally), '正文');
});

test('clean strips formatting tags and engine variables', () => {
  const tally = {};
  assert.equal(clean('<color=#ff99e5>别急</color>，慢慢来。', tally), '别急，慢慢来。');
  assert.equal(clean('<unbreak>光</unbreak>就是一点点亮起来的', tally), '光就是一点点亮起来的');
  assert.equal(clean('{TEXTJOIN#12}这个我记得的', tally), '这个我记得的');
  assert.equal(clean('{MISSION_NAME}开始了', tally), '开始了');
});

test('an address placeholder becomes 「你」 instead of disappearing', () => {
  const tally = {};
  // Deleting it produced 「嘻，那就期待的精彩表现啦」 — no addressee, no grammar,
  // and it shipped as an example of how she speaks.
  assert.equal(clean('嘻，那就期待{NICKNAME}的精彩表现啦', tally), '嘻，那就期待你的精彩表现啦');
  assert.equal(clean('{PLAYERNAME}，你看', tally), '你，你看');
  assert.equal(tally['name-placeholder'], 2);
});

test('emote markers are stripped, real brackets are not', () => {
  const tally = {};
  assert.equal(clean('嘻，那就期待你的精彩表现啦\n[求摸摸]', tally), '嘻，那就期待你的精彩表现啦');
  assert.equal(clean('[得意]当然啦', tally), '当然啦');
  assert.equal(tally['emote-marker'], 2);
  // A Latin or mixed bracket is left alone rather than guessed at.
  assert.equal(clean('看这个 [note] 就行', tally), '看这个 [note] 就行');
  // Full-width brackets are ordinary punctuation in Chinese, not markup.
  assert.equal(clean('【旁白】她笑了', tally), '【旁白】她笑了');
});

test('clean does not eat ordinary punctuation or braces-free prose', () => {
  const tally = {};
  const line = '「你来了呀……」她轻轻地说，声音像一串音符♪';
  assert.equal(clean(line, tally), line);
});

test('clean reports which rules fired', () => {
  const tally = {};
  clean('<color=#fff>a</color>{TEXTJOIN#1}b{RUBY_B#r}c{RUBY_E#}', tally);
  assert.ok(tally['color-tag'] >= 1);
  assert.ok(tally['engine-var'] >= 1);
  assert.ok(tally.ruby >= 1);
});

test('Markdown-ish angle brackets in real dialogue survive', () => {
  // A line that legitimately uses ‹...› style wording must not be mangled, and
  // anything left over should be flagged rather than deleted.
  const tally = {};
  const result = clean('他说「速度 < 光速」', tally);
  assert.ok(result.includes('光速'), result);
});

test('speaker matching accepts aliases and rejects other characters', () => {
  assert.equal(isTargetSpeaker('昔涟'), true);
  assert.equal(isTargetSpeaker('昔漣'), true, 'traditional form');
  assert.equal(isTargetSpeaker('昔涟（迷迷）'), true, 'suffixed form');
  assert.equal(isTargetSpeaker('三月七'), false);
  assert.equal(isTargetSpeaker(''), false);
  assert.equal(isTargetSpeaker('Cyrene'), true);
  assert.equal(isTargetSpeaker('Cyrene', ['cyrene']), true, 'matching is case-insensitive');
});

test('processPairs keeps only her lines and explains every drop', () => {
  const pairs = [
    { speaker: '昔涟', text: '你来了呀……我等了好一会儿呢。' },
    { speaker: '三月七', text: '这里好漂亮！' },
    { speaker: '昔涟', text: '嗯。' },
    { speaker: '昔涟', text: '你来了呀……我等了好一会儿呢。' },
    { speaker: '昔涟', text: '{RUBY_B#r}昔涟{RUBY_E#}，这是我的名字。' }
  ];
  const result = processPairs(pairs);

  assert.deepEqual(result.kept.map((entry) => entry.text), [
    '你来了呀……我等了好一会儿呢。',
    '昔涟，这是我的名字。'
  ]);
  // Her short line is a reject with a reason; another character is not a reject
  // at all, and the duplicate is neither.
  assert.deepEqual(result.rejects, [{ reason: 'too-short', text: '嗯。' }]);
  assert.equal(result.dropped, 3);
  assert.equal(result.attributed, true);
});

test('an unattributed dump keeps everything and says so', () => {
  const result = processPairs([{ speaker: '', text: '随便一句台词' }]);
  assert.equal(result.attributed, false);
  assert.equal(result.kept.length, 1, 'without speakers nothing can be filtered, so nothing is');
});

test('UI-looking text is dropped, but not when asked to keep it', () => {
  assert.equal(looksLikeNoise('……'), true);
  assert.equal(looksLikeNoise('12345'), true);
  assert.equal(looksLikeNoise('昔涟'), true, 'a bare name is not dialogue');
  assert.equal(looksLikeNoise('你来了呀'), false);

  const pairs = [{ speaker: '昔涟', text: '…………' }];
  assert.equal(processPairs(pairs).kept.length, 0);
  assert.equal(processPairs(pairs, { keepNoise: true }).kept.length, 1);
});

test('a marker this tool does not know is flagged, never silently deleted', () => {
  const result = processPairs([{ speaker: '昔涟', text: '{SOMETHING_NEW#9}你来了' }]);
  // The engine-var rule handles it, so nothing is left over here.
  assert.equal(result.kept[0].text, '你来了');
  assert.equal(result.kept[0].suspicious, false);

  const odd = processPairs([{ speaker: '昔涟', text: '你<unknown-tag>好' }]);
  assert.equal(odd.kept[0].suspicious, true, 'an unrecognised form must be surfaced for review');
  assert.ok(odd.kept[0].text.includes('好'));
});

test('every input format is parsed, and auto-detection picks the right one', () => {
  assert.equal(detectFormat('{"a":"b"}'), 'textmap');
  assert.equal(detectFormat('[{"speaker":"x","text":"y"}]'), 'pairs');
  assert.equal(detectFormat('{"speaker":"x","text":"y"}'), 'pairs');
  assert.equal(detectFormat('昔涟：你来了'), 'text');

  assert.deepEqual(parsePairs('{"speaker":"昔涟","text":"甲"}\n{"speaker":"昔涟","text":"乙"}'), [
    { speaker: '昔涟', text: '甲' },
    { speaker: '昔涟', text: '乙' }
  ]);
  assert.deepEqual(parseTextMap('{"1001":"甲"}'), [{ speaker: '', text: '甲', id: '1001' }]);
});

test('plain-text dumps are split on the usual speaker prefixes', () => {
  const parsed = parseText('【昔涟】你来了呀\n三月七：这里好漂亮\n昔涟「光就是一点点亮起来的」\n没有前缀的一句');
  assert.deepEqual(parsed[0], { speaker: '昔涟', text: '你来了呀' });
  assert.deepEqual(parsed[1], { speaker: '三月七', text: '这里好漂亮' });
  assert.deepEqual(parsed[2], { speaker: '昔涟', text: '光就是一点点亮起来的' });
  assert.deepEqual(parsed[3], { speaker: '', text: '没有前缀的一句' });
});

/* ------------------------------------------------------------------ *
 * Statistics: the part that produces confident wrong numbers
 * ------------------------------------------------------------------ */

test('overlapping ellipsis marks are not double counted', () => {
  const table = countMarks(['你来了呀……我等了好一会儿呢。']);
  const byMark = Object.fromEntries(table.map((entry) => [entry.mark, entry.occurrences]));
  assert.equal(byMark['……'], 1);
  // `……` contains two `…`; counting them again would report 3 ellipses in a
  // line that has one.
  assert.equal(byMark['…'], undefined);
  assert.equal(byMark['。'], 1);
});

test('a sentence-final particle is found even when punctuation follows it', () => {
  // `好呀……` ends in an ellipsis on the page, but the particle is 呀. And in
  // `你来了呀……我等了好一会儿呢。` the particle that ends the *line* is 呢,
  // not the 呀 in the middle.
  const measure = profile(['好呀……', '你来了呀……我等了好一会儿呢。', '好呀。', '是吗？']);
  const particles = Object.fromEntries(measure.endings.map((entry) => [entry.particle, entry.count]));
  assert.equal(particles['呀'], 2);
  assert.equal(particles['呢'], 1);
});

test('a question is detected mid-line, not only at the end', () => {
  const measure = profile(['真的吗？那太好了！', '这是一句陈述。', '你在做什么', '我什么都不知道']);
  // `真的吗？…` has a question mark, and `你在做什么` ends in an interrogative
  // without one. `我什么都不知道` must NOT count — 什么 is mid-line there.
  assert.equal(measure.questionShare, 0.5);
});

test('Latin fragments from a stray English line do not pollute the phrase list', () => {
  const measure = profile(['little light', 'little light', 'little light', '光就是一点点亮起来的', '光就是一点点亮起来的', '光就是一点点亮起来的']);
  const grams = measure.topGrams.map(([gram]) => gram);
  assert.ok(grams.every((gram) => !/[A-Za-z]/u.test(gram)), `expected no Latin grams, got ${JSON.stringify(grams)}`);
  assert.ok(grams.some((gram) => gram.includes('光')), `expected a Chinese gram, got ${JSON.stringify(grams)}`);
});

test('the profile reports the shape of the line-length distribution', () => {
  const measure = profile(['短短', '中等长度的一句话', '这是一句明显更长一些的台词，用来拉开分布']);
  assert.equal(measure.count, 3);
  // Lengths are 2, 8, 20 code points; the median is the middle one.
  assert.equal(measure.median, 8);
  assert.equal(measure.max, 20);
  assert.ok(measure.shortShare > 0 && measure.shortShare < 1);
});

test('the length description follows the measurement instead of contradicting it', () => {
  // This is the bug the real corpus exposed: a median of 19 characters with a
  // 21% short-line share was still being described as "mostly short sentences".
  assert.equal(describeLength({ median: 8 }), '以短句为主');
  assert.equal(describeLength({ median: 19 }), '句长中等，短句与中句混用');
  assert.equal(describeLength({ median: 40 }), '长句为主，句中常有多层逗号连接');

  const long = profile([
    '这是一句相当长的台词，句中用了好几个逗号来连接不同的分句，整体读起来是连绵的',
    '这也是比较长的一句，同样以逗号连接，直到最后才收住'
  ]);
  assert.ok(long.median > 20, String(long.median));
  assert.ok(!describeLength(long).includes('短句为主'), `got ${describeLength(long)}`);
});

/* ------------------------------------------------------------------ *
 * Sample selection
 * ------------------------------------------------------------------ */

test('selection prefers variety over near-duplicates', () => {
  const lines = [
    '光就是一点点亮起来的',
    '光就是一点点亮起来',
    '光就是一点点亮起来的呀',
    '你来了呀，我等了好一会儿呢',
    '别急，慢慢来哦',
    '真的吗？那太好了！'
  ];
  const picked = selectDiverse(lines, 4);
  assert.equal(picked.length, 4);
  // The three paraphrases of the same line must not all be chosen.
  const lightLines = picked.filter((line) => line.startsWith('光就是一点点亮起来'));
  assert.ok(lightLines.length <= 2, `expected variety, got ${JSON.stringify(picked)}`);
  // Selection is deterministic.
  assert.deepEqual(selectDiverse(lines, 4), picked);
});

test('selection never returns more than it was asked for', () => {
  assert.equal(selectDiverse(['甲甲甲', '乙乙乙'], 10).length, 2);
  assert.deepEqual(selectDiverse([], 5), []);
});


/* ------------------------------------------------------------------ *
 * Voice-sample register
 *
 * The diversity score alone optimises for lexical rarity, and on the story corpus
 * that pulled in tarot-card exposition — her vocabulary, not her voice. These
 * tests pin the weighting that fixed it, because the failure mode is invisible:
 * the samples still look plausible, they just teach the wrong register.
 * ------------------------------------------------------------------ */

test('registerWeight rewards the particles and tics she actually uses', () => {
  const plain = registerWeight('它象征着新生和希望');
  const speaking = registerWeight('嘻，那就期待你的精彩表现啦');

  assert.ok(speaking.weight > plain.weight, 'a spoken line must outrank an explanatory one');
  assert.ok(speaking.hits.includes('particle'), 'a sentence-final particle is the strongest signal');
  assert.ok(speaking.hits.includes('laugh'));
  assert.ok(plain.hits.includes('exposition'), 'the explanatory verbs have to be recognised');
});

test('registerWeight does not punish a line just for being long or factual', () => {
  // The penalty is aimed at one specific failure, so it must not become a general
  // "short and emotional wins" filter — a plain but unmistakably hers line such as
  // 「名为「昔涟」的少女，怎么会轻易离开呢~」 still has to score well.
  const hers = registerWeight('名为「昔涟」的少女，怎么会轻易离开呢~');
  assert.ok(hers.weight > 1.2, `expected a strong score, got ${hers.weight}`);
  assert.ok(hers.hits.includes('musical'));

  // And a line with none of the markers stays at the neutral weight rather than
  // being pushed down. (No 你 in it: second person is itself a marker, so
  // 「我在这里等你」 legitimately scores above 1 — which is how this assertion was
  // wrong the first time.)
  const neutral = registerWeight('山下的村庄很安静');
  assert.equal(neutral.weight, 1);
  assert.deepEqual(neutral.hits, []);
});

test('selectDiverse prefers her register when both are equally unusual', () => {
  const lines = [
    '它象征着新生和希望，却也容易让人联想到挫折、悲伤和空虚。',
    '嘻，你猜…人家心中最满意的搭配是什么？',
    '「君王」牌通常象征着纪律、权威和荣耀，但往往也和孤独画等号。',
    '让我猜猜…你是不是以为人家藏起来了，想问人家躲在哪里呀？'
  ];
  const picked = selectDiverse(lines, 2);
  const joined = picked.join('|');
  assert.ok(joined.includes('嘻，你猜'), `expected her spoken lines, got ${joined}`);
  assert.ok(joined.includes('让我猜猜'), `expected her spoken lines, got ${joined}`);
  assert.ok(!joined.includes('象征着'), 'exposition must not win on rarity alone');
});

test('selectDiverse still returns the requested count when everything is exposition', () => {
  // The weighting must reorder, not filter: a corpus of nothing but exposition is
  // still better than an empty sample block.
  const lines = Array.from({ length: 5 }, (_, i) => `第${i}条：它象征着某种通常的、往往被包括在内的意味。`);
  assert.equal(selectDiverse(lines, 3).length, 3);
});
