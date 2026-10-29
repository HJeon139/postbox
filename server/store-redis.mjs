// The store’s Redis side (designs/508/design.md, “Storage: a Redis 8 server that Postbox bundles and runs”). One
// script writes a batch: it checks `ops` for the operation’s id and that Redis is at the sequence number the batch
// follows, then sets and deletes the documents, places them, appends each event to the `events` stream with its seq as
// the entry id, and moves `seq` on, all or nothing. Startup reads the documents back into a state; a browser that
// reconnects reads the stream after its Last-Event-ID.
//
// One child per data folder, shared by every store open on it in this process (redisFor()), and stopped with the last.

import { emptyState, ownState } from '../shared/state.mjs';
import { storeError } from './redis-client.mjs';
import { RedisSupervisor } from './redis-supervisor.mjs';
import { redisHome } from './redis-unpack.mjs';
import { COLLECTIONS, KIND, Positions, upcast } from './store-docs.mjs';

/** Entries kept in the events stream before it’s trimmed (approximately; “Observability and calibration”). */
export const STREAM_KEEP = 20000;

// ARGV: opId, the seq the batch follows, the number of events, the stream’s length to keep, then each event’s seq and
// line, then the writes as store-docs.mjs’s writesFor() makes them, flattened. Every write is checked before any runs,
// so a bad batch writes nothing.
const WRITE = `
local opId, prev, n, keep = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
if opId ~= '' then
  local done = redis.call('HGET', 'ops', opId)
  if done then return {'dup', done} end
end
local cur = tonumber(redis.call('GET', 'seq') or '0')
if cur ~= prev then return {'seq', tostring(cur)} end
local arity = { S = 3, D = 2, Z = 4, ZN = 4, R = 3 }
local first = 5 + 2 * n
local j = first
while j <= #ARGV do
  local a = arity[ARGV[j]]
  if not a then return redis.error_reply('EWRITE unknown write ' .. ARGV[j]) end
  j = j + a
end
j = first
while j <= #ARGV do
  local op = ARGV[j]
  if op == 'S' then redis.call('JSON.SET', ARGV[j + 1], '$', ARGV[j + 2])
  elseif op == 'D' then redis.call('DEL', ARGV[j + 1])
  elseif op == 'Z' then redis.call('ZADD', ARGV[j + 1], ARGV[j + 2], ARGV[j + 3])
  elseif op == 'ZN' then redis.call('ZADD', ARGV[j + 1], 'NX', ARGV[j + 2], ARGV[j + 3])
  else redis.call('ZREM', ARGV[j + 1], ARGV[j + 2]) end
  j = j + arity[op]
end
local last = cur
for k = 0, n - 1 do
  local s = ARGV[5 + 2 * k]
  redis.call('XADD', 'events', 'MAXLEN', '~', keep, s .. '-0', 'e', ARGV[6 + 2 * k])
  last = tonumber(s)
end
redis.call('SET', 'seq', last)
if opId ~= '' then redis.call('HSET', 'ops', opId, last) end
return {'ok', tostring(last)}
`;

/** @type {Map<string, { sup: RedisSupervisor, ready: Promise<RedisSupervisor>, users: number }>} */
const running = new Map();

/**
 * The Redis child for a data folder, started once per process.
 * @param {string} dataDir @param {{ home?: string }} [o]
 */
export function redisFor(dataDir, { home } = {}) {
  let r = running.get(dataDir);
  if (!r) {
    const sup = new RedisSupervisor({ home: home ?? '', dataDir });
    const ready = (async () => {
      sup.home = home ?? (await redisHome({ dataDir }));
      return sup.start();
    })();
    r = { sup, ready, users: 0 };
    running.set(dataDir, r);
    ready.catch(() => running.delete(dataDir));
  }
  r.users++;
  return r;
}

/** Lets go of a data folder’s child; the last one out stops it. @param {string} dataDir */
export async function releaseRedis(dataDir) {
  const r = running.get(dataDir);
  if (!r || --r.users > 0) return;
  running.delete(dataDir);
  await r.sup.stop();
}

/**
 * Runs one batch. Resolves with the seq it ends at, and whether its opId had already run.
 * @param {import('./redis-client.mjs').RedisClient} c
 * @param {{ opId?: string, prev: number, events: { seq: number, line: string }[], writes: (string|number)[][] }} b
 */
export async function writeBatch(c, { opId = '', prev, events, writes }) {
  const args = [opId, prev, events.length, STREAM_KEEP, ...events.flatMap((e) => [e.seq, e.line]), ...writes.flat()];
  const [kind, seq] = await c.call('EVAL', WRITE, 0, ...args);
  if (kind === 'seq') throw storeError('ESEQ', `The store’s Redis is at event ${seq}, not ${prev}: another process wrote to it.`);
  return { seq: Number(seq), duplicate: kind === 'dup' };
}

/** JSON.MGET in slices, so no reply is huge. @param {import('./redis-client.mjs').RedisClient} c @param {string[]} keys */
async function docs(c, keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 500) {
    const slice = keys.slice(i, i + 500);
    const got = await c.call('JSON.MGET', ...slice, '$');
    for (const [k, raw] of got.entries()) out.push(raw === null ? undefined : upcast(JSON.parse(raw)[0], slice[k]));
  }
  return out;
}

/**
 * The state the documents hold, its seq, and the items’ positions. No replay: documents are the truth.
 * @param {import('./redis-client.mjs').RedisClient} c
 */
export async function readState(c) {
  const s = emptyState();
  s.seq = Number((await c.call('GET', 'seq')) ?? 0);
  const settings = await c.call('JSON.GET', 'settings', '$');
  if (settings) Object.assign(s.settings, upcast(JSON.parse(settings)[0], 'settings'));
  const orders = await Promise.all(COLLECTIONS.map((col) => c.call('ZRANGE', `order:${col}`, 0, -1)));
  for (const [i, col] of COLLECTIONS.entries()) {
    const ids = orders[i];
    const values = await docs(
      c,
      ids.map((id) => `${KIND[col]}:${id}`),
    );
    for (const [k, id] of ids.entries()) if (values[k] !== undefined) s[col][id] = values[k];
  }
  const positions = new Positions();
  const threads = await c.call('ZRANGE', 'order:items', 0, -1);
  const lists = await Promise.all(threads.map((t) => c.call('ZRANGE', `thread:${t}:items`, 0, -1, 'WITHSCORES')));
  for (const [i, t] of threads.entries()) {
    const flat = lists[i];
    const ids = flat.filter((_, k) => k % 2 === 0);
    const items = await docs(
      c,
      ids.map((id) => `item:${id}`),
    );
    s.items[t] = items.filter((it) => it !== undefined);
    for (const [k, id] of ids.entries()) positions.set(t, id, Number(flat[2 * k + 1]));
  }
  return { state: ownState(s), positions };
}

/**
 * Events after `seq` from the stream, or null when the stream no longer holds the next one (trimmed).
 * @param {import('./redis-client.mjs').RedisClient} c @param {number} seq @param {number} upTo
 */
export async function streamAfter(c, seq, upTo) {
  if (seq >= upTo) return [];
  const got = await c.call('XRANGE', 'events', `${seq + 1}-0`, `${upTo}-0`);
  const events = got.map(([, fields]) => JSON.parse(fields[1]));
  if (events[0]?.seq !== seq + 1) return null;
  return events;
}
