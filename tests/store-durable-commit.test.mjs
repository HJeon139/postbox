// A commit is acknowledged only once Redis has synced it to its append-only file (server/store-commit.mjs, WAITAOF;
// the person’s decision on #525): emits stay on appendfsync everysec, but a commit’s events are applied and broadcast
// only after `WAITAOF 1 0` says the local AOF holds them on disk. A WAITAOF that times out or finds it not synced is a
// lost reply: writes close, and reconciliation reads the commit back.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consistent, gate, open, tmp, until } from './store-fixture.mjs';

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

/** Holds the store’s next WAITAOF at a gate, and keeps its arguments. @param {any} s */
function holdWaitaof(s) {
  const g = gate();
  const call = s.client.call.bind(s.client);
  const seen = [];
  let once = true;
  s.client.call = async (/** @type {any[]} */ ...a) => {
    if (once && a[0] === 'WAITAOF') {
      once = false;
      seen.push(a);
      await g.wait();
    }
    return call(...a);
  };
  return { ...g, seen };
}

test('a commit is applied and broadcast only after WAITAOF says Redis synced it to disk', async () => {
  const s = await withItem();
  const heard = [];
  s.subscribe((ev) => heard.push(ev.seq));
  const w = holdWaitaof(s);
  let done = false;
  const p = s.commit(append('b'), 'synced').then((r) => {
    done = true;
    return r;
  });
  await Promise.race([w.hit, p]);
  try {
    assert.equal(w.seen.length, 1, 'the commit waited on WAITAOF');
    const [cmd, local, replicas, timeout] = w.seen[0];
    assert.deepEqual([cmd, local, replicas], ['WAITAOF', 1, 0], 'the local AOF, no replicas');
    assert.ok(Number(timeout) > 1000, 'longer than appendfsync everysec’s second');
    assert.equal(done, false);
    assert.equal(s.state.items.t[0].text, 'a', 'not applied before it is on disk');
    assert.deepEqual(heard, [], 'not broadcast before it is on disk');
  } finally {
    w.go();
  }
  const r = await p;
  assert.equal(r.duplicate, false);
  assert.equal(s.state.items.t[0].text, 'ab');
  assert.deepEqual(heard, [r.seq]);
});

test('a WAITAOF that finds the commit not synced is a lost reply: writes close, and reconciliation reads it back once', async () => {
  const s = await withItem();
  const client = /** @type {any} */ (s).client;
  const call = client.call.bind(client);
  let once = true;
  client.call = async (/** @type {any[]} */ ...a) => {
    if (once && a[0] === 'WAITAOF') {
      once = false;
      await call(...a);
      return [0, 0]; // timed out before the local fsync
    }
    return call(...a);
  };
  const heard = [];
  s.subscribe((ev) => heard.push(ev.seq));
  await assert.rejects(s.commit(append('b'), 'unsynced'), (e) => e.code === 'ESTOREDOWN');
  assert.equal(s.writable, false, 'writes close');
  assert.equal(/** @type {any} */ (s.status).cause, 'reconciling');
  await until(() => s.writable);
  assert.equal(s.state.items.t[0].text, 'ab', 'read back from Redis, once');
  assert.deepEqual(heard, [3]);
  const again = await s.commit(append('b'), 'unsynced');
  assert.equal(again.duplicate, true, 'its retry finds its opId');
  assert.equal(s.state.items.t[0].text, 'ab');
  assert.deepEqual((await consistent(s)).fresh.state, s.state);
});

test('a commit survives a SIGKILL of Redis the moment it resolves, every time', async () => {
  const s = await withItem();
  const sup = /** @type {any} */ (s).redis.sup;
  for (let round = 0; round < 8; round++) {
    await until(() => s.writable);
    const r = await s.commit(append(String(round)), `kill-${round}`);
    const child = sup.child;
    child.kill('SIGKILL');
    await new Promise((ok) => (child.exitCode !== null || child.signalCode !== null ? ok(null) : child.once('exit', ok)));
    await until(() => sup.status.state === 'running' && s.writable);
    const c = await sup.client();
    const seq = Number(await c.call('GET', 'seq'));
    c.close();
    assert.ok(seq >= r.seq, `round ${round}: the commit at ${r.seq} is in Redis after the restart (it holds ${seq})`);
    assert.equal(s.failed, null);
  }
  assert.equal(s.state.items.t[0].text, 'a01234567');
  assert.deepEqual((await consistent(s)).fresh.state, s.state);
});
