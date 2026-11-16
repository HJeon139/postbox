// The page holds an agent’s inbox only as far as it can act on it (shared/inbox-page.mjs): /api/state leaves delivered
// entries out, and the page drops one as the stream says it was delivered, so a page left open doesn’t grow with them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOnPage as hear } from '../shared/inbox-page.mjs';
import { emptyState } from '../shared/state.mjs';

test('a page that hears 10,000 entries delivered holds none of them, and keeps the one still waiting', () => {
  const state = emptyState();
  hear(state, 'entry.add', { sessionId: 'se_b', entry: { id: 'en_w', threadId: 'th_c', source: 'mention', itemId: 'it_w', state: 'waiting' } });
  for (let i = 0; i < 10_000; i++) {
    hear(state, 'entry.add', { sessionId: 'se_b', entry: { id: `en_${i}`, threadId: 'th_c', source: 'mention', itemId: `it_${i}`, state: 'waiting' } });
    hear(state, 'entry.patch', { sessionId: 'se_b', id: `en_${i}`, patch: { state: 'taken', takenBy: `tu_${i}` } });
    hear(state, 'entry.patch', { sessionId: 'se_b', id: `en_${i}`, patch: { state: 'delivered' } });
  }
  assert.deepEqual(
    state.inbox.se_b.map((e) => e.id),
    ['en_w'],
  );
});

test('an inbox whose last entry is delivered leaves the page’s state', () => {
  const state = emptyState();
  hear(state, 'entry.add', { sessionId: 'se_b', entry: { id: 'en_1', threadId: 'th_c', source: 'mention', itemId: 'it_1', state: 'waiting' } });
  hear(state, 'entry.patch', { sessionId: 'se_b', id: 'en_1', patch: { state: 'delivered' } });
  assert.equal(state.inbox.se_b, undefined);
});
