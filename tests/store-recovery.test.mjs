// The store when its Redis child comes back (server/store-recover.mjs; #508’s design, “Storage”, decision 7;
// re-review finding 2 on #525): writes stay closed, and the status says why, until catch-up has applied everything
// Redis holds, a commit whose reply was lost included; then they open again.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retry } from '../server/store-recover.mjs';
import { admin, consistent, gate, holdCatchUp, loseReply, open, tmp, until } from './store-fixture.mjs';

/** A store with a conversation and one item, written. */
async function withItem() {
  const s = await open(await tmp());
  s.emit('thread', { id: 't', members: [] });
  s.emit('item.add', { threadId: 't', item: { id: 'i', text: 'a' } });
  await s.flush();
  return s;
}

/** @param {string} text */
const append = (text) => [{ type: 'item.text', data: { threadId: 't', id: 'i', text } }];

// gpt’s regression: the store took writes before it had read back a commit whose reply was lost, so an emit took that
// commit’s seq and the store failed (another process wrote).
test('a restarted store refuses writes until it has read back a commit whose reply was lost', async () => {
  const s = await withItem();
  loseReply(s);
  const reading = holdCatchUp(s);
  try {
    await assert.rejects(s.commit(append('b'), 'lost-reply'), (e) => e.code === 'ESTOREDOWN');
    await reading.hit;
    assert.equal(s.writable, false, 'no writes while it reads back');
    assert.equal(s.status.state, 'down');
    assert.equal(/** @type {any} */ (s.status).cause, 'reconciling');
    assert.throws(
      () => s.emit('item.text', { threadId: 't', id: 'i', text: '!' }),
      (e) => e.code === 'ESTOREDOWN',
    );
    await assert.rejects(s.commit(append('?'), 'during'), (e) => e.code === 'ESTOREDOWN');
    assert.equal(s.state.items.t[0].text, 'a');
  } finally {
    reading.go();
  }
  await until(() => s.writable);
  assert.equal(s.failed, null);
  assert.equal(s.status.state, 'running');
  assert.equal(s.state.items.t[0].text, 'ab', 'the lost commit was read back');
  assert.equal(s.state.seq, Number(await s.client?.call('GET', 'seq')));
  const again = await s.commit(append('b'), 'lost-reply');
  assert.equal(again.duplicate, true, 'its retry finds its opId');
  s.emit('item.text', { threadId: 't', id: 'i', text: '!' });
  await s.flush();
  assert.equal(s.failed, null);
  assert.equal(s.state.items.t[0].text, 'ab!');
  assert.deepEqual((await consistent(s)).fresh.state, s.state);
});

// Emits held behind that commit are numbered after what catch-up reads back, never on its seqs.
test('emits held behind a commit whose reply was lost are published after catch-up reads the commit back', async () => {
  const s = await withItem();
  const g = gate();
  loseReply(s, g);
  const seen = [];
  s.subscribe((ev) => seen.push(ev.seq));
  const p = s.commit(append('b'), 'lost-held');
  await g.hit;
  s.emit('item.add', { threadId: 't', item: { id: 'h', text: 'held' } });
  g.go();
  await assert.rejects(p, (e) => e.code === 'ESTOREDOWN');
  await until(() => s.writable);
  await s.flush();
  assert.equal(s.failed, null);
  assert.deepEqual(
    s.state.items.t.map((it) => `${it.id}:${it.text}`),
    ['i:ab', 'h:held'],
  );
  assert.deepEqual(seen, [3, 4], 'the commit read back, then the held emit');
  assert.deepEqual((await consistent(s)).fresh.state, s.state);
});

/** Kills only the store’s own connection to its child, from another connection, while nothing is in flight. @param {any} s */
async function dropIdle(s) {
  const c = await admin(s);
  try {
    assert.equal(await c.call('CLIENT', 'KILL', 'USER', 'postbox'), 1, 'the store’s connection is Postbox’s user’s only one');
  } finally {
    c.close();
  }
  await until(() => !s.client?.connected || !s.writable);
}

// gpt’s regression (store outage review, finding 1): an idle connection drop closed writes without saying so, the
// status stayed running, and Retry did nothing.
test('an idle Redis connection drop is shown as down and Retry reconnects without a child restart', async () => {
  const s = await withItem();
  const pid = /** @type {any} */ (s).redis.sup.child.pid;
  await dropIdle(s);
  const before = { writable: s.writable, status: s.status.state, cause: /** @type {any} */ (s.status).cause };
  await retry(s);
  assert.deepEqual(
    { before, afterWritable: s.writable, afterStatus: s.status.state },
    { before: { writable: false, status: 'down', cause: 'reconciling' }, afterWritable: true, afterStatus: 'running' },
  );
  assert.equal(/** @type {any} */ (s).redis.sup.child.pid, pid, 'the child was not restarted');
  s.emit('item.text', { threadId: 't', id: 'i', text: 'b' });
  await s.flush();
  assert.equal(s.failed, null);
  assert.deepEqual((await consistent(s)).fresh.state, s.state);
});

test('an idle Redis connection drop reconnects, reads Redis back and reopens writes by itself', async () => {
  const s = await withItem();
  const heard = [];
  s.watchers.add((w, st) => heard.push(`${w}:${st.state}${st.cause ? `:${st.cause}` : ''}`));
  await dropIdle(s);
  // Another process writes while the store isn’t connected: catch-up must read it before writes reopen.
  const other = await open(/** @type {string} */ (s.dir));
  other.emit('item.text', { threadId: 't', id: 'i', text: 'x' });
  await other.flush();
  await until(() => s.writable);
  assert.deepEqual(heard, ['false:down:reconciling', 'true:running']);
  assert.equal(s.state.items.t[0].text, 'ax', 'what another process wrote meanwhile was read back');
  s.emit('item.text', { threadId: 't', id: 'i', text: 'b' });
  await s.flush();
  assert.equal(s.failed, null);
  assert.deepEqual((await consistent(s)).fresh.state, s.state);
});
