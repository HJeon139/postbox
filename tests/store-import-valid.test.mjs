// The import’s checks of what the store’s Redis would refuse (server/store-import.mjs; the integrator’s re-review of
// #553, blocker 2). Old Postbox cut text with slice(0, n - 1), which can end a title inside an emoji (a lone
// surrogate), and capped an app’s state by size, not depth; RedisJSON refuses both, so the import threw, and with the
// `importing` mark set every later start flushed Redis and failed the same way.

import assert from 'node:assert/strict';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { importLegacy } from '../server/store-import.mjs';
import { emptyState } from '../shared/state.mjs';
import { oldFolder, open, scratch } from './store-import-fixture.mjs';

/** A value nested n levels deep. @param {number} n */
const nested = (n) => {
  let v = /** @type {any} */ (1);
  for (let i = 0; i < n; i++) v = { a: v };
  return v;
};

/** An old data folder holding a snapshot of `state` and a segment of `lines` after it. @param {any} state @param {any[]} [lines] */
async function folderWith(state, lines = []) {
  const dir = await scratch();
  await writeFile(join(dir, 'snapshot.json'), JSON.stringify(state));
  if (lines.length) await writeFile(join(dir, `events-${state.seq + 1}.jsonl`), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  return dir;
}

/** Runs fn with console.error kept; resolves with its result and the lines logged. @template T @param {() => Promise<T>} fn @returns {Promise<[T, string[]]>} */
async function logged(fn) {
  const lines = [];
  const { error } = console;
  console.error = (m) => lines.push(String(m));
  try {
    return [await fn(), lines];
  } finally {
    console.error = error;
  }
}

test('#553 blocker 2: text cut inside a character (a lone surrogate) imports repaired with U+FFFD, in the snapshot’s documents and the log’s events', async () => {
  const half = 'Hello 😀'.slice(0, -1); // the old clipText’s cut: a title ending in half an emoji
  assert.ok(!(/** @type {any} */ (half).isWellFormed()));
  const state = { ...emptyState(), seq: 1, threads: { t1: { id: 't1', title: half, members: [] } } };
  const dir = await folderWith(state, [{ seq: 2, type: 'thread', data: { id: 't2', title: `${half} too`, members: [] } }]);
  const [s, lines] = await logged(() => open(dir));
  assert.equal(s.state.threads.t1.title, 'Hello �');
  assert.equal(s.state.threads.t2.title, 'Hello � too');
  assert.deepEqual(
    (await s.backlog(1)).map((e) => e.data.title),
    ['Hello � too'],
    'the stream holds the repaired event',
  );
  assert.ok(
    lines.some((m) => /cut inside a character.*U\+FFFD/.test(m)),
    `the import says it repaired text: ${lines.join(' | ')}`,
  );
  assert.equal((await open(dir)).state.threads.t1.title, 'Hello �', 'and a restart reads the same from the documents');
});

test('#553 blocker 2: a document nested deeper than the store holds is left out and reported, naming it and the backup; the rest imports', async () => {
  // An app document is {v, d: {id, state}}: its state’s depth plus two. 125 is the deepest the store takes; 130 is past it.
  const apps = { deep: { id: 'deep', state: nested(130) }, edge: { id: 'edge', state: nested(125) }, flat: { id: 'flat', state: { a: 1 } } };
  const dir = await folderWith({ ...emptyState(), seq: 2, threads: { t1: { id: 't1', members: [] } }, apps });
  const [s, lines] = await logged(() => open(dir));
  assert.ok(s.state.threads.t1);
  assert.equal(s.state.apps.deep, undefined, 'the document Redis would refuse is left out');
  assert.deepEqual(s.state.apps.flat.state, { a: 1 });
  assert.deepEqual(s.state.apps.edge.state, nested(125), 'one at the limit is kept');
  const said = lines.filter((m) => /left out/.test(m));
  assert.equal(said.length, 1, lines.join(' | '));
  assert.match(said[0], /app “deep”.*nested 132 levels deep.*holds up to 127/s);
  const [backup] = await readdir(join(dir, 'backups'));
  assert.ok(said[0].includes(join(dir, 'backups', backup)), 'the report names the backup that keeps it');
  assert.equal(JSON.parse(await readFile(join(dir, 'backups', backup, 'snapshot.json'), 'utf8')).apps.deep.id, 'deep');
});

/**
 * An old data folder whose Redis already runs with nothing in it, so importLegacy can be called on it by hand: the
 * store is opened on the empty folder, then the old files are put in.
 * @param {number} cut
 */
async function withStore(cut) {
  const { dir, evs } = await oldFolder(cut);
  const names = await readdir(dir);
  const empty = await scratch();
  const s = await open(empty);
  for (const n of names) await rename(join(dir, n), join(empty, n));
  return { dir: empty, evs, s };
}

// gpt’s r10 review of #553, blocker 3: a refusal the checks don’t foresee was treated as the known ones, and the document
// left out, so a valid conversation went missing from a store whose import reported success. The known unsupported
// values (nesting past REDIS_DEPTH, a lone surrogate) are handled and reported; any other refusal fails the import
// closed, naming the document and Redis’s reason, on the failed-import path: attempts counted, the way out said, the
// next start imports again.
test('an unforeseen refusal cannot turn a valid conversation into a successful import with its header missing', async () => {
  const { dir, s } = await withStore(20);
  const client = /** @type {any} */ (s.client);
  const call = client.call.bind(client);
  client.call = async (...a) => {
    if (a[0] === 'EVAL' && a.some((x, i) => x === 'S' && a[i + 1] === 'thread:th_room1'))
      throw Object.assign(new Error('unforeseen document refusal'), { code: 'ERR' });
    return call(...a);
  };
  const [failed, lines] = await logged(() =>
    importLegacy(dir, client).then(
      () => assert.fail('imported'),
      (e) => e,
    ),
  );
  assert.equal(failed.code, 'EIMPORT');
  assert.equal(failed.cause, 'import-failed');
  assert.equal(failed.attempts, 1);
  assert.match(failed.message, /thread “th_room1”/, `names the document: ${failed.message}`);
  assert.match(failed.message, /unforeseen document refusal/, `and Redis’s reason: ${failed.message}`);
  assert.match(failed.message, /imports them again when it next starts.*--fresh/s, `says the way out: ${failed.message}`);
  assert.equal(lines.filter((m) => /left out/.test(m)).length, 0, `nothing is reported as left out: ${lines.join(' | ')}`);
  assert.equal(await client.call('GET', 'seq'), null, 'no seq: the import did not report success');
  assert.ok(await client.call('GET', 'importing'), 'the import is still marked in progress, so the next start imports again');
  client.call = call;
  // The cause gone, the next start imports everything, the conversation’s header with it.
  const again = await open(dir);
  assert.ok(again.state.threads.th_room1, 'the valid conversation is in');
  assert.ok(again.state.threads.th_room0 && again.state.threads.th_room2);
  assert.equal(await client.call('GET', 'import-attempts'), null);
});

test('#553 blocker 2: an import that fails says why, names the backup and the way out, counts its attempts, and the next start imports again', async () => {
  const { dir, s } = await withStore(20);
  const client = /** @type {any} */ (s.client);
  const call = client.call.bind(client);
  const dropping = async (...a) => {
    if (a[0] === 'EVAL' && Number(a[5]) > 0) throw Object.assign(new Error('simulated: the connection dropped'), { code: 'ESTOREDOWN' });
    return call(...a);
  };
  client.call = dropping;
  const [first] = await logged(() =>
    importLegacy(dir, client).then(
      () => assert.fail('imported'),
      (e) => e,
    ),
  );
  assert.equal(first.code, 'EIMPORT');
  assert.equal(first.cause, 'import-failed');
  const [backup] = await readdir(join(dir, 'backups'));
  assert.match(first.message, /couldn’t import the old store/);
  assert.ok(first.message.includes(join(dir, 'backups', backup)), `names the backup: ${first.message}`);
  assert.match(first.message, /simulated: the connection dropped/);
  assert.match(first.message, /imports them again when it next starts.*--fresh/s, `says the way out: ${first.message}`);
  assert.match(first.message, /attempt 1\b/);
  const [second] = await logged(() =>
    importLegacy(dir, client).then(
      () => assert.fail('imported'),
      (e) => e,
    ),
  );
  assert.match(second.message, /attempt 2\b/, 'a start after a failed import says how many times it has failed');
  client.call = call;
  assert.deepEqual(JSON.parse(await client.call('GET', 'import-attempts')).attempts, 2);
  await assert.doesNotReject(importLegacy(dir, client));
  assert.equal(await client.call('GET', 'import-attempts'), null, 'a finished import clears its count');
  assert.equal((await readdir(join(dir, 'backups'))).length, 1, 'the attempts share one backup');
});
