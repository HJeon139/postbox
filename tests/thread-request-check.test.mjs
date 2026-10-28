// #504: UAT evidence records whether each topic or side-thread turn put its direct request first.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { THREAD_CHECKS } from '../server/room-checks-threads.mjs';
import { followsEvent, keepEvent } from '../tools/uat/history.mjs';

const check = THREAD_CHECKS[0];
const facts = (events = []) => ({
  threads: ['room', 'topic'],
  state: {
    threads: {
      room: { id: 'room', kind: 'room' },
      topic: { id: 'topic', kind: 'topic', parentId: 'room' },
    },
    items: {
      room: [{ id: 'room-reply', kind: 'agent', turnId: 'turn-room', handle: 'alpha' }],
      topic: [{ id: 'topic-reply', kind: 'agent', turnId: 'turn-topic', handle: 'beta' }],
    },
  },
  events,
});

test('#504 thread-request-first flags a topic turn without evidence that its request led', () => {
  assert.deepEqual(check.run(facts()), [
    {
      key: 'turn-topic',
      title: 'A thread turn did not put its request first',
      evidence: '@beta’s turn turn-topic spoke in thread topic without recording its thread request as the first prompt section.',
    },
  ]);
});

test('#504 UAT history keeps the prompt marker, so thread-request-first accepts the recorded turn', () => {
  const marker = keepEvent(7, 'turn.context', { turnId: 'turn-topic', sessionId: 'se-beta', threadId: 'topic', first: 'thread-task' });
  assert.equal(followsEvent('turn.context'), true);
  assert.deepEqual(marker, {
    seq: 7,
    type: 'turn.context',
    data: { turnId: 'turn-topic', sessionId: 'se-beta', threadId: 'topic', first: 'thread-task' },
  });
  assert.deepEqual(check.run(facts([marker])), []);
});
