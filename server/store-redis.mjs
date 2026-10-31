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
import { COLLECTIONS, KIND, Positions, SHAPES, upcast } from './store-docs.mjs';

/** Entries kept in the events stream before it’s trimmed (approximately; “Observability and calibration”). */
export const STREAM_KEEP = 20000;

// ARGV: opId, the seq the batch follows, the number of events, the stream’s length to keep, then each event’s seq and
// line, then the writes as store-docs.mjs’s writesFor() makes them, flattened.
//
// All or nothing. Redis doesn’t undo what a script wrote before a runtime error (review finding 2 on #525: RedisJSON
// refused a deeply nested app after the settings were set), so nothing real changes until nothing can fail. First,
// every write’s shape, every score and every event’s seq is checked, and every document is set into a staging key under
// redis.pcall, so RedisJSON’s own checks (nesting, size, syntax) and an out-of-memory refusal run there; on any
// error the staging keys are deleted and the error returned. Only then are the documents renamed into place and the
// rest written: RENAME, DEL, ZADD with a checked score, XADD with a checked id and SET can’t fail on keys of the right
// type, and Redis checks memory only before a script’s first write.
const WRITE = `
local opId, prev, n, keep = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
if opId ~= '' then
  local done = redis.call('HGET', 'ops', opId)
  if done then return {'dup', done} end
end
local cur = tonumber(redis.call('GET', 'seq') or '0')
if cur ~= prev then return {'seq', tostring(cur)} end
local last = cur
for k = 0, n - 1 do
  local s = tonumber(ARGV[5 + 2 * k])
  if not s or s <= last or s % 1 ~= 0 then return redis.error_reply('EWRITE event seq ' .. tostring(ARGV[5 + 2 * k]) .. ' after ' .. last) end
  last = s
end
local arity = { S = 3, D = 2, Z = 4, ZN = 4, R = 3 }
local first = 5 + 2 * n
local j = first
while j <= #ARGV do
  local op = ARGV[j]
  local a = arity[op]
  if not a or j + a - 1 > #ARGV then return redis.error_reply('EWRITE unknown write ' .. tostring(op)) end
  if (op == 'Z' or op == 'ZN') and not tonumber(ARGV[j + 2]) then return redis.error_reply('EWRITE score ' .. ARGV[j + 2]) end
  j = j + a
end
local staged = {}
j = first
while j <= #ARGV do
  if ARGV[j] == 'S' then
    local tmp = 'stage:' .. #staged
    local r = redis.pcall('JSON.SET', tmp, '$', ARGV[j + 2])
    if type(r) == 'table' and r.err then
      if #staged > 0 then redis.call('DEL', unpack(staged)) end
      redis.call('DEL', tmp)
      return r
    end
    staged[#staged + 1] = tmp
  end
  j = j + arity[ARGV[j]]
end
local k = 0
j = first
while j <= #ARGV do
  local op = ARGV[j]
  if op == 'S' then
    redis.call('RENAME', staged[k + 1], ARGV[j + 1])
    k = k + 1
  elseif op == 'D' then redis.call('DEL', ARGV[j + 1])
  elseif op == 'Z' then redis.call('ZADD', ARGV[j + 1], ARGV[j + 2], ARGV[j + 3])
  elseif op == 'ZN' then redis.call('ZADD', ARGV[j + 1], 'NX', ARGV[j + 2], ARGV[j + 3])
  else redis.call('ZREM', ARGV[j + 1], ARGV[j + 2]) end
  j = j + arity[op]
end
for e = 0, n - 1 do
  redis.call('XADD', 'events', 'MAXLEN', '~', keep, ARGV[5 + 2 * e] .. '-0', 'e', ARGV[6 + 2 * e])
end
redis.call('SET', 'seq', last)
if opId ~= '' then redis.call('HSET', 'ops', opId, last) end
return {'ok', tostring(last)}
`;

// ARGV: writes as writesFor() makes them, flattened. Stages every document as WRITE does, under redis.pcall, so
// RedisJSON’s checks run on it, then deletes the staging keys and returns 'ok', or the first refusal: Redis is left as it
// was either way. Retry on a refused batch asks this of each queued event’s documents before writing the ones Redis
// takes in one batch (server/store-reject.mjs).
const PROBE = `
local arity = { S = 3, D = 2, Z = 4, ZN = 4, R = 3 }
local staged = {}
local j = 1
while j <= #ARGV do
  local a = arity[ARGV[j]]
  if not a then return redis.error_reply('EWRITE unknown write ' .. tostring(ARGV[j])) end
  if ARGV[j] == 'S' then
    local tmp = 'stage:' .. #staged
    local r = redis.pcall('JSON.SET', tmp, '$', ARGV[j + 2])
    if type(r) == 'table' and r.err then
      if #staged > 0 then redis.call('DEL', unpack(staged)) end
      redis.call('DEL', tmp)
      return r
    end
    staged[#staged + 1] = tmp
  end
  j = j + a
end
if #staged > 0 then redis.call('DEL', unpack(staged)) end
return 'ok'
`;

/** @type {Map<string, { sup: RedisSupervisor, ready: Promise<RedisSupervisor>, users: number, canceled: boolean }>} */
const running = new Map();

/**
 * The Redis child for a data folder, started once per process.
 * @param {string} dataDir @param {{ home?: string }} [o]
 */
export function redisFor(dataDir, { home } = {}) {
  let r = running.get(dataDir);
  if (!r) {
    const sup = new RedisSupervisor({ home: home ?? '', dataDir });
    const entry = { sup, ready: Promise.resolve(sup), users: 0, canceled: false };
    entry.ready = (async () => {
      sup.home = home ?? (await redisHome({ dataDir }));
      // stopRedis() came while the build was being found or downloaded: this start never begins.
      if (entry.canceled) throw storeError('ESTOREDOWN', 'Postbox stopped the store’s Redis before it started.');
      return sup.start();
    })();
    r = entry;
    running.set(dataDir, r);
    entry.ready.catch(() => {
      if (running.get(dataDir) === entry) running.delete(dataDir);
    });
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
 * Stops every data folder’s child this process started or is starting, for a Postbox that exits before its start
 * finished (SR-6, a clean shutdown). A start under way is stopped: before it spawns, it halts at its next step and lets
 * go of its claim (RedisSupervisor.stop()); after, its child is stopped. Resolves once each child is gone, without
 * waiting on whatever else the start awaits. A claim not yet let go of goes when the process exits.
 */
export async function stopRedis() {
  const all = [...running.values()];
  running.clear();
  await Promise.all(
    all.map((r) => {
      r.canceled = true;
      const { child } = r.sup;
      const stopped = r.sup.stop();
      if (!child || child.exitCode !== null || child.signalCode !== null) return stopped;
      return Promise.race([stopped, new Promise((ok) => child.once('exit', ok))]);
    }),
  );
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

/**
 * Asks Redis whether it would hold these writes’ documents, committing nothing: resolves when it would, and throws the
 * refusal it gives otherwise. Writes that set no document need no asking.
 * @param {import('./redis-client.mjs').RedisClient} c @param {(string|number)[][]} writes
 */
export async function probeWrites(c, writes) {
  if (!writes.some((w) => w[0] === 'S')) return;
  await c.call('EVAL', PROBE, 0, ...writes.flat());
}

/**
 * JSON.MGET in slices, so no reply is huge.
 * @param {import('./redis-client.mjs').RedisClient} c @param {string[]} keys @param {import('./store-docs.mjs').Shapes} shapes
 */
async function docs(c, keys, shapes) {
  const out = [];
  for (let i = 0; i < keys.length; i += 500) {
    const slice = keys.slice(i, i + 500);
    const got = await c.call('JSON.MGET', ...slice, '$');
    for (const [k, raw] of got.entries()) out.push(raw === null ? undefined : upcast(JSON.parse(raw)[0], slice[k], shapes));
  }
  return out;
}

/**
 * The state the documents hold, its seq, and the items’ positions. No replay: documents are the truth.
 *
 * The documents take many commands to read, and another process may write between them (review finding 5 on #525).
 * Every write moves `seq` in the same script as its documents, so a read that finds the same `seq` after as before saw
 * no write; one that doesn’t is read again, a few times, and then refused rather than returning a mix.
 * @param {import('./redis-client.mjs').RedisClient} c @param {import('./store-docs.mjs').Shapes} [shapes]  the shape to read in
 */
export async function readState(c, shapes = SHAPES) {
  for (let tries = 0; tries < 10; tries++) {
    const got = await readOnce(c, shapes);
    if (Number((await c.call('GET', 'seq')) ?? 0) === got.state.seq) return got;
  }
  throw storeError('ESEQ', 'The store’s Redis kept changing while Postbox read it; start Postbox again.');
}

/**
 * One read of the state, which another write may have landed in the middle of.
 * @param {import('./redis-client.mjs').RedisClient} c @param {import('./store-docs.mjs').Shapes} shapes
 */
async function readOnce(c, shapes) {
  const s = emptyState();
  s.seq = Number((await c.call('GET', 'seq')) ?? 0);
  const settings = await c.call('JSON.GET', 'settings', '$');
  if (settings) Object.assign(s.settings, upcast(JSON.parse(settings)[0], 'settings', shapes));
  const orders = await Promise.all(COLLECTIONS.map((col) => c.call('ZRANGE', `order:${col}`, 0, -1)));
  for (const [i, col] of COLLECTIONS.entries()) {
    const ids = orders[i];
    const values = await docs(
      c,
      ids.map((id) => `${KIND[col]}:${id}`),
      shapes,
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
      shapes,
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
