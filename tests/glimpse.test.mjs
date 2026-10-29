import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { GLIMPSE_CHARS, GLIMPSE_SOURCE_CHARS } from '../shared/limits.mjs';
import { appendGlimpseSource, glimpseOf } from '../shared/text.mjs';

test('#478 a long thinking stream keeps its latest whole sentences within the glimpse bound', () => {
  const old = 'This earlier investigation no longer belongs in the working row. '.repeat(8);
  const latest = 'The implementation now passes its focused checks. I am reading the final report before review.';
  const glimpse = glimpseOf(old + latest);

  assert.equal(glimpse, latest);
  assert.ok(glimpse.length <= GLIMPSE_CHARS);
  assert.ok(!glimpse.startsWith('…'));
  assert.ok(!glimpse.endsWith('…'));
  assert.equal(glimpseOf(`${'Discarded sentence. '.repeat(GLIMPSE_SOURCE_CHARS)}${latest}`), latest, 'only the bounded tail affects the result');
});

test('#478 streamed pieces keep spaces and sentence boundaries before making a glimpse', () => {
  let source = '';
  for (const piece of ['I read the file. ', 'Next I check', ' the tests.', ' Done.']) source = appendGlimpseSource(source, piece);

  assert.equal(source, 'I read the file. Next I check the tests. Done.');
  assert.equal(glimpseOf(source), 'Next I check the tests. Done.');
});

test('#478 Claude’s stream mapper keeps sentence boundaries across text deltas', () => {
  let now = 0;
  const statuses = [];
  const mapper = createStreamMapper({ state: {}, status: (patch) => statuses.push(patch), text() {}, activity() {} }, { now: () => (now += 500) });
  mapper.push({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
  for (const text of ['I read the file. ', 'Next I check', ' the tests.', ' Done.'])
    mapper.push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });

  assert.equal(statuses.filter((status) => status.glimpse).at(-1).glimpse, 'Next I check the tests. Done.');
});

test('#478 CJK sentence endings keep the latest complete sentences', () => {
  const sentence = '这是第一句话。';
  assert.equal(glimpseOf(sentence.repeat(30)), sentence.repeat(2));
  assert.equal(glimpseOf('最初的文。次の文！最後の文？'), '次の文！最後の文？');
});

test('#478 an overlong sentence is bounded with an ellipsis even without word breaks', () => {
  const glimpse = glimpseOf(`The ${'carefully '.repeat(40)}written conclusion is ready.`);

  assert.equal(glimpse.length, GLIMPSE_CHARS);
  assert.match(glimpse, /^The carefully /);
  assert.ok(glimpse.endsWith('…'));
  assert.equal(glimpseOf('x'.repeat(GLIMPSE_CHARS + 1)), `${'x'.repeat(GLIMPSE_CHARS - 1)}…`);
  assert.match(glimpseOf(`Short one. Here: https://example.com/${'a'.repeat(200)}`), /^Here: https:\/\/example\.com\/a+…$/);
});
