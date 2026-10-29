// The one-time import of the old store into Redis (#508’s design, “Migration, compatibility and rollback”, the Store
// step). The old store was a JSON Lines log, events-<from>.jsonl, after a snapshot.json (or Stage 2’s store.json).
// At the first start on Redis, Postbox reads them as the old store did, dropping a torn last line, writes every
// document, the log’s events and the seq into Redis, copies the old files into backups/store-<when>/ and renames them
// *.migrated. A crash part way leaves Redis without the seq, so the next start imports again from the start; a store
// that already holds the snapshot’s seq is left alone. Downgrading means restoring the backup (“Rollback”).

import { copyFile, mkdir, readdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { apply, emptyState, ownState } from '../shared/state.mjs';
import { COLLECTIONS, roundStateCosts, writesFor } from './store-docs.mjs';
import { writeBatch } from './store-redis.mjs';

/** @param {string} code @param {string} message */
const fail = (code, message) => Object.assign(new Error(message), { code });

/** The old store’s files in a data folder, the log’s segments in order. @param {string} dir */
async function oldFiles(dir) {
  const names = await readdir(dir);
  const segments = names.filter((n) => /^events-\d+\.jsonl$/.test(n)).sort((a, b) => Number(a.slice(7, -6)) - Number(b.slice(7, -6)));
  const base = names.includes('snapshot.json') ? ['snapshot.json'] : names.includes('store.json') ? ['store.json'] : [];
  return [...base, ...segments];
}

/** The state the old store loaded, and the log’s events after its snapshot. @param {string} dir @param {string[]} files */
export async function readOld(dir, files) {
  let state = emptyState();
  if (files[0] === 'snapshot.json' || files[0] === 'store.json')
    state = ownState({ ...emptyState(), ...JSON.parse(await readFile(join(dir, files[0]), 'utf8')) });
  const events = [];
  for (const name of files.filter((f) => f.startsWith('events-'))) {
    for (const line of (await readFile(join(dir, name), 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        break; // a torn last line: the old server stopped mid-write
      }
      if (ev.seq <= state.seq) continue;
      apply(state, ev.type, ev.data);
      state.seq = ev.seq;
      events.push({ seq: ev.seq, line });
    }
  }
  // The documents hold costs rounded as the store rounds them when it takes an event in; the old log keeps its events
  // as they were.
  return { state: roundStateCosts(state), events };
}

/** Every document of a state, as writesFor() takes them, with items numbered in list order. @param {any} s */
function everything(s) {
  const dirty = [{ ref: /** @type {any} */ ({ c: 'settings' }), seq: 0 }];
  for (const c of COLLECTIONS) for (const [i, id] of Object.keys(s[c]).entries()) dirty.push({ ref: { c, id }, seq: i + 1 });
  const at = new Map();
  Object.entries(s.items).forEach(([t, list], i) => {
    list.forEach((it, k) => {
      at.set(it.id, { t, it, n: k + 1 });
      dirty.push({ ref: { c: 'items', t, id: it.id }, seq: i + 1 });
    });
  });
  const itemOf = (t, id) => (at.get(id)?.t === t ? at.get(id).it : undefined);
  return writesFor(s, dirty, itemOf, (t, id) => (at.get(id)?.t === t ? at.get(id).n : undefined));
}

/**
 * Imports the old store in a data folder into its Redis, once. Returns whether it imported.
 * @param {string} dir @param {import('./redis-client.mjs').RedisClient} c @param {{ now?: Date }} [o]
 */
export async function importLegacy(dir, c, { now = new Date() } = {}) {
  const files = await oldFiles(dir);
  if (!files.length) return false;
  const { state, events } = await readOld(dir, files);
  const have = Number((await c.call('GET', 'seq')) ?? 0);
  if (have >= state.seq) return false;
  if (have > 0)
    throw fail(
      'EIMPORT',
      `The store’s Redis holds events up to ${have}, but the old log in ${dir} goes to ${state.seq}. Postbox won’t mix them; move one aside.`,
    );
  const backup = join(dir, 'backups', `store-${now.toISOString().slice(0, 19).replace(/:/g, '-')}`);
  await mkdir(backup, { recursive: true });
  for (const f of files) await copyFile(join(dir, f), join(backup, f));
  await c.call('FLUSHDB'); // what a start that crashed part way wrote
  const writes = everything(state);
  for (let i = 0; i < writes.length; i += 2000) await writeBatch(c, { prev: 0, events: [], writes: writes.slice(i, i + 2000) });
  let prev = 0;
  for (let i = 0; i < events.length; i += 1000) prev = (await writeBatch(c, { prev, events: events.slice(i, i + 1000), writes: [] })).seq;
  if (prev !== state.seq) await c.call('SET', 'seq', state.seq);
  for (const f of files) await rename(join(dir, f), join(dir, `${f}.migrated`));
  return true;
}
