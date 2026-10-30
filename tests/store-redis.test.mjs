// The store on Redis (server/store.mjs, server/store-redis.mjs, server/store-docs.mjs; #508’s design, “Storage: a
// Redis 8 server that Postbox bundles and runs”, “How it works”). A store on a data folder runs that folder’s Redis
// child from POSTBOX_REDIS_HOME (tests/AGENTS.md, “The store’s Redis”). Documents are the truth and the events stream
// the sequence, written together; emit is optimistic and commit publishes after Redis replies.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../server/store.mjs';
import { readState } from '../server/store-redis.mjs';
import { apply } from '../shared/state.mjs';
import { admin } from './redis-fixture-user.mjs';
import { holding, killed, until } from './store-fixture.mjs';

if (!process.env.POSTBOX_REDIS_HOME) throw new Error('Set POSTBOX_REDIS_HOME (tests/AGENTS.md, “The store’s Redis”).');

const dirs = [];
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'pb-store-redis-'));
  dirs.push(d);
  return d;
};
const stores = [];
const open = async (dir) => {
  const s = await new Store(dir).load();
  stores.push(s);
  return s;
};
after(async () => {
  for (const s of stores) await s.close().catch(() => {});
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** A raw connection to the store’s Redis. @param {Store} s */
const raw = (s) => /** @type {any} */ (s).redis.sup.client();

test('each record is a JSON document under its key with a v, items are placed by position, and every event is a stream entry', async () => {
  const s = await open(await tmp());
  s.emit('thread', { id: 't1', members: [] });
  s.emit('item.add', { threadId: 't1', item: { id: 'i1', text: 'one' } });
  s.emit('item.add', { threadId: 't1', item: { id: 'i2', text: 'two' } });
  s.emit('session', { id: 's1', handle: 'a' });
  await s.flush();
  const c = await raw(s);
  assert.deepEqual(JSON.parse(await c.call('JSON.GET', 'thread:t1', '$')), [{ v: 1, d: { id: 't1', members: [] } }]);
  assert.deepEqual(JSON.parse(await c.call('JSON.GET', 'item:i2', '$')), [{ v: 1, t: 't1', d: { id: 'i2', text: 'two' } }]);
  assert.deepEqual(await c.call('ZRANGE', 'thread:t1:items', 0, -1, 'WITHSCORES'), ['i1', '1', 'i2', '2']);
  assert.ok(await c.call('JSON.GET', 'session:s1', '$'));
  const entries = await c.call('XRANGE', 'events', '-', '+');
  assert.deepEqual(
    entries.map((e) => e[0]),
    ['1-0', '2-0', '3-0', '4-0'],
  );
  assert.equal(JSON.parse(entries[1][1][1]).type, 'item.add');
  assert.equal(await c.call('GET', 'seq'), '4');
  c.close();
});

test('startup reads the documents back: same state, same order, a moved item last and its stub in its place', async () => {
  const dir = await tmp();
  const a = await open(dir);
  a.emit('thread', { id: 'b', members: [] });
  a.emit('thread', { id: 'a', members: [] });
  for (const id of ['x', 'y', 'z']) a.emit('item.add', { threadId: 'b', item: { id, text: id } });
  a.emit('item.move', { threadId: 'b', id: 'x', stub: { id: 'x-stub', kind: 'stub' }, patch: { text: 'X' } });
  a.emit('item.text', { threadId: 'b', id: 'y', text: '!' });
  a.emit('settings', { theme: 'dark' });
  a.emit('remove', { kind: 'thread', id: 'a' });
  await a.flush();
  const b = await open(dir);
  assert.deepEqual(b.state, a.state);
  assert.deepEqual(Object.keys(b.state.threads), ['b']);
  assert.deepEqual(
    b.state.items.b.map((i) => i.id),
    ['x-stub', 'y', 'z', 'x'],
  );
});

test('commit applies and broadcasts only after Redis replies, and a repeated opId writes once', async () => {
  const s = await open(await tmp());
  s.emit('thread', { id: 't', members: [] });
  const seen = [];
  s.subscribe((ev) => seen.push(ev.seq));
  const p = s.commit([{ type: 'session', data: { id: 'se', handle: 'h' } }], 'op-1');
  assert.equal(s.state.sessions.se, undefined, 'nothing applied before the reply');
  assert.deepEqual(seen, []);
  const r = await p;
  assert.deepEqual(r, { seq: 2, duplicate: false });
  assert.equal(s.state.sessions.se.handle, 'h');
  assert.deepEqual(seen, [2]);
  const again = await s.commit([{ type: 'session', data: { id: 'se', handle: 'other' } }], 'op-1');
  assert.deepEqual(again, { seq: 2, duplicate: true });
  assert.equal(s.state.sessions.se.handle, 'h');
  assert.equal(s.state.seq, 2);
  const c = await admin(s);
  assert.equal(await c.call('XLEN', 'events'), 2);
  assert.equal(await c.call('HGET', 'ops', 'op-1'), '2');
  c.close();
});

test('an emit made while a commit waits is applied at once and numbered after the commit’s events', async () => {
  const s = await open(await tmp());
  s.emit('thread', { id: 't', members: [] });
  const order = [];
  s.subscribe((ev) => order.push(`${ev.seq}:${ev.type}`));
  const p = s.commit([{ type: 'session', data: { id: 'se', handle: 'h' } }], 'op-2');
  s.emit('item.add', { threadId: 't', item: { id: 'i', text: 'during' } });
  assert.equal(s.state.items.t[0].text, 'during');
  await p;
  await s.flush();
  assert.deepEqual(order, ['2:session', '3:item.add']);
  const b = await open(s.dir ?? '');
  assert.deepEqual(b.state, s.state);
});

test('while the child is down, writes are refused and the state stays readable; once it’s back they’re accepted', async () => {
  const s = await open(await tmp());
  s.emit('thread', { id: 't', members: [] });
  await s.flush();
  await killed(s);
  assert.throws(
    () => s.emit('thread', { id: 'u', members: [] }),
    (e) => e.code === 'ESTOREDOWN',
  );
  await assert.rejects(s.commit([{ type: 'thread', data: { id: 'v', members: [] } }]), (e) => e.code === 'ESTOREDOWN');
  assert.ok(s.state.threads.t);
  assert.equal(s.state.threads.u, undefined);
  await until(() => s.writable, 'the restart and writes to reopen', s);
  s.emit('thread', { id: 'w', members: [] });
  await s.flush();
  const b = await open(s.dir ?? '');
  assert.ok(b.state.threads.w);
});

test('a browser resumes after a restart from its Last-Event-ID out of the stream, and one behind the trimmed stream resyncs', async () => {
  const dir = await tmp();
  const a = await open(dir);
  for (let i = 0; i < 5; i++) a.emit('thread', { id: `t${i}`, members: [] });
  await a.flush();
  const b = await open(dir);
  assert.deepEqual(b.since(2), null, 'nothing in memory after a restart');
  assert.deepEqual(
    (await b.backlog(2)).map((e) => e.seq),
    [3, 4, 5],
  );
  const c = await admin(b);
  await c.call('XTRIM', 'events', 'MINID', '4-0');
  c.close();
  assert.equal(await b.backlog(2), null);
  assert.deepEqual(
    (await b.backlog(3)).map((e) => e.seq),
    [4, 5],
  );
});

test('a document is read in the current shape, and one from a newer Postbox is refused', async () => {
  const dir = await tmp();
  const a = await open(dir);
  a.emit('thread', { id: 't', members: [] });
  await a.flush();
  const c = await raw(a);
  await c.call('JSON.SET', 'thread:t', '$', JSON.stringify({ v: 99, d: { id: 't' } }));
  c.close();
  await assert.rejects(new Store(dir).load(), (e) => e.code === 'ENEWER' && /newer Postbox/.test(e.message));
});

test('a cost needing 17 significant digits is rounded to 12 places when made, so a restart can’t change what a browser saw', async () => {
  const dir = await tmp();
  const a = await open(dir);
  const seen = [];
  a.subscribe((ev) => seen.push(JSON.parse(JSON.stringify(ev.data))));
  const cost = 0.1 + 0.2; // 0.30000000000000004: RedisJSON 8.10.3 parses it to a neighboring double
  a.emit('work.add', { convId: 't1', entry: { id: 'w1', kind: 'turn', costUsd: cost, ms: 1.5 } });
  a.emit('work.add', { convId: 't1', entry: { id: 'w2', kind: 'turn', costUsd: null } });
  a.emit('work.patch', { convId: 't1', id: 'w1', patch: { summaryCostUsd: 1.6202103999999997 } });
  await a.commit([{ type: 'work.patch', data: { convId: 't1', id: 'w2', patch: { costUsd: 0.9778642000000001 } } }], 'op-cost');
  const want = [
    { id: 'w1', kind: 'turn', costUsd: 0.3, ms: 1.5, summaryCostUsd: 1.6202104 },
    { id: 'w2', kind: 'turn', costUsd: 0.9778642 },
  ];
  assert.deepEqual(a.state.work.t1, want, 'in memory');
  assert.equal(seen[0].entry.costUsd, 0.3, 'and as the browser was told');
  assert.equal(seen[2].patch.summaryCostUsd, 1.6202104);
  assert.equal(seen[3].patch.costUsd, 0.9778642);
  await a.flush();
  const b = await open(dir);
  assert.deepEqual(b.state.work.t1, want, 'after a restart, read back from the documents');
  assert.deepEqual(b.state, a.state);
});

// Review finding 1 on #525 (gpt’s regression): a commit’s events come first everywhere, in the server’s state as in the
// stream, so an emit that changes the same record while the commit waits wins on the server and in the browser alike.
test('an emit that changes what a waiting commit changes leaves the server, the browser and Redis in one order', async () => {
  const s = await open(await tmp());
  s.emit('session', { id: 'se', n: 0 });
  await s.flush();
  const browser = structuredClone(s.state);
  s.subscribe((e) => {
    apply(browser, e.type, e.data);
    browser.seq = e.seq;
  });
  const client = /** @type {any} */ (s).client;
  const call = client.call.bind(client);
  let release = () => {};
  let entered = () => {};
  const gate = new Promise((ok) => (release = ok));
  const arrived = new Promise((ok) => (entered = ok));
  let intercept = true;
  client.call = async (...a) => {
    if (intercept && a[0] === 'EVAL') {
      intercept = false;
      entered();
      await gate;
    }
    return call(...a);
  };
  const p = s.commit([{ type: 'session.patch', data: { id: 'se', patch: { n: 1 } } }], 'overlap');
  await holding(arrived, 'the commit to reach its EVAL', s);
  s.emit('session.patch', { id: 'se', patch: { n: 2 } });
  assert.equal(s.state.sessions.se.n, 2, 'the emit is applied at once');
  release();
  await p;
  await s.flush();
  assert.deepEqual(s.state.sessions.se, browser.sessions.se);
  assert.equal(s.state.sessions.se.n, 2);
  assert.deepEqual((await open(s.dir ?? '')).state, s.state, 'Redis holds what the server and browser hold');
});

test('an item emitted while a commit adds one to the same conversation comes after it, on the server as in the stream', async () => {
  const s = await open(await tmp());
  s.emit('thread', { id: 't', members: [] });
  s.emit('item.add', { threadId: 't', item: { id: 'a', text: 'before' } });
  await s.flush();
  const p = s.commit([{ type: 'item.add', data: { threadId: 't', item: { id: 'c', text: 'commit' } } }], 'op-list');
  s.emit('item.add', { threadId: 't', item: { id: 'e', text: 'emit' } });
  s.emit('item.patch', { threadId: 't', id: 'a', patch: { text: 'patched' } });
  assert.deepEqual(
    s.state.items.t.map((it) => it.id),
    ['a', 'e'],
    'applied at once',
  );
  await p;
  await s.flush();
  assert.deepEqual(
    s.state.items.t.map((it) => `${it.id}:${it.text}`),
    ['a:patched', 'c:commit', 'e:emit'],
  );
  assert.equal(s.itemOf('t', 'a'), s.state.items.t[0], 'the item index follows');
  assert.deepEqual((await open(s.dir ?? '')).state, s.state);
});

// Review finding 5 on #525 (gpt’s regression): startup read `seq`, then the documents, in separate commands, so a
// commit between them gave documents of seq 2 labeled seq 1.
test('startup reads documents that match the seq it reports, though another write lands while it reads', async () => {
  const s = await open(await tmp());
  s.emit('session', { id: 'counter', n: 0 });
  await s.flush();
  const client = /** @type {any} */ (s).client;
  const call = client.call.bind(client);
  let once = true;
  client.call = async (...a) => {
    const r = await call(...a);
    if (once && a[0] === 'GET' && a[1] === 'seq') {
      once = false;
      await s.commit([{ type: 'session.patch', data: { id: 'counter', patch: { n: 1 } } }], 'read-race');
    }
    return r;
  };
  const r = await readState(client);
  assert.equal(r.state.seq, r.state.sessions.counter.n + 1, 'n=0 is seq 1; n=1 is seq 2');
});
