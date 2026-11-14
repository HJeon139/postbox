// Threads’ signals change who calls whom, not when (designs/architecture/services.md, “Risks”): each listener runs
// synchronously, where the call it replaced ran. A side thread’s line counts a message there by the time it’s added
// (#130), and a reader’s marker is on the stub by the time an item is brought forward (#1041), so what runs next in
// the same call reads them right. A listener that ran late, on a microtask or a timer, fails both.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newId } from '../server/store.mjs';
import * as arrange from './arrange.mjs';
import { setup } from './side-threads-fixture.mjs';

test('a message in a side thread is counted on its line in the conversation before the add returns (#130)', () => {
  const f = setup();
  const side = arrange.putThread(f.rt, {
    id: newId('th'),
    projectId: f.t.projectId,
    title: 'Side',
    kind: 'side',
    parentId: f.t.id,
    members: [],
    lastSpeaker: null,
    hops: 0,
    queue: [],
    createdAt: Date.now(),
  });
  const link = arrange.post(f.rt, f.t.id, { kind: 'sidelink', sideThreadId: side.id, from: 'you', to: 'beta', count: 0 });
  const message = arrange.post(f.rt, side.id, { kind: 'user', text: 'A question in the side thread' });
  // Read in the same synchronous run as the add, as the code after an add does.
  const now = f.store.item(f.t.id, link.id);
  assert.equal(now.count, 1);
  assert.equal(now.lastAt, message.at);
});

test('a reader’s marker on an item brought forward is on its stub before the move returns (#1041)', () => {
  const f = setup();
  const block = arrange.post(f.rt, f.t.id, { kind: 'block', sessionId: f.alpha.id, handle: 'alpha', text: 'Asks.' });
  arrange.post(f.rt, f.t.id, { kind: 'agent', sessionId: f.alpha.id, handle: 'alpha', text: 'Later.', status: 'done' });
  arrange.setSession(f.rt, f.beta.id, { seenItem: block.id });
  assert.equal(arrange.moveToEnd(f.rt, f.t.id, block.id, { what: 'block', title: 'Asks' }), true);
  const stub = f.store.items(f.t.id).find((x) => x.kind === 'moved' && x.itemId === block.id);
  assert.ok(stub, 'a stub took its place');
  // Read in the same synchronous run as the move.
  assert.equal(f.store.state.sessions[f.beta.id].seenItem, stub.id);
});
