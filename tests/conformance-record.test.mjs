// #585: the recorder that writes the Codex conformance fixtures keeps an allowlist. Ids, folders, timestamps and any
// field it doesn’t name are left out, and every text the probe didn’t write is cut to its length. The inputs here are
// shaped as codex-cli 0.167.0’s rollout lines and request bodies are, with a field of each kind the recorder must drop.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keptItem, scrubRequest, scrubRollout } from '../tools/conformance/record.mjs';

const keep = (/** @type {string} */ text) => text.includes('MARK-1');

test('a rollout keeps each line’s type, its messages’ roles and the probe’s own text, and Codex’s version alone', () => {
  const rollout = [
    {
      timestamp: '2026-11-28T00:00:00Z',
      type: 'session_meta',
      payload: { id: 'thread-abc', cwd: '/home/someone/work', cli_version: '0.167.0', base_instructions: { text: 'secret-ish' } },
    },
    {
      timestamp: 't',
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'item-9',
        role: 'developer',
        content: [
          { type: 'input_text', text: 'guide MARK-1' },
          { type: 'input_text', text: 'Codex’s own' },
        ],
      },
    },
    { type: 'turn_context', payload: { cwd: '/home/someone/work', model: 'x' } },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n');
  const kept = scrubRollout(`${rollout}\n{"half a line`, keep)
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(kept, [
    { type: 'session_meta', payload: { cli_version: '0.167.0' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [
          { type: 'input_text', text: 'guide MARK-1' },
          { type: 'input_text', text: '[cut: 11 characters of Codex’s own text]' },
        ],
      },
    },
    { type: 'turn_context', payload: {} },
  ]);
});

test('a request keeps its model and input items, and drops its tools, cache key and metadata', () => {
  const body = {
    model: 'm',
    tools: [{ name: 'shell' }],
    prompt_cache_key: 'thread-abc',
    client_metadata: { id: 'x' },
    input: [
      { type: 'reasoning', id: 'r1', summary: ['s'] },
      { type: 'message', id: 'i1', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ],
  };
  assert.deepEqual(scrubRequest(body, keep), {
    model: 'm',
    input: [{ type: 'reasoning' }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[cut: 2 characters of Codex’s own text]' }] }],
  });
});

test('an item with no type or text is kept as nulls and empty cuts, never as what it held', () => {
  assert.deepEqual(keptItem({ secret: 'x' }, keep), { type: null });
  assert.deepEqual(keptItem({ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:...' }] }, keep), {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_image', text: '[cut: 0 characters of Codex’s own text]' }],
  });
});
