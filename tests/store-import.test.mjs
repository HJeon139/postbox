// The one-time import from the JSON Lines log and snapshot into Redis (server/store-import.mjs; #508’s design,
// “Migration, compatibility and rollback”, the Store step). At its first start on Redis, Postbox reads snapshot.json
// (or Stage 2’s store.json) and the events-*.jsonl segments as the old store did, dropping a torn last line, writes
// every document and the segments’ events to Redis, copies the old files into a dated backup and renames them
// *.migrated. It runs once: a store that already holds the snapshot’s seq is left alone.
//
// The room is recorded: tests/fixtures/uat/m1-turns.json holds the items of three UAT rooms (runs of
// 2026-10-22, papersurvey and wikisearch, recorded by tools/uat-run.mjs), written here as an old data folder.

import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dataFolder, holdsStore, moveData } from '../server/home.mjs';
import { Store } from '../server/store.mjs';
import { clearStore, importLegacy } from '../server/store-import.mjs';
import { emptyState } from '../shared/state.mjs';
import { admin } from './redis-fixture-user.mjs';
import { costsRounded, dirs, oldFolder, open, roomEvents, todaysState } from './store-import-fixture.mjs';

test('importing a recorded room gives the state the old store loaded, and its log’s events in the stream', async () => {
  const { dir, evs } = await oldFolder(20);
  const s = await open(dir);
  const want = costsRounded(todaysState(evs));
  assert.notDeepEqual(want, todaysState(evs), 'the room has costs that need rounding');
  assert.deepEqual(s.state, want);
  assert.equal(s.state.work.th_room2.at(-1).costUsd, 0.3);
  assert.equal(s.state.threads.torn, undefined, 'the torn last line is dropped');
  assert.deepEqual(Object.keys(s.state.boilerplates), ['bp2', 'bp1']);
  assert.deepEqual(
    (await s.backlog(20)).map((e) => e.seq),
    evs.slice(20).map((e) => e.seq),
  );
  const again = await open(dir);
  assert.deepEqual(again.state, want, 'and the same after a restart, from the documents alone');
});

test('the old files are renamed *.migrated beside a dated backup of them', async () => {
  const { dir } = await oldFolder(20);
  await open(dir);
  const names = await readdir(dir);
  assert.ok(names.includes('snapshot.json.migrated'));
  assert.ok(names.includes('events-21.jsonl.migrated'));
  assert.ok(!names.includes('snapshot.json'));
  const [backup] = await readdir(join(dir, 'backups'));
  assert.match(backup, /^store-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
  assert.deepEqual((await readdir(join(dir, 'backups', backup))).sort(), ['events-21.jsonl', 'snapshot.json']);
  assert.equal(await readFile(join(dir, 'backups', backup, 'snapshot.json'), 'utf8'), await readFile(join(dir, 'snapshot.json.migrated'), 'utf8'));
});

test('the import runs once: a store that already holds the snapshot’s seq is left alone', async () => {
  const { dir, evs } = await oldFolder(20);
  const a = await open(dir);
  a.emit('thread', { id: 'after', members: [] });
  await a.flush();
  // The old files come back, as if a copy were restored over the folder: Redis is ahead, so nothing is imported.
  for (const n of await readdir(dir)) if (n.endsWith('.migrated')) await writeFile(join(dir, n.replace(/\.migrated$/, '')), await readFile(join(dir, n)));
  const b = await open(dir);
  assert.ok(b.state.threads.after);
  assert.equal(b.state.seq, evs.length + 1);
  assert.equal((await readdir(join(dir, 'backups'))).length, 1, 'no second backup');
});

test('Stage 2’s store.json is imported as the first snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-store-import-'));
  dirs.push(dir);
  await writeFile(join(dir, 'store.json'), JSON.stringify({ version: 1, seq: 7, threads: { old: { id: 'old', members: [] } } }));
  const s = await open(dir);
  assert.equal(s.state.seq, 7);
  assert.ok(s.state.threads.old);
  const names = await readdir(dir);
  assert.ok(names.includes('store.json.migrated'));
});

// Review finding 3 on #525 (gpt’s regression): an import cut short after its first batch of events left Redis at seq
// 1000 of 1001, which the next start took for another store’s events (EIMPORT). The import marks itself in progress, so
// a start after it was cut short clears what it wrote and imports again.
test('an import cut short after its first batch of events runs again from the start', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-store-import-'));
  dirs.push(dir);
  const s = await open(dir);
  const rows = Array.from({ length: 1001 }, (_, i) => JSON.stringify({ seq: i + 1, type: 'settings', data: { value: i + 1 } }));
  await writeFile(join(dir, 'events-1.jsonl'), `${rows.join('\n')}\n`);
  const client = /** @type {any} */ (s.client);
  const orig = client.call.bind(client);
  let n = 0;
  client.call = async (...a) => {
    if (a[0] === 'EVAL' && Number(a[5]) > 0 && ++n === 2) throw new Error('simulated disconnect');
    return orig(...a);
  };
  await assert.rejects(importLegacy(dir, client), /simulated disconnect/);
  client.call = orig;
  await assert.doesNotReject(importLegacy(dir, client));
  assert.equal(await client.call('GET', 'seq'), '1001');
  const a = await admin(s);
  assert.equal(await a.call('XLEN', 'events'), 1001);
  assert.equal(await a.call('EXISTS', 'importing'), 0, 'the import is no longer marked in progress');
  a.close();
  assert.equal((await open(dir)).state.settings.value, 1001);
});

// Review finding 4 on #525 (gpt’s regression): the import renames the old files *.migrated, and a clone’s data/ that
// held only those stopped counting as holding conversations, so the next start silently used ~/.postbox instead.
test('an imported data folder still holds the store: a restart keeps using a clone’s data/, and --move-data moves it', async () => {
  const s = await open(await mkdtemp(join(tmpdir(), 'pb-store-import-')));
  const dir = /** @type {string} */ (s.dir);
  dirs.push(dir);
  await writeFile(join(dir, 'snapshot.json'), JSON.stringify({ ...emptyState(), seq: 1 }));
  assert.equal(holdsStore(dir), true);
  await importLegacy(dir, /** @type {any} */ (s.client));
  assert.equal(holdsStore(dir), true);

  const root = await mkdtemp(join(tmpdir(), 'pb-store-clone-'));
  dirs.push(root);
  const home = join(root, 'home');
  const clone = join(root, 'data');
  const old = await oldFolder(20);
  await rename(old.dir, clone);
  const first = await new Store(clone).load();
  first.emit('thread', { id: 'after', members: [] });
  await first.close();
  assert.ok(!(await readdir(clone)).includes('snapshot.json'), 'imported');
  assert.deepEqual(dataFolder({ root, env: {}, home }), { dataDir: clone, from: 'clone', home: join(home, '.postbox') }, 'the restart uses it');
  const { to } = await moveData({ root, env: {}, home });
  assert.equal(dataFolder({ root, env: {}, home }).dataDir, to);
  const moved = await open(to);
  assert.equal(moved.state.seq, old.evs.length + 1, 'the moved store has the import and what came after');
  assert.ok(moved.state.threads.after);
});

test('#553: the backup folder and its copies are the person’s alone (0700 and 0600), whatever the data folder’s mode', async () => {
  const { dir } = await oldFolder(3);
  await chmod(dir, 0o755);
  await open(dir);
  const [backup] = await readdir(join(dir, 'backups'));
  assert.equal((await stat(join(dir, 'backups'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, 'backups', backup))).mode & 0o777, 0o700);
  for (const f of await readdir(join(dir, 'backups', backup))) assert.equal((await stat(join(dir, 'backups', backup, f))).mode & 0o777, 0o600, f);
});

test('#553: a line that isn’t JSON before the end of the log is said in the log, and the rest of its segment skipped; a torn last line is quiet', async () => {
  const { dir, evs } = await oldFolder(3);
  // A damaged line in the middle of a segment before the last, with sound lines after it.
  await writeFile(join(dir, 'events-5.jsonl'), `${JSON.stringify(evs[4])}\n{"seq":6,"type":"thread","data":{"id":"half"\n${JSON.stringify(evs[6])}\n`);
  await rename(join(dir, 'events-4.jsonl'), join(dir, 'events-9.jsonl'));
  const logged = [];
  const { error } = console;
  console.error = (m) => logged.push(String(m));
  try {
    await open(dir);
  } finally {
    console.error = error;
  }
  const said = logged.filter((m) => /isn’t JSON/.test(m));
  assert.equal(said.length, 1, `one warning, for the damaged segment: ${logged.join(' | ')}`);
  assert.match(said[0], /Line 2 of .*events-5\.jsonl isn’t JSON.*1 line\(s\) after it/);
});

test('#553: a fresh start removes the store’s files, not the *.migrated copies an import left', async () => {
  const { dir } = await oldFolder(3);
  await open(dir);
  await writeFile(join(dir, 'snapshot.json'), '{}');
  await clearStore(dir);
  const names = await readdir(dir);
  assert.ok(names.includes('snapshot.json.migrated') && names.includes('events-4.jsonl.migrated'), names.join(','));
  assert.ok(!names.includes('snapshot.json'));
});

test('#553: “already imported” compares the files, not their seq alone: another store’s files at a lower seq are refused, not ignored', async () => {
  const { dir, evs } = await oldFolder(20);
  const a = await open(dir);
  a.emit('thread', { id: 'after', members: [] });
  await a.flush();
  await a.close();
  // Another old store’s files, at a seq this Redis already holds, appear in the data folder.
  const other = roomEvents().slice(0, 5);
  await writeFile(join(dir, 'snapshot.json'), JSON.stringify({ ...todaysState(other), threads: { strange: { id: 'strange', members: [] } } }));
  await assert.rejects(new Store(dir).load(), (e) => {
    assert.equal(e.code, 'EIMPORT');
    assert.match(e.message, /aren’t the ones this store was imported from/);
    assert.ok(e.message.includes(dir));
    return true;
  });
  assert.equal((await readdir(join(dir, 'backups'))).length, 1, 'nothing imported');
  await rm(join(dir, 'snapshot.json'));
  const b = await open(dir);
  assert.equal(b.state.seq, evs.length + 1);
});

// gpt’s r10 review of #553, blocker 1: `imported` was committed before the old files were renamed one by one, so a
// crash between the snapshot’s rename and a segment’s left the segment alone in the folder, which the next start hashed
// by itself and refused as another store’s. The import records each file it covered (name and hash) in `imported`: a
// start that finds some of them still in place, all matching, finishes the renames and goes on with the store.
test('a restart completes an import interrupted between legacy file renames', async () => {
  const { dir, evs } = await oldFolder(20);
  const first = await open(dir);
  const expected = costsRounded(todaysState(evs));
  assert.deepEqual(first.state, expected);
  await first.close();
  // Redis’s imported marker was committed; the snapshot’s rename completed, the segment’s did not.
  await rename(join(dir, 'events-21.jsonl.migrated'), join(dir, 'events-21.jsonl'));
  const again = await open(dir);
  assert.deepEqual(again.state, expected);
  const names = await readdir(dir);
  assert.ok(names.includes('events-21.jsonl.migrated') && !names.includes('events-21.jsonl'), `the rename is finished: ${names.join(',')}`);
  assert.equal((await readdir(join(dir, 'backups'))).length, 1, 'no second backup, nothing imported again');
});

test('a restart completes an import interrupted before any legacy file was renamed', async () => {
  const { dir, evs } = await oldFolder(20);
  const first = await open(dir);
  const expected = costsRounded(todaysState(evs));
  assert.deepEqual(first.state, expected);
  await first.close();
  for (const n of await readdir(dir)) if (n.endsWith('.migrated')) await rename(join(dir, n), join(dir, n.replace(/\.migrated$/, '')));
  const again = await open(dir);
  assert.deepEqual(again.state, expected);
  const names = await readdir(dir);
  assert.ok(names.includes('snapshot.json.migrated') && names.includes('events-21.jsonl.migrated'), names.join(','));
  assert.ok(!names.includes('snapshot.json') && !names.includes('events-21.jsonl'), names.join(','));
});

test('a file left from the import beside another store’s file is refused as a different store, naming the stranger', async () => {
  const { dir } = await oldFolder(20);
  const first = await open(dir);
  await first.close();
  await rename(join(dir, 'events-21.jsonl.migrated'), join(dir, 'events-21.jsonl'));
  await writeFile(
    join(dir, 'snapshot.json'),
    JSON.stringify({ ...todaysState(roomEvents().slice(0, 5)), threads: { strange: { id: 'strange', members: [] } } }),
  );
  await assert.rejects(new Store(dir).load(), (e) => {
    assert.equal(e.code, 'EIMPORT');
    assert.match(e.message, /aren’t the ones this store was imported from/);
    assert.match(e.message, /snapshot\.json/, `names the file that isn’t from the import: ${e.message}`);
    return true;
  });
  assert.ok((await readdir(dir)).includes('events-21.jsonl'), 'nothing renamed while a stranger is beside it');
});
