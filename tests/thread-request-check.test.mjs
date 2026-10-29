// #504: UAT state records which prompt section led each topic or historical side-thread turn.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { THREAD_CHECKS } from '../server/room-checks-threads.mjs';
import { firstPromptSection } from '../server/thread-summary.mjs';

const check = THREAD_CHECKS[0];
const facts = (promptFirst) => ({
  threads: ['room', 'topic'],
  state: {
    threads: {
      room: { id: 'room', kind: 'room' },
      topic: { id: 'topic', kind: 'topic', parentId: 'room' },
    },
    items: {
      room: [{ id: 'room-reply', kind: 'agent', turnId: 'turn-room', handle: 'alpha', promptFirst: 'room' }],
      topic: [{ id: 'topic-reply', kind: 'agent', turnId: 'turn-topic', handle: 'beta', ...(promptFirst ? { promptFirst } : {}) }],
    },
  },
});

test('#504 thread-request-first flags a direct topic request whose task context is missing', () => {
  const first = firstPromptSection({ kind: 'user' }, true);
  assert.equal(first, 'missing');
  assert.deepEqual(check.run(facts(first)), [
    {
      key: 'turn-topic',
      title: 'A thread turn did not put its request first',
      evidence: '@beta’s turn turn-topic spoke in thread topic without marking its first prompt section.',
    },
  ]);
});

test('#504 thread-request-first accepts a direct task, slash command, reattachment or system turn in a topic', () => {
  for (const first of ['thread-task', 'slash', 'attach', 'system']) assert.deepEqual(check.run(facts(first)), [], first);
});
