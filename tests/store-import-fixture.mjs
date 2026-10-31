// The old data folders the import’s tests read (tests/store-import.test.mjs, tests/store-import-valid.test.mjs): the
// room recorded in tests/fixtures/uat/m1-turns.json (the items of three UAT rooms: runs of 2026-10-22, papersurvey and
// wikisearch, recorded by tools/uat-run.mjs), written as an old data folder, and the stores the tests open, closed after
// each file’s tests.

import { readFileSync } from 'node:fs';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { Store } from '../server/store.mjs';
import { apply, emptyState } from '../shared/state.mjs';

if (!process.env.POSTBOX_REDIS_HOME) throw new Error('Set POSTBOX_REDIS_HOME (tests/AGENTS.md, “The store’s Redis”).');

export const ROOMS = JSON.parse(readFileSync(new URL('./fixtures/uat/m1-turns.json', import.meta.url), 'utf8'));

export const dirs = [];
const stores = [];
after(async () => {
  for (const s of stores) await s.close().catch(() => {});
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
export const open = async (dir) => {
  const s = await new Store(dir).load();
  stores.push(s);
  return s;
};

/** A scratch data folder, removed after the file’s tests. */
export const scratch = async () => {
  const d = await mkdtemp(join(tmpdir(), 'pb-store-import-'));
  dirs.push(d);
  return d;
};

/** The recorded rooms as events: a thread and a session each, their items, and the changes a live room makes. */
export function roomEvents() {
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
export function todaysState(evs) {
  const s = emptyState();
  for (const ev of evs) {
    apply(s, ev.type, structuredClone(ev.data));
    s.seq = ev.seq;
  }
  return s;
}

/** The state with its costs rounded to 12 places, as the import writes them (#525); everything else exact. @param {any} s */
export function costsRounded(s) {
  const r = (v) => (typeof v === 'number' ? Math.round(v * 1e12) / 1e12 : v);
  for (const list of Object.values(s.work ?? {})) for (const e of list) for (const k of ['costUsd', 'summaryCostUsd']) if (k in e) e[k] = r(e[k]);
  return s;
}

/** An old data folder: a snapshot of the first `cut` events, a segment with the rest, and a torn last line. */
export async function oldFolder(cut) {
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
