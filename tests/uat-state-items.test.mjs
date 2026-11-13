// The UAT runner’s state (tools/uat/state-items.mjs): /api/state carries no conversation’s items since #1155, so the
// runner fills them in from each thread’s items route, or every check and trigger that reads state.items sees none.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withItems } from '../tools/uat/state-items.mjs';

test('the runner’s state holds every thread’s items, read from its items route', async () => {
  const asked = [];
  const get = async (path) => {
    asked.push(path);
    return { items: [{ id: `it-${path.split('/')[3]}`, kind: 'user' }] };
  };
  const state = await withItems({ threads: { th_a: {}, 'th b': {} }, items: {} }, get);
  assert.deepEqual(state.items, { th_a: [{ id: 'it-th_a', kind: 'user' }], 'th b': [{ id: 'it-th%20b', kind: 'user' }] });
  assert.deepEqual(asked.sort(), ['/api/threads/th%20b/items?limit=all', '/api/threads/th_a/items?limit=all']);
});

test('a thread deleted between the state and its items read has no items, and the rest still do', async () => {
  const get = async (path) => (path.includes('gone') ? { error: 'That conversation doesn’t exist.' } : { items: [{ id: 'x' }] });
  const state = await withItems({ threads: { gone: {}, here: {} }, items: {} }, get);
  assert.deepEqual(state.items, { gone: [], here: [{ id: 'x' }] });
});
