// Session writes decided from a session read behind a held commit (#796's class in sessions): an item brought forward
// moves the catch-up markers held on it (#956), and a kept job's end decides on its held steps (#957).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catchUp } from '../server/catch-up.mjs';
import { setup } from './side-threads-fixture.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

/** The side-thread room on a store whose log sync can be held; hold() holds a commit and returns its release. */
async function heldRoom() {
  const h = await heldStore();
  const f = setup(h.store);
  await h.store.flush();
  const hold = async () => {
    h.hold();
    const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
    await h.atSync;
    return async () => {
      h.release();
      await commit;
      await h.store.flush();
    };
  };
  return { ...f, h, hold };
}

/** Three messages in the conversation, it_a, it_x and it_b, on disk. */
async function threeItems(f) {
  for (const id of ['it_a', 'it_x', 'it_b']) f.store.emit('item.add', { threadId: f.t.id, item: { id, kind: 'user', text: `text of ${id}`, at: Date.now() } });
  await f.store.flush();
}

const stubOf = (f, threadId, id) => f.store.items(threadId).find((x) => x.kind === 'moved' && x.itemId === id);

test('bringForward unheld moves the marker to the stub', async () => {
  const f = await heldRoom();
  await threeItems(f);
  f.rt.updateSession(f.alpha.id, { seenItem: 'it_x' });
  assert.equal(f.rt.bringForward(f.t.id, 'it_x', { what: 'block', title: 'X' }), true);
  await f.store.flush();
  assert.equal(f.store.state.sessions[f.alpha.id].seenItem, stubOf(f, f.t.id, 'it_x').id);
  await f.store.close();
});

test('bringForward behind a held commit: a session whose held seenItem was the moved item reads on from the stub', async () => {
  const f = await heldRoom();
  await threeItems(f);
  f.rt.updateSession(f.beta.id, { seenItem: 'it_a' });
  await f.store.flush();
  const release = await f.hold();
  f.rt.updateSession(f.alpha.id, { seenItem: 'it_x' }); // a catch-up that just ran, held
  const moved = f.rt.bringForward(f.t.id, 'it_x', { what: 'block', title: 'X' });
  await release();
  assert.equal(moved, true);
  const stub = stubOf(f, f.t.id, 'it_x');
  assert.ok(stub, 'a stub took its place');
  assert.equal(f.store.state.sessions[f.alpha.id].seenItem, stub.id, 'seenItem moved to the stub');
  assert.equal(f.store.state.sessions[f.beta.id].seenItem, 'it_a', 'a marker on another item is untouched');
  assert.match(catchUp(f.rt, f.store.state.sessions[f.alpha.id]) ?? '', /text of it_b/, 'the next catch-up skips nothing');
  await f.store.close();
});
