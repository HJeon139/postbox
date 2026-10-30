// What the store saves is on disk when it says so (the person’s decision on #525): the store’s Redis fsyncs its
// append-only file before each reply (appendfsync always, server/redis-supervisor.mjs), and a commit is applied and
// broadcast only once Redis has replied (server/store-commit.mjs). So a commit that resolved survives Redis being
// killed, and an emit whose flush resolved is on disk.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admin, consistent, gate, holding, killed, open, tmp, until } from './store-fixture.mjs';

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

test('a commit is applied and broadcast only once Redis has replied, and sends nothing after its script', async () => {
  const s = await withItem();
  const heard = [];
  s.subscribe((ev) => heard.push(ev.seq));
  const client = /** @type {any} */ (s).client;
  const call = client.call.bind(client);
  const g = gate();
  const sent = [];
  let held = false;
  client.call = async (/** @type {any[]} */ ...a) => {
    sent.push(a[0]);
    const reply = await call(...a);
    if (!held && a[0] === 'EVAL') {
      held = true;
      await g.wait(); // Redis has run the script; its reply waits here
    }
    return reply;
  };
  let done = false;
  const p = s.commit(append('b'), 'replied').then((r) => {
    done = true;
    return r;
  });
  await holding(Promise.race([g.hit, p]), 'the commit’s reply to arrive at the gate', s);
  try {
    const c = await admin(s);
    const seq = Number(await c.call('GET', 'seq'));
    c.close();
    assert.equal(seq, 3, 'Redis holds the commit');
    assert.equal(done, false);
    assert.equal(s.state.items.t[0].text, 'a', 'not applied before its reply');
    assert.deepEqual(heard, [], 'not broadcast before its reply');
  } finally {
    g.go();
  }
  const r = await p;
  assert.equal(r.duplicate, false);
  assert.equal(s.state.items.t[0].text, 'ab');
  assert.deepEqual(heard, [r.seq]);
  assert.deepEqual(sent, ['EVAL'], 'nothing after the script: its reply already means on disk');
});

test('a commit survives a SIGKILL of Redis the moment it resolves, every time', async () => {
  const s = await withItem();
  const sup = /** @type {any} */ (s).redis.sup;
  for (let round = 0; round < 8; round++) {
    await until(() => s.writable, `round ${round}: writes to reopen`, s);
    const r = await s.commit(append(String(round)), `kill-${round}`);
    await killed(s);
    await until(() => sup.status.state === 'running' && s.writable, `round ${round}: the restart and writes to reopen`, s);
    const c = await sup.client();
    const seq = Number(await c.call('GET', 'seq'));
    c.close();
    assert.ok(seq >= r.seq, `round ${round}: the commit at ${r.seq} is in Redis after the restart (it holds ${seq})`);
    assert.equal(s.failed, null);
  }
  assert.equal(s.state.items.t[0].text, 'a01234567');
  assert.deepEqual((await consistent(s)).fresh.state, s.state);
});

test('an emit is on disk once its flush resolves: Redis fsyncs each write before it acknowledges it', async () => {
  const s = await withItem();
  const c = await admin(s);
  try {
    for (let i = 0; i < 20; i++) {
      const [e] = append(String(i));
      s.emit(e.type, e.data);
      await s.flush();
      // WAITAOF answers for the asking connection's own last write, so the fixture writes once the emit's flush has
      // resolved, then asks with a 1 ms timeout: the AOF is fsynced past the fixture's write, and so past the emit.
      await c.call('SET', 'fixture:probe', String(i));
      const [local] = await c.call('WAITAOF', 1, 0, 1);
      assert.equal(local, 1, `emit ${i}: on disk when Redis acknowledged it, without waiting for a later fsync`);
    }
  } finally {
    await c.call('DEL', 'fixture:probe');
    c.close();
  }
  assert.deepEqual((await consistent(s)).fresh.state, s.state);
});
