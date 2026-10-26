// Focused regressions for translating Codex app-server items into Postbox turn events.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodexMapper } from '../server/adapters/codex.mjs';

test('a completed Codex web search closes the running activity step', () => {
  const activity = [];
  const mapper = createCodexMapper({
    activity: (event) => activity.push(event),
    status: () => {},
    text: () => {},
    state: {},
  });
  mapper.push({ method: 'item/started', params: { item: { id: 'search_1', type: 'webSearch', query: 'Postbox' } } });
  mapper.push({ method: 'item/completed', params: { item: { id: 'search_1', type: 'webSearch', query: 'Postbox', status: 'completed' } } });

  assert.deepEqual(activity, [
    { id: 'search_1', label: 'Search the web: Postbox', state: 'running', kind: 'tool' },
    { id: 'search_1', label: 'Search the web: Postbox', state: 'done', kind: 'tool' },
  ]);
});
