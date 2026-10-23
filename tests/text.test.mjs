import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIndex, search, semanticStub, tokenize } from '../shared/bm25.mjs';
import { finishedSentences, formatDuration, parseMentions, plainText, spokenSentences } from '../shared/text.mjs';
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

test('#196: a dot inside a word doesn’t end a sentence, and nothing before it is dropped', () => {
  const said = (t) => finishedSentences(t, 0, true).sentences;
  // The manual UAT’s reply, which was read as “py`**: …”, “md is here.” and “0`.”.
  assert.deepEqual(said('- **`converter.py`**: and more. README.md is here. Prints `6.21371 77.0`.'), [
    '- **`converter.py`**: and more.',
    'README.md is here.',
    'Prints `6.21371 77.0`.',
  ]);
  assert.deepEqual(said('Postbox v0.13.0 is out. It reads 6.21371 now.'), ['Postbox v0.13.0 is out.', 'It reads 6.21371 now.']);
  assert.deepEqual(said('Some, e.g. this one, stay whole. Next.'), ['Some, e.g. this one, stay whole.', 'Next.']);
  assert.deepEqual(said('See README.md. Then run it.'), ['See README.md.', 'Then run it.']);
  // Streaming: “converter.” isn’t finished until what follows it shows it’s a word.
  assert.deepEqual(finishedSentences('Open converter.', 0).sentences, []);
  assert.deepEqual(finishedSentences('Open converter.py now. And', 0).sentences, ['Open converter.py now.']);
});

test('#196: a screen reader hears plain text: no code ticks, emphasis, heading marks, bullets or link addresses', () => {
  const reply = [
    '## Results',
    '- **`converter.py`**: `km_to_miles` and *celsius_to_fahrenheit*.',
    '1. See [the docs](https://example.com/a.b) for ~~more~~ less.',
    '```js',
    'const a = 1;',
    '```',
    '> A quote, with __bold__.',
  ].join('\n');
  const said = spokenSentences(reply, 0, true).sentences;
  assert.deepEqual(said, ['Results', 'converter.py: km_to_miles and celsius_to_fahrenheit.', 'See the docs for more less.', 'A quote, with bold.']);
  // Underscores inside a name such as km_to_miles are the name’s.
  assert.doesNotMatch(said.join(' '), /[`*#~[\]>]|https?:|\b_|_\b/);
  // Raw HTML is text in a reply, so it’s heard as written.
  assert.equal(plainText('Tom &amp; <b>Jerry</b>'), 'Tom &amp; <b>Jerry</b>');
});

test('#196: a streaming reply announces each sentence once, when it’s finished', () => {
  const full = 'Open **`converter.py`**. It prints `6.21371`.\n```\nx.y\n```\nDone, e.g. now.';
  let spoken = 0;
  const heard = [];
  for (let n = 1; n <= full.length; n++) {
    const r = spokenSentences(full.slice(0, n), spoken);
    spoken = r.spoken;
    heard.push(...r.sentences);
  }
  heard.push(...spokenSentences(full, spoken, true).sentences);
  assert.deepEqual(heard, ['Open converter.py.', 'It prints 6.21371.', 'Done, e.g. now.']);
});

test('#196: a fence indented in a list closes, inline backticks aren’t a fence, and code keeps its marks', () => {
  const list = 'Steps:\n- Run it:\n    ```sh\n    ls\n    ```\n- Then check. Done.';
  assert.deepEqual(spokenSentences(list, 0, true).sentences, ['Steps:', 'Run it:', 'Then check.', 'Done.']);
  // Streamed, “```x```” mid-line doesn’t hold the sentences after it back until the reply ends.
  const full = 'Done. ```x``` is the tool.\nMore text here. And more.';
  let spoken = 0;
  const heard = [];
  for (let n = 1; n <= full.length; n++) {
    const r = spokenSentences(full.slice(0, n), spoken);
    spoken = r.spoken;
    if (n < full.length) heard.push(...r.sentences);
  }
  assert.deepEqual(heard, ['Done.', 'x is the tool.', 'More text here.']);
  assert.equal(plainText('Run `__init__.py` now.'), 'Run __init__.py now.');
});

test('#196: a table is heard as its cells, and a link whose text has a full stop as one sentence, without its URL', () => {
  const table = 'Results:\n| Book | Score |\n|---|---|\n| **Emma** | 3.5 |\nDone.';
  assert.deepEqual(spokenSentences(table, 0, true).sentences, ['Results:', 'Book, Score', 'Emma, 3.5', 'Done.']);
  const link = 'Read [the guide. It helps](https://example.com/a.b) first. Then go.';
  assert.deepEqual(spokenSentences(link, 0, true).sentences, ['Read the guide. It helps first.', 'Then go.']);
  // A bracket that never closes holds the sentence only to the end of its line.
  assert.deepEqual(finishedSentences('A stray [ bracket. Next.\nNew line.', 0, true).sentences, ['A stray [ bracket. Next.', 'New line.']);
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
