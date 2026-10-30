// The one-time import from the JSON Lines log and snapshot into Redis (server/store-import.mjs; #508’s design,
// “Migration, compatibility and rollback”, the Store step). At its first start on Redis, Postbox reads snapshot.json
// (or Stage 2’s store.json) and the events-*.jsonl segments as the old store did, dropping a torn last line, writes
// every document and the segments’ events to Redis, copies the old files into a dated backup and renames them
// *.migrated. It runs once: a store that already holds the snapshot’s seq is left alone.
//
// The room is recorded: tests/fixtures/uat/m1-turns.json holds the items of three UAT rooms (runs of
// 2026-10-22, papersurvey and wikisearch, recorded by tools/uat-run.mjs), written here as an old data folder.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appendFile, chmod, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { dataFolder, holdsStore, moveData } from '../server/home.mjs';
import { Store } from '../server/store.mjs';
import { clearStore, importLegacy } from '../server/store-import.mjs';
import { apply, emptyState } from '../shared/state.mjs';
import { admin } from './redis-fixture-user.mjs';

if (!process.env.POSTBOX_REDIS_HOME) throw new Error('Set POSTBOX_REDIS_HOME (tests/AGENTS.md, “The store’s Redis”).');

const ROOMS = JSON.parse(readFileSync(new URL('./fixtures/uat/m1-turns.json', import.meta.url), 'utf8'));

const dirs = [];
const stores = [];
after(async () => {
  for (const s of stores) await s.close().catch(() => {});
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
const open = async (dir) => {
  const s = await new Store(dir).load();
  stores.push(s);
  return s;
};

/** The recorded rooms as events: a thread and a session each, their items, and the changes a live room makes. */
function roomEvents() {
  const evs = [];
  const add = (type, data) => evs.push({ seq: evs.length + 1, type, data });
  add('settings', { theme: 'dark' });
  ROOMS.forEach((room, r) => {
    const t = `th_room${r}`;
    add('thread', { id: t, title: room.about, members: [`se_${r}`] });
    // Costs as the room copy has them: sums needing 17 significant digits, which RedisJSON parses to a neighbor.
    add('work.add', { convId: t, entry: { id: `w_${r}`, kind: 'turn', costUsd: 1.6202103999999997 + r, ms: 1234 } });
    add('session', { id: `se_${r}`, threadId: t, handle: 'researcher', state: 'idle' });
    for (const it of room.items) add('item.add', { threadId: t, item: structuredClone(it) });
  });
  const last = ROOMS[2].items;
  add('item.text', { threadId: 'th_room2', id: last[1].id, text: ' (more)' });
  add('item.patch', { threadId: 'th_room2', id: last[1].id, patch: { status: 'done' }, activityStep: { id: 'st1', kind: 'tool' } });
  add('item.move', { threadId: 'th_room2', id: last[0].id, stub: { id: 'it_stub', kind: 'stub' }, patch: { movedAt: 1 } });
  add('session.patch', { id: 'se_0', patch: { state: 'gen' }, unset: ['handle'] });
  add('glossary', { threadId: 'th_room0', entry: { key: 'aof', term: 'AOF', definition: 'append-only file' } });
  add('remove', { kind: 'session', id: 'se_1' });
  add('boilerplate', { id: 'bp1', name: 'one' });
  add('boilerplate', { id: 'bp2', name: 'two' });
  add('boilerplate', { id: 'bp1', name: 'one again' });
  add('work.add', { convId: 'th_room2', entry: { id: 'w_sum', kind: 'turn', costUsd: 0.1 + 0.2, tokens: { input: 7 } } });
  add('work.patch', { convId: 'th_room2', id: 'w_sum', patch: { summaryCostUsd: 0.0015241999999999999 } });
  return evs;
}

/** The state the old store loaded from these: the snapshot, then the log replayed with the shared reducer. */
function todaysState(evs) {
  const s = emptyState();
  for (const ev of evs) {
    apply(s, ev.type, structuredClone(ev.data));
    s.seq = ev.seq;
  }
  return s;
}

/** The state with its costs rounded to 12 places, as the import writes them (#525); everything else exact. @param {any} s */
function costsRounded(s) {
  const r = (v) => (typeof v === 'number' ? Math.round(v * 1e12) / 1e12 : v);
  for (const list of Object.values(s.work ?? {})) for (const e of list) for (const k of ['costUsd', 'summaryCostUsd']) if (k in e) e[k] = r(e[k]);
  return s;
}

/** An old data folder: a snapshot of the first `cut` events, a segment with the rest, and a torn last line. */
async function oldFolder(cut) {
  const dir = await mkdtemp(join(tmpdir(), 'pb-store-import-'));
  dirs.push(dir);
  const evs = roomEvents();
  await writeFile(join(dir, 'snapshot.json'), JSON.stringify(todaysState(evs.slice(0, cut))));
  await writeFile(
    join(dir, `events-${cut + 1}.jsonl`),
    evs
      .slice(cut)
      .map((e) => `${JSON.stringify(e)}\n`)
      .join(''),
  );
  await appendFile(join(dir, `events-${cut + 1}.jsonl`), `{"seq":${evs.length + 1},"type":"thread","data":{"id":"torn"`);
  return { dir, evs };
}

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
