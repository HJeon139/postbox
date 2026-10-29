// The store’s write boundary under failure (#508’s design, “Storage”, “Tests”, and “Failure modes”: “Redis or Postbox
// is killed during a commit”, “Redis refuses or fails a write at a dispatch boundary”; INV-12). These run the real
// Redis child from POSTBOX_REDIS_HOME (tests/AGENTS.md, “The store’s Redis”).

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../server/store.mjs';
import { apply, emptyState } from '../shared/state.mjs';

if (!process.env.POSTBOX_REDIS_HOME) throw new Error('Set POSTBOX_REDIS_HOME (tests/AGENTS.md, “The store’s Redis”).');

const dirs = [];
const stores = [];
after(async () => {
  for (const s of stores) await s.close().catch(() => {});
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'pb-store-consistency-'));
  dirs.push(d);
  return d;
};
const open = async (dir) => {
  const s = await new Store(dir).load();
  stores.push(s);
  return s;
};
/** @param {Store} s */
const raw = (s) => /** @type {any} */ (s).redis.sup.client();
const until = async (pred) => {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((ok) => setTimeout(ok, 25));
  assert.ok(pred());
};

/**
 * Documents and stream agree: `seq` is the stream’s last entry, and replaying the whole stream gives the state the
 * documents hold. The stream isn’t trimmed in these tests, so it holds every event.
 * @param {Store} s
 */
async function consistent(s) {
  const c = await raw(s);
  const entries = await c.call('XRANGE', 'events', '-', '+');
  const seq = Number((await c.call('GET', 'seq')) ?? 0);
  c.close();
  const replay = emptyState();
  for (const [, fields] of entries) {
    const ev = JSON.parse(fields[1]);
    apply(replay, ev.type, ev.data);
    replay.seq = ev.seq;
  }
  assert.equal(Number(entries.at(-1)?.[0].split('-')[0] ?? 0), seq, 'seq is the last stream entry');
  const fresh = await open(/** @type {string} */ (s.dir));
  assert.deepEqual(fresh.state, replay, 'the documents hold what the stream replays to');
  return { seq, fresh };
}

/** A commit big enough to take a while: one session and many items. @param {number} k */
const bigCommit = (k) => [
  { type: 'session', data: { id: `se${k}`, handle: `h${k}` } },
  ...Array.from({ length: 400 }, (_, i) => ({ type: 'item.add', data: { threadId: 't', item: { id: `i${k}-${i}`, text: 'x'.repeat(200) } } })),
];

test('Redis killed during a commit leaves documents and stream consistent: all of the commit, or none of it', async () => {
  const dir = await tmp();
  const s = await open(dir);
  s.emit('thread', { id: 't', members: [] });
  await s.flush();
  const sup = /** @type {any} */ (s).redis.sup;
  const outcomes = [];
  for (let k = 0; k < 6; k++) {
    const seen = [];
    const off = s.subscribe((ev) => seen.push(ev.seq));
    const before = s.state.seq;
    const p = s.commit(bigCommit(k), `op-${k}`);
    // Kill it at a different moment each time: before the script, during it, or after its reply.
    const kill = setTimeout(() => sup.child?.kill('SIGKILL'), [0, 1, 2, 3, 4, 6][k]);
    const r = await p.then(
      () => 'committed',
      (e) => e.code,
    );
    clearTimeout(kill);
    off();
    if (r !== 'committed') {
      assert.equal(s.state.seq, before, 'a failed commit applied nothing');
      assert.deepEqual(seen, [], 'and broadcast nothing');
    }
    await until(() => s.writable);
    const { fresh } = await consistent(s);
    const ids = Object.keys(fresh.state.sessions);
    outcomes.push(`${r}, ${ids.includes(`se${k}`) ? 'in Redis' : 'not in Redis'}`);
    assert.ok(!ids.includes(`se${k}`) || fresh.state.items.t.filter((it) => it.id.startsWith(`i${k}-`)).length === 400, 'none or all');
    // The commit that failed is retried with its opId; it runs once whether or not the first try reached Redis.
    await s.commit(bigCommit(k), `op-${k}`);
    assert.equal(s.state.items.t.filter((it) => it.id.startsWith(`i${k}-`)).length, 400);
    assert.deepEqual((await consistent(s)).fresh.state, s.state);
  }
  // Recorded for the run’s log: which moments the kill hit (a commit that failed, or one that got its reply).
  console.log(`outcomes: ${outcomes.join('; ')}`);
  assert.equal(outcomes.length, 6);
});

test('a commit whose reply is lost when Redis dies is in Redis; its retry finds its opId, and the store applies it once', async () => {
  const s = await open(await tmp());
  s.emit('thread', { id: 't', members: [] });
  await s.flush();
  const sup = /** @type {any} */ (s).redis.sup;
  const client = /** @type {any} */ (s).client;
  const call = client.call.bind(client);
  // Redis runs the script; then the child dies before Postbox reads the reply.
  client.call = async (...args) => {
    const reply = await call(...args);
    if (args[0] !== 'EVAL') return reply;
    sup.child.kill('SIGKILL');
    throw Object.assign(new Error('The connection to the store’s Redis closed before it answered.'), { code: 'ESTOREDOWN' });
  };
  const seen = [];
  s.subscribe((ev) => seen.push(ev.seq));
  await assert.rejects(s.commit(bigCommit(9), 'op-lost'), (e) => e.code === 'ESTOREDOWN');
  assert.equal(s.state.sessions.se9, undefined, 'not applied: Postbox never saw the reply');
  await until(() => s.writable && s.client !== client);
  const r = await s.commit(bigCommit(9), 'op-lost');
  assert.equal(r.duplicate, true);
  assert.equal(s.state.items.t.filter((it) => it.id.startsWith('i9-')).length, 400, 'applied once, from the stream');
  assert.equal(new Set(seen).size, seen.length, 'each event broadcast once');
  assert.deepEqual((await consistent(s)).fresh.state, s.state);
});

test('a commit Redis refuses leaves the state, the clients and Redis unchanged, and the same commit runs later', async () => {
  const s = await open(await tmp());
  s.emit('thread', { id: 't', members: [] });
  await s.flush();
  const c = await raw(s);
  const before = { seq: await c.call('GET', 'seq'), len: await c.call('XLEN', 'events') };
  // Out of memory, as a full disk refuses: Redis refuses the script before it writes anything.
  await c.call('CONFIG', 'SET', 'maxmemory-policy', 'noeviction');
  await c.call('CONFIG', 'SET', 'maxmemory', '1');
  const seen = [];
  s.subscribe((ev) => seen.push(ev));
  const state = JSON.stringify(s.state);
  await assert.rejects(s.commit([{ type: 'session', data: { id: 'se', handle: 'h' } }], 'op-oom'), (e) => /OOM/.test(e.code));
  assert.equal(JSON.stringify(s.state), state);
  assert.deepEqual(seen, []);
  await c.call('CONFIG', 'SET', 'maxmemory', '0');
  assert.deepEqual({ seq: await c.call('GET', 'seq'), len: await c.call('XLEN', 'events') }, before);
  assert.equal(await c.call('HGET', 'ops', 'op-oom'), null);
  c.close();
  const r = await s.commit([{ type: 'session', data: { id: 'se', handle: 'h' } }], 'op-oom');
  assert.equal(r.duplicate, false);
  assert.equal(s.state.sessions.se.handle, 'h');
  await consistent(s);
});

test('two stores on one Redis keep every transition consistent: a stale one catches up and its transition runs on the new state', async () => {
  const dir = await tmp();
  const a = await open(dir);
  a.emit('session', { id: 'counter', n: 0 });
  await a.flush();
  const b = await open(dir);
  // Each transition reads the count and writes count + 1, as a record transition reads its record.
  const bump = (s, who, k) =>
    s.commit((st) => [{ type: 'session.patch', data: { id: 'counter', patch: { n: st.sessions.counter.n + 1, last: `${who}${k}` } } }], `${who}-${k}`);
  await Promise.all(Array.from({ length: 20 }, (_, k) => [bump(a, 'a', k), bump(b, 'b', k)]).flat());
  await a.catchUp();
  await b.catchUp();
  assert.equal(a.state.sessions.counter.n, 40, 'no transition lost');
  assert.deepEqual(a.state, b.state);
  const { fresh } = await consistent(a);
  assert.deepEqual(fresh.state, a.state);
});
