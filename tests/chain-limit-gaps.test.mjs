// #1044’s small gaps: a room’s limit can’t be set on a thread that doesn’t exist, and the card’s notice writes the
// wake’s number as a person reads it. tests/process/chain-limit-default.test.mjs covers the page’s default.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patchThread } from '../server/room-chain-limit.mjs';
import * as arrange from './arrange.mjs';
import { setup } from './side-threads-fixture.mjs';

test('#1044: setting the chain limit of a thread that doesn’t exist is a 404, and writes nothing', () => {
  const f = setup();
  const before = Object.keys(f.store.state.threads).length;
  assert.throws(
    () => patchThread(f.rt, 'th_nope', { chainLimit: 5 }),
    (e) => e.status === 404,
  );
  assert.equal(Object.keys(f.store.state.threads).length, before);
});

test('#1044: the card’s notice writes the wake’s number with its separators', () => {
  const f = setup();
  arrange.setThread(f.rt, f.t.id, { chainLimit: 1, hops: 1000 });
  /** @type {string[]} */
  const notes = [];
  const notify = f.rt.threads.notify.bind(f.rt.threads);
  f.rt.threads.notify = (level, se, title, text, threadId) => {
    notes.push(text);
    return notify(level, se, title, text, threadId);
  };
  f.rt.agentWake(f.alpha.id, 'beta', 'One more.');
  assert.ok(
    notes.some((t) => t.includes('agent wake 1,001')),
    JSON.stringify(notes),
  );
});
