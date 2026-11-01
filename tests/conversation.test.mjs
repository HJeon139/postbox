// Which threads make up a conversation (shared/conversation.mjs), the one answer #427’s queue view and #305’s archive
// pass both read.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationRoot, threadsOfConversation } from '../shared/conversation.mjs';

const threads = {
  c: { id: 'c' },
  topic: { id: 'topic', parentId: 'c' },
  side: { id: 'side', parentId: 'c' },
  nested: { id: 'nested', parentId: 'topic' },
  other: { id: 'other' },
  orphan: { id: 'orphan', parentId: 'gone' },
  loopA: { id: 'loopA', parentId: 'loopB' },
  loopB: { id: 'loopB', parentId: 'loopA' },
};

test('a topic, a side thread and a thread off a topic all belong to the conversation', () => {
  assert.equal(conversationRoot(threads, 'c'), 'c');
  assert.equal(conversationRoot(threads, 'topic'), 'c');
  assert.equal(conversationRoot(threads, 'nested'), 'c');
  assert.deepEqual(threadsOfConversation(threads, 'c').sort(), ['c', 'nested', 'side', 'topic']);
  assert.equal(threadsOfConversation(threads, 'c')[0], 'c', 'the conversation first');
});

test('a thread whose parent is gone is its own conversation; a missing thread has none', () => {
  assert.equal(conversationRoot(threads, 'orphan'), 'orphan');
  assert.equal(conversationRoot(threads, 'nope'), null);
  assert.deepEqual(threadsOfConversation(threads, 'nope'), []);
});

test('a parentId loop, or a chain deeper than eight, has no root: null, never a wrong ancestor', () => {
  assert.equal(conversationRoot(threads, 'loopA'), null);
  const deep = { r: { id: 'r' } };
  for (let i = 1; i <= 10; i++) deep[`d${i}`] = { id: `d${i}`, parentId: i === 1 ? 'r' : `d${i - 1}` };
  assert.equal(conversationRoot(deep, 'd8'), 'r', 'eight levels is within reach');
  assert.equal(conversationRoot(deep, 'd9'), null, 'the integrator’s case: not d1');
});
