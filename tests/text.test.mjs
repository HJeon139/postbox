import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIndex, search, semanticStub, tokenize } from '../shared/bm25.mjs';
import { finishedSentences, formatDuration, parseMentions } from '../shared/text.mjs';
import { isSafeUrl } from '../shared/urls.mjs';

test('mentions: known handles only, in order, not in code or emails', () => {
  const h = ['indexer', 'researcher', 'critic'];
  assert.deepEqual(parseMentions('@researcher ask @Indexer and @nobody', h), ['researcher', 'indexer']);
  assert.deepEqual(parseMentions('mail x@critic.com or `@critic`', h), []);
  assert.deepEqual(parseMentions('@critic @critic', h), ['critic']);
});

test('finished sentences are announced once, and the tail on completion', () => {
  let r = finishedSentences('Yes. Prefaces are easy to spot', 0);
  assert.deepEqual(r.sentences, ['Yes.']);
  r = finishedSentences('Yes. Prefaces are easy to spot. So I', r.spoken);
  assert.deepEqual(r.sentences, ['Prefaces are easy to spot.']);
  r = finishedSentences('Yes. Prefaces are easy to spot. So I will.', r.spoken);
  assert.deepEqual(r.sentences, []);
  r = finishedSentences('Yes. Prefaces are easy to spot. So I will.', r.spoken, true);
  assert.deepEqual(r.sentences, ['So I will.']);
});

test('durations read like Postbox shows them', () => {
  assert.equal(formatDuration(300), '0.3 s');
  assert.equal(formatDuration(12400), '12 s');
  assert.equal(formatDuration(6 * 60000), '6 min');
  assert.equal(formatDuration(65 * 60000), '1 h 5 min');
});

test('URL checks', () => {
  assert.ok(isSafeUrl('https://arxiv.org/abs/2210.03629'));
  assert.ok(!isSafeUrl('javascript:alert(1)'));
  assert.ok(!isSafeUrl('data:text/html,hi'));
  assert.ok(!isSafeUrl('/relative'));
  assert.ok(!isSafeUrl('https://user:pw@example.com'));
  assert.ok(!isSafeUrl('https://a.example/x', { origins: ['https://b.example'] }));
});

test('BM25 ranks the passage that uses the word most specifically', () => {
  const idx = buildIndex([
    { id: 'a', text: 'You pierce my soul. I am half agony, half hope.' },
    { id: 'b', text: 'Whenever it is a damp, drizzly November in my soul.' },
    { id: 'c', text: 'Hope is the thing; hope again and hope always, a long text about many other things entirely.' },
  ]);
  const hits = search(idx, 'hope');
  assert.deepEqual(hits.map((h) => h.id).sort(), ['a', 'c']);
  assert.deepEqual(hits[0].terms, ['hope']);
  assert.deepEqual(search(idx, 'the and of'), []);
});

test('tokenize drops stop words and possessives', () => {
  assert.deepEqual(tokenize("The whale's soul, and the SEA"), ['whale', 'soul', 'sea']);
});

test('the semantic stub finds related words, scored 0 to 1', () => {
  assert.ok(semanticStub('we should die of that roar which lies on the other side of silence', 'hope after loss') > 0);
  assert.equal(semanticStub('nothing related here', 'hope'), 0);
  assert.equal(semanticStub('half agony, half hope', 'hope'), 1);
});
