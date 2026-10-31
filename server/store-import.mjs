// The one-time import of the old store into Redis (#508’s design, “Migration, compatibility and rollback”, the Store
// step). The old store was a JSON Lines log, events-<from>.jsonl, after a snapshot.json (or Stage 2’s store.json).
// At the first start on Redis, Postbox reads them as the old store did, dropping a torn last line, writes every
// document, the log’s events and the seq into Redis, copies the old files into backups/store-<when>/ and renames them
// *.migrated. A store that already imported these very files (their hash is recorded in Redis, `imported`) is left
// alone; one holding other events refuses to mix them. Downgrading means restoring the backup (“Rollback”).
//
// The import marks itself in progress in Redis (the `importing` key, holding the backup’s folder) from before its first
// write until after it sets `seq`. A start that finds the mark clears whatever Redis holds and imports again from the
// start, into the same backup: the import is quick (209 ms for the UAT room), and nothing else writes before it
// finishes, since Postbox imports before it reads the store. Without the mark, a crash after the first batch of events
// left Redis part way along the log, which the next start refused (review finding 3 on #525).
//
// The renames come after that commit, one file at a time, so a crash between two of them leaves `imported` set and
// some files in place: `imported` records each file the import covered (name and SHA-256), and a start that finds files
// still in place which all match it finishes the renames and goes on, with nothing to flush or import again; a file
// matching none is another store’s, refused by name (gpt’s r10 review of #553, blocker 1). Renaming before the commit
// would leave `importing` set with the files half renamed, and a reimport would have to find them again from the
// backup; the record of what was covered is the simpler state to recover from.
//
// What Redis would refuse is found first, so the import can’t fail on it (the integrator’s re-review of #553, blocker
// 2). Old Postbox cut text with slice(0, n - 1), which can end a title inside an emoji: a lone surrogate, which RedisJSON
// refuses. It’s repaired with U+FFFD, in the snapshot’s documents and the log’s events alike, as the store repairs its
// own events (server/store-check.mjs). Old Postbox capped an app’s state by size, not depth: a document nested past
// what RedisJSON holds (REDIS_DEPTH) is left out and reported, naming it and the backup that keeps it, and the rest
// imports. Those are the refusals the import knows; one Redis gives for a reason the checks don’t foresee is asked
// about one document at a time, to name the document, and fails the import on it rather than leaving a valid
// conversation out of a store that reports success (gpt’s r10 review of #553, blocker 3). An import that fails (that
// refusal, or its Redis went away) records the attempt in Redis (`import-attempts`), and the start fails with EIMPORT
// saying why, naming the backup, how many times it has failed, and the way out (start again, or --fresh); the next
// start imports again from the start, and the count goes once an import finishes. Postbox doesn’t start on an empty
// state with the line “you can still read everything”, since nothing would be there to read.

import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { depthOf, REDIS_DEPTH } from '../shared/storable.mjs';
import { COLLECTIONS, KIND, writesFor } from './store-docs.mjs';
import { backUp, markMigrated, oldFiles, readOld } from './store-import-files.mjs';
import { probeWrites, writeBatch } from './store-redis.mjs';
import { TRANSIENT } from './store-reject.mjs';

/** Removes a data folder’s store, for a fresh start: the Redis data and any old log, snapshot or store.json. */
export async function clearStore(dataDir) {
  // The store’s own files only: the *.migrated copies an import left are the person’s record, not the store.
  for (const n of await readdir(dataDir).catch(() => []))
    if (/^(store\.json|snapshot\.json|events-\d+\.jsonl)$/.test(n)) await rm(join(dataDir, n), { force: true });
  await rm(join(dataDir, 'redis', 'data'), { recursive: true, force: true });
}

/** @param {string} code @param {string} message @param {object} [more] */
const fail = (code, message, more = {}) => Object.assign(new Error(message), { code }, more);

/** @typedef {{ what: string, writes: (string|number)[][] }} Group  one document’s writes, named for a report */

/**
 * Every document of a state, as writesFor() takes them, one group per document, with items numbered in list order.
 * @param {any} s @returns {Group[]}
 */
function everything(s) {
  const dirty = [{ ref: /** @type {any} */ ({ c: 'settings' }), seq: 0, what: 'settings' }];
  for (const c of COLLECTIONS) for (const [i, id] of Object.keys(s[c]).entries()) dirty.push({ ref: { c, id }, seq: i + 1, what: `${KIND[c]} “${id}”` });
  const at = new Map();
  Object.entries(s.items).forEach(([t, list], i) => {
    list.forEach((it, k) => {
      at.set(it.id, { t, it, n: k + 1 });
      dirty.push({ ref: { c: 'items', t, id: it.id }, seq: i + 1, what: `item “${it.id}” of conversation “${t}”` });
    });
  });
  const itemOf = (t, id) => (at.get(id)?.t === t ? at.get(id).it : undefined);
  const scoreOf = (t, id) => (at.get(id)?.t === t ? at.get(id).n : undefined);
  return dirty.map((d) => ({ what: d.what, writes: writesFor(s, [d], itemOf, scoreOf) }));
}

/** Why the store’s Redis would refuse a document’s writes before they’re sent, or null: nesting past what it holds. @param {Group} g */
function unstorable(g) {
  for (const w of g.writes) {
    if (w[0] !== 'S') continue;
    const json = String(w[2]);
    if (json.length <= 2 * REDIS_DEPTH) continue;
    const depth = depthOf(json);
    if (depth > REDIS_DEPTH) return `its document is nested ${depth} levels deep, and the store holds up to ${REDIS_DEPTH}`;
  }
  return null;
}

/**
 * Writes the documents, up to 2000 writes a batch. A batch Redis refuses for a reason no retry changes is asked about
 * one document at a time (a probe that commits nothing), to name the document refused: the import fails on it, since
 * what the checks foresee was handled before (unstorable, readOld), and anything else is not to be left out quietly.
 * @param {import('./redis-client.mjs').RedisClient} c @param {Group[]} groups
 */
async function writeDocuments(c, groups) {
  /** @type {Group[][]} */ const batches = [[]];
  let size = 0;
  for (const g of groups) {
    if (size + g.writes.length > 2000 && batches.at(-1)?.length) {
      batches.push([]);
      size = 0;
    }
    batches.at(-1)?.push(g);
    size += g.writes.length;
  }
  for (const batch of batches) {
    if (!batch.length) continue;
    try {
      await writeBatch(c, { prev: 0, events: [], writes: batch.flatMap((g) => g.writes) });
    } catch (e) {
      if (TRANSIENT.has(e.code)) throw e;
      for (const g of batch) {
        try {
          await probeWrites(c, g.writes);
        } catch (why) {
          if (TRANSIENT.has(why.code)) throw why;
          throw fail(why.code ?? 'ERR', `the store’s Redis refused the document of the ${g.what}: ${why.message}`, { document: g.what, refusal: why });
        }
      }
      throw e;
    }
  }
}

/**
 * What an import of the old files in a data folder would take in, once it should: the old files read (readOld), or null
 * when this Redis already imported these very files. A Redis holding other events, or imported from other files, is
 * refused rather than mixed.
 *
 * The import commits `imported` before it renames the files one by one (importLegacy), so a crash between two renames
 * leaves some in place. `imported` names each file it covered with its hash: files still in place that all match are
 * that import’s, and the start finishes their renames (gpt’s r10 review of #553, blocker 1); a file matching none is
 * another store’s, refused by name. An `imported` from before the files were recorded compares the hash of them all.
 * @param {string} dir @param {import('./redis-client.mjs').RedisClient} c @param {string[]} files @param {string | null} marked
 */
async function toImport(dir, c, files, marked) {
  const old = await readOld(dir, files);
  if (marked) return old;
  const have = Number((await c.call('GET', 'seq')) ?? 0);
  const imported = JSON.parse((await c.call('GET', 'imported')) ?? 'null');
  if (imported) {
    const strangers = imported.files ? old.files.filter((f) => !imported.files.some((r) => r.name === f.name && r.hash === f.hash)) : [];
    if (strangers.length === 0 && (imported.files || imported.hash === old.hash)) {
      await markMigrated(dir, files);
      return null;
    }
    const which = strangers.length ? ` ${strangers.map((f) => f.name).join(', ')}` : '';
    throw fail(
      'EIMPORT',
      `The old files in ${dir} aren’t the ones this store was imported from (its import, kept in ${imported.backup}, read a log to event ${imported.seq}; these go to ${old.state.seq}; not from it:${which || ' every file'}). Postbox won’t mix them: move them aside, or start with --fresh to import them into an empty store.`,
    );
  }
  if (have > 0)
    throw fail(
      'EIMPORT',
      `The store’s Redis holds events up to ${have}, but the old log in ${dir} goes to ${old.state.seq}. Postbox won’t mix them; move one aside.`,
    );
  return old;
}

/**
 * Imports the old store in a data folder into its Redis, once. Returns whether it imported.
 * @param {string} dir @param {import('./redis-client.mjs').RedisClient} c @param {{ now?: Date }} [o]
 */
export async function importLegacy(dir, c, { now = new Date() } = {}) {
  const files = await oldFiles(dir);
  const marked = await c.call('GET', 'importing');
  if (!files.length) {
    if (marked)
      throw fail('EIMPORT', `An import into the store’s Redis was cut short, and the old files it read are gone from ${dir}. Restore them from ${marked}.`);
    return false;
  }
  const old = await toImport(dir, c, files, marked);
  if (!old) return false;
  const { state, events, repaired, hash } = old;
  const covered = old.files; // each file this import covers, so a start after a crash between the renames below can finish them
  const backup = await backUp(dir, files, marked, now);
  // Earlier attempts at this import, counted before the flush takes the record, and recorded again with this one.
  const attempt = (marked && JSON.parse((await c.call('GET', 'import-attempts')) ?? 'null')?.attempts) + 1 || 1;
  await c.call('FLUSHDB'); // what an import cut short wrote
  await c.call('SET', 'importing', backup);
  await c.call('SET', 'import-attempts', JSON.stringify({ attempts: attempt, at: now.toISOString() }));
  if (repaired.snapshot || repaired.events)
    console.error(
      `The old store in ${dir} held text cut inside a character (half of an emoji, say), which the store can’t keep: the import replaced each with U+FFFD, in ${[repaired.snapshot && 'the snapshot’s documents', repaired.events && `${repaired.events} event(s) of the log`].filter(Boolean).join(' and ')}. The copy in ${backup} has the text as it was.`,
    );
  const left = [];
  const groups = everything(state).filter((g) => {
    const why = unstorable(g);
    if (why) left.push({ what: g.what, why });
    return !why;
  });
  try {
    await writeDocuments(c, groups);
    let prev = 0;
    for (let i = 0; i < events.length; i += 1000) prev = (await writeBatch(c, { prev, events: events.slice(i, i + 1000), writes: [] })).seq;
    await c.call(
      'EVAL',
      "redis.call('SET', 'seq', ARGV[1]); redis.call('SET', 'imported', ARGV[2]); redis.call('DEL', 'importing', 'import-attempts')",
      0,
      state.seq,
      JSON.stringify({ hash, files: covered, seq: state.seq, backup, at: now.toISOString() }),
    );
  } catch (e) {
    const message = `Postbox couldn’t import the old store in ${dir} into its Redis (attempt ${attempt}): ${e.message} Nothing of yours is lost: the old files are still in place, and a copy is in ${backup}. Postbox imports them again when it next starts; to start with an empty store instead, start it with --fresh (the copy in ${backup} stays).`;
    await c.call('SET', 'import-attempts', JSON.stringify({ attempts: attempt, at: now.toISOString(), message: e.message })).catch(() => {});
    throw fail('EIMPORT', message, { cause: 'import-failed', attempts: attempt, backup });
  }
  await markMigrated(dir, files);
  for (const { what, why } of left) console.error(`The import left out the ${what} of ${dir}: ${why}. The copy in ${backup} keeps it.`);
  return true;
}
