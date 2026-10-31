// Which threads make up a conversation (shared/conversation.mjs), the one answer #427’s queue view and #305’s archive
// pass both read.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationOf, threadsOfConversation } from '../shared/conversation.mjs';

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
  assert.equal(conversationOf(threads, 'c'), 'c');
  assert.equal(conversationOf(threads, 'topic'), 'c');
  assert.equal(conversationOf(threads, 'nested'), 'c');
  assert.deepEqual(threadsOfConversation(threads, 'c').sort(), ['c', 'nested', 'side', 'topic']);
  assert.equal(threadsOfConversation(threads, 'c')[0], 'c', 'the conversation first');
});

test('a thread whose parent is gone is its own conversation; a missing thread has none', () => {
  assert.equal(conversationOf(threads, 'orphan'), 'orphan');
  assert.equal(conversationOf(threads, 'nope'), null);
  assert.deepEqual(threadsOfConversation(threads, 'nope'), []);
});

test('a parentId loop ends instead of hanging', () => {
  assert.ok(['loopA', 'loopB'].includes(conversationOf(threads, 'loopA')));
});
