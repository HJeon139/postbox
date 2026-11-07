// The conversation search’s index (#866, W4): it scores as shared/bm25.mjs does, and one item’s change rewrites only
// that item’s entry.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIndex, search } from '../shared/bm25.mjs';
import { SearchIndex } from '../shared/search-index.mjs';
import { searchText } from '../shared/search-text.mjs';

const DOCS = [
  { id: 'a', text: 'The gate failed on the browser runs, then passed after the lock was free.' },
  { id: 'b', text: 'Search the conversation for a word that only one old message has: zeppelin.' },
  { id: 'c', text: 'The browser runs passed. The gate passed. Zeppelin appears here too, once.' },
  { id: 'd', text: 'Nothing about any of that in this one, only the window and its spacers.' },
];

test('#866 W4 the index ranks a conversation as shared/bm25.mjs does', () => {
  const ix = new SearchIndex();
  for (const d of DOCS) ix.put(d.id, d.text);
  for (const q of ['browser gate', 'zeppelin', 'window spacers', 'passed lock']) {
    const want = search(buildIndex(DOCS), q).map((h) => [h.id, h.score.toFixed(9), h.terms.join()]);
    const got = ix.search(q).map((h) => [h.id, h.score.toFixed(9), h.terms.join()]);
    assert.deepEqual(got, want, q);
  }
});

test('#866 W4 an item put again rewrites one entry, and finds its new words, not its old ones', () => {
  const ix = new SearchIndex();
  for (const d of DOCS) ix.put(d.id, d.text);
  const before = ix.writes;
  ix.put('d', 'Now this one mentions a zeppelin as well.');
  assert.equal(ix.writes - before, 1, 'one entry written');
  assert.ok(ix.search('zeppelin').some((h) => h.id === 'd'));
  assert.equal(ix.search('spacers').length, 0, 'the old words are gone');
  // And the totals match a fresh build over the new texts.
  const fresh = [...DOCS.slice(0, 3), { id: 'd', text: 'Now this one mentions a zeppelin as well.' }];
  assert.deepEqual(ix.search('zeppelin'), search(buildIndex(fresh), 'zeppelin'));
});

test('#866 W4 a dropped item, or one put with no words, leaves no entry and no counts', () => {
  const ix = new SearchIndex();
  ix.put('a', 'zeppelin zeppelin');
  ix.put('b', '');
  ix.drop('a');
  assert.equal(ix.entries.size, 0);
  assert.equal(ix.df.size, 0);
  assert.equal(ix.totalLen, 0);
  assert.deepEqual(ix.search('zeppelin'), []);
});

test('#866 W4 what an item is searched by: what it shows, not tool output, and nothing while streaming or replaced', () => {
  assert.equal(searchText({ kind: 'agent', text: 'Hello there' }), 'Hello there');
  assert.equal(searchText({ kind: 'agent', text: 'half a reply', status: 'streaming' }), '');
  assert.equal(searchText({ kind: 'agent', text: 'the replayed start', status: 'replaced' }), '');
  assert.equal(searchText({ kind: 'tool', text: 'npm run check output' }), '');
  const block = (b) => searchText({ kind: 'block', valid: true, block: b });
  assert.match(
    block({ type: 'card', title: 'T', body: 'card body', facts: [{ label: 'Head', value: 'abc' }], fallback: 'f' }),
    /card body[\s\S]*Head[\s\S]*abc/,
  );
  assert.match(
    block({ type: 'choice', prompt: 'Pick', options: [{ id: 'x', label: 'Option X', description: 'about x' }], fallback: 'f' }),
    /Option X[\s\S]*about x/,
  );
  assert.match(block({ type: 'form', fields: [{ id: 'q', label: 'Who reads it?', kind: 'text' }], fallback: 'f' }), /Who reads it\?/);
  assert.match(block({ type: 'review', format: 'markdown', content: 'the draft text', fallback: 'f' }), /the draft text/);
  assert.match(block({ type: 'code', code: 'const zeppelin = 1', fallback: 'f' }), /zeppelin/);
  assert.equal(block({ type: 'app', title: 'Explorer', fallback: 'its sandboxed content' }), 'Explorer');
  assert.equal(searchText({ kind: 'block', valid: false, block: { type: 'card', title: 'bad' } }), '');
});
