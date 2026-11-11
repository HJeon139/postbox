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

  // Labeled as every backend’s web search is (server/tool-labels.mjs).
  assert.deepEqual(
    activity.map((a) => [a.id, a.label, a.state]),
    [
      ['search_1', 'Searched the web for “Postbox”', 'running'],
      ['search_1', 'Searched the web for “Postbox”', 'done'],
    ],
  );
});

test('separate Codex agent messages keep a paragraph break in the reply', () => {
  let text = '';
  const mapper = createCodexMapper({
    activity: () => {},
    status: () => {},
    text: (delta) => {
      text += delta;
    },
    state: {},
  });
  mapper.push({ method: 'item/agentMessage/delta', params: { itemId: 'message_1', delta: 'A.' } });
  mapper.push({ method: 'item/completed', params: { item: { id: 'message_1', type: 'agentMessage', text: 'A.' } } });
  mapper.push({ method: 'item/completed', params: { item: { id: 'message_2', type: 'agentMessage', text: 'B.' } } });

  assert.equal(text, 'A.\n\nB.');
});

test('a web search gets its query when Codex reports it only at completion', () => {
  const activity = [];
  const mapper = createCodexMapper({
    activity: (event) => activity.push(event),
    status: () => {},
    text: () => {},
    state: {},
  });
  mapper.push({ method: 'item/started', params: { item: { id: 'search_late', type: 'webSearch' } } });
  mapper.push({ method: 'item/completed', params: { item: { id: 'search_late', type: 'webSearch', query: 'late query', status: 'completed' } } });

  assert.deepEqual(
    activity.map((a) => [a.id, a.label, a.state]),
    [
      ['search_late', 'Searching the web', 'running'],
      ['search_late', 'Searched the web for “late query”', 'running'],
      ['search_late', 'Searched the web for “late query”', 'done'],
    ],
  );
});
