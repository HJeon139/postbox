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
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../server/store.mjs';
import { apply, emptyState } from '../shared/state.mjs';

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
