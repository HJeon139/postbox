// Helpers for the store’s tests on its Redis child (tests/AGENTS.md, “The store’s Redis”): scratch data folders, raw
// connections, and the checks that documents, stream and server agree.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { Store } from '../server/store.mjs';
import { apply, emptyState } from '../shared/state.mjs';

export { admin } from './redis-fixture-user.mjs';

if (!process.env.POSTBOX_REDIS_HOME) throw new Error('Set POSTBOX_REDIS_HOME (tests/AGENTS.md, “The store’s Redis”).');

const dirs = [];
const stores = [];
after(async () => {
  for (const s of stores) await s.close().catch(() => {});
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** A scratch data folder, removed after the file’s tests. */
export const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'pb-store-'));
  dirs.push(d);
  return d;
};

/** A store on a data folder, closed after the file’s tests. @param {string} dir */
export const open = async (dir) => {
  const s = await new Store(dir).load();
  stores.push(s);
  return s;
};

/** A raw connection to the store’s Redis. @param {Store} s */
export const raw = (s) => /** @type {any} */ (s).redis.sup.client();

/** Waits for a condition, up to 5 s. @param {() => boolean} pred */
export const until = async (pred) => {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((ok) => setTimeout(ok, 25));
  assert.ok(pred());
};

/** The stream’s events after `seq`, as Redis holds them. @param {Store} s @param {number} seq */
export async function streamed(s, seq) {
  const c = await raw(s);
  const entries = await c.call('XRANGE', 'events', '-', '+');
  c.close();
  return entries.map(([, f]) => JSON.parse(f[1])).filter((e) => e.seq > seq);
}

/**
 * Documents and stream agree: `seq` is the stream’s last entry, and replaying the whole stream gives the state the
 * documents hold. The stream isn’t trimmed in these tests, so it holds every event.
 * @param {Store} s
 */
export async function consistent(s) {
  const entries = await streamed(s, 0);
  const c = await raw(s);
  const seq = Number((await c.call('GET', 'seq')) ?? 0);
  c.close();
  const replay = emptyState();
  for (const ev of entries) {
    apply(replay, ev.type, ev.data);
    replay.seq = ev.seq;
  }
  assert.equal(entries.at(-1)?.seq ?? 0, seq, 'seq is the last stream entry');
  const fresh = await open(/** @type {string} */ (s.dir));
  assert.deepEqual(fresh.state, replay, 'the documents hold what the stream replays to');
  return { seq, fresh };
}

/** A gate: `hit` resolves once something waits at it, and `go()` lets it on. */
export function gate() {
  let go = () => {};
  let enter = () => {};
  const opened = new Promise((ok) => (go = ok));
  const hit = new Promise((ok) => (enter = ok));
  const wait = () => {
    enter();
    return opened;
  };
  return { hit, go: () => go(), wait };
}

/** Holds the next EVAL on a store’s connection at a gate. @param {Store} s */
export function holdEval(s) {
  const g = gate();
  const client = /** @type {any} */ (s).client;
  const call = client.call.bind(client);
  let once = true;
  client.call = async (...a) => {
    if (once && a[0] === 'EVAL') {
      once = false;
      await g.wait();
    }
    return call(...a);
  };
  return g;
}

/**
 * Makes the store’s next EVAL run in Redis, then kills the child before Postbox reads the reply; with `g`, the EVAL
 * waits at that gate first. @param {Store} s @param {ReturnType<typeof gate>} [g]
 */
export function loseReply(s, g) {
  const sup = /** @type {any} */ (s).redis.sup;
  const client = /** @type {any} */ (s).client;
  const call = client.call.bind(client);
  client.call = async (...a) => {
    if (a[0] !== 'EVAL') return call(...a);
    await g?.wait();
    await call(...a);
    sup.child.kill('SIGKILL');
    throw Object.assign(new Error('The connection to the store’s Redis closed before it answered.'), { code: 'ESTOREDOWN' });
  };
}

/** Holds the first `GET seq` on the next connection the store’s child gives (catch-up’s first read) at a gate. @param {Store} s */
export function holdCatchUp(s) {
  const g = gate();
  const sup = /** @type {any} */ (s).redis.sup;
  const factory = sup.client.bind(sup);
  let once = true;
  sup.client = async () => {
    const c = await factory();
    const real = c.call.bind(c);
    c.call = async (...a) => {
      const r = await real(...a);
      if (once && a[0] === 'GET' && a[1] === 'seq') {
        once = false;
        await g.wait();
      }
      return r;
    };
    return c;
  };
  return g;
}
