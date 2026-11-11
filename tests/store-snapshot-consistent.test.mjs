// A snapshot is one consistent view of the state (#1180). Written as lines, it yields to the loop every piece, and an
// emit applied during one of those waits landed both in the snapshot, whose seq line was already written, and in the
// next log segment, so a restart replayed it onto a state that held it: the item came back twice.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { folder, image, opened } from './store-jsonl-fixture.mjs';

/** The ids that appear more than once in a conversation’s items. @param {any[]} items */
const repeated = (items) => {
  const seen = new Set();
  return items.map((it) => it.id).filter((id) => seen.has(id) || !seen.add(id));
};

test('#1180 an emit made while a snapshot is written comes back once after a restart', async (t) => {
  const dir = await folder(t);
  const store = await opened(t, dir);
  store.emit('thread', { id: 'room', members: [] });
  // About 6 MB, so the write yields several times.
  for (let n = 0; n < 6000; n++) store.emit('item.add', { threadId: 'room', item: { id: `seed_${n}`, kind: 'user', at: n, text: 'x'.repeat(1000) } });
  await store.flush();
  let n = 0;
  let writing = true;
  const during = () => {
    if (!writing) return;
    store.emit('item.add', { threadId: 'room', item: { id: `live_${n}`, kind: 'user', at: 6000 + n, text: `${n++}` } });
    setTimeout(during, 0);
  };
  setTimeout(during, 0);
  await store.snapshot();
  writing = false;
  await store.flush();
  assert.ok(n > 0, 'emits were made while the snapshot was written');
  const live = store.state.items.room.length;
  const copy = await image(t, dir);
  const again = await opened(t, copy);
  assert.deepEqual(repeated(again.state.items.room), [], 'no item comes back twice');
  assert.equal(again.state.items.room.length, live, 'the restart holds every item, once');
});
