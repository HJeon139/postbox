// #796's lost increment, in sessions: a count or a list built from the published session behind a held commit kept only
// the last write's step, so a second turn's unread, a second tool call or compaction, and an urgent note itself held
// were lost or given twice (designs/508/601-held-view.md, “a read that decides a write reads pending”).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withUrgent } from '../server/subagent-end.mjs';
import { settle, setup } from './side-threads-fixture.mjs';
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

test('two turns that end behind a held commit each count unread on their agent', async () => {
  const f = await heldRoom();
  const release = await f.hold();
  f.rt.deliver(f.alpha.id, { kind: 'user', text: 'First.' });
  await settle(f.rt);
  f.rt.deliver(f.alpha.id, { kind: 'user', text: 'Second.' });
  await settle(f.rt);
  await release();
  assert.equal(f.store.state.sessions[f.alpha.id].unread, 2);
  await f.store.close();
});

test('a turn’s tool calls and compactions behind a held commit each count, and each call is listed', async () => {
  const f = await heldRoom();
  f.adapter.next.push(async (/** @type {any} */ c) => {
    c.activity({ id: 'tu1', label: 'Read a.txt' });
    c.activity({ id: 'tu2', label: 'Read b.txt' });
    c.compaction({ kept: 10, total: 100, summary: 'First.' });
    c.compaction({ kept: 10, total: 100, summary: 'Second.' });
    c.text('Read both.');
  });
  const release = await f.hold();
  f.rt.deliver(f.alpha.id, { kind: 'user', text: 'Read them.' });
  await settle(f.rt);
  await release();
  const se = f.store.state.sessions[f.alpha.id];
  assert.deepEqual([se.toolCount, se.toolCalls.map((/** @type {any} */ c) => c.name), se.compactions], [2, ['Read b.txt', 'Read a.txt'], 2]);
  assert.deepEqual(
    f.store
      .items(f.t.id)
      .filter((i) => i.kind === 'system' && i.variant === 'compaction')
      .map((i) => i.n),
    [1, 2],
  );
  await f.store.close();
});

test('an urgent note itself held behind a commit is given on the next tool result, and not kept for the next turn', async () => {
  const f = await heldRoom();
  const urgent = '[Postbox] URGENT: the person ended your subagent Scout (id sub-1).';
  const release = await f.hold();
  f.rt.updateSession(f.alpha.id, (/** @type {any} */ se) => ({ context: [...(se.context ?? []), urgent] }));
  const text = withUrgent(f.rt, f.alpha.id, 'Result.', null);
  await release();
  assert.equal(text, `${urgent}\n\nResult.`);
  assert.deepEqual(f.store.state.sessions[f.alpha.id].context, []);
  await f.store.close();
});
