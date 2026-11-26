// The ATIF exporter’s command and its recordings (tools/atif-export.mjs): one rebuilt from a data folder’s snapshot is
// partial, is written only when asked, and counts no event twice. Built from the recorded run in
// tests/fixtures/atif/dry-run.md.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply, EVENTS, emptyState } from '../shared/state.mjs';
import { trajectories } from '../tools/atif.mjs';
import { main, POSTBOX_VERSION, readRecording, SNAPSHOT_LOSES } from '../tools/atif-export.mjs';
import { streamRecorder } from '../tools/uat/history.mjs';
import { tempDir } from './temp-dirs.mjs';

const rec = readRecording(new URL('fixtures/atif/dry-run/', import.meta.url).pathname);

/** The recorded run’s events the store has on this base: the run clock’s come with #1526. */
const stored = rec.events.filter((e) => Object.hasOwn(EVENTS, e.type));

/**
 * A data folder whose log starts partway: the recorded run’s first half applied to a state, as the store’s snapshot
 * keeps it, and the rest as its log segment, from `overlap` events before the snapshot’s seq, as a segment often does
 * (server/store-replay.mjs). `clocks` goes in the snapshot’s state as it is.
 */
function snapshotFolder({ overlap = 0, clocks } = {}) {
  const dir = join(tempDir('pb-atif-'), 'data');
  mkdirSync(dir, { recursive: true });
  const at = Math.floor(stored.length / 2);
  const half = stored[at].seq;
  const state = emptyState();
  // A copy of each event’s data: the state keeps the objects it’s given, and the next event changes them.
  for (const e of stored.slice(0, at + 1)) apply(state, e.type, structuredClone(e.data));
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify({ ...state, ...(clocks ? { clocks } : {}), seq: half }));
  const rest = stored.slice(at + 1 - overlap);
  writeFileSync(join(dir, `events-${rest[0].seq}.jsonl`), rest.map((e) => JSON.stringify(e)).join('\n'));
  return { dir, half, overlapped: stored.slice(at + 1 - overlap, at + 1) };
}

test('a data folder’s segment that repeats events the snapshot has counts each once', () => {
  const { dir, overlapped } = snapshotFolder({ overlap: 12 });
  // The repeated events include a reply’s words and an item’s adding, which would double the one and the other.
  assert.ok(overlapped.some((e) => e.type === 'item.text'));
  assert.ok(overlapped.some((e) => e.type === 'item.add'));
  const export_ = (d) => trajectories(readRecording(d).events, { version: POSTBOX_VERSION, prompts: rec.prompts }).map((t) => t.trajectory);
  assert.deepEqual(export_(dir), export_(snapshotFolder().dir));
});

test('a snapshot’s void clock keeps its run void in the export, and says what a snapshot loses of a clock', () => {
  const sessionId = stored.find((e) => e.type === 'session' && e.data.handle === 'dry').data.id;
  // A clock as the run clock’s state keeps one (#1526): expired, with `voided` from a forced stop.
  const clock = { sessionId, threadId: 'th_9rDc0zBs', budgetMs: 30_000, state: 'expired', startedAt: 1_000, expiredAt: 9_000 };
  const voided = { why: 'watchdog', at: 9_000 };
  const traj = (clocks) =>
    trajectories(readRecording(snapshotFolder({ clocks }).dir).events, { version: POSTBOX_VERSION }).find((x) => x.sessionId === sessionId).trajectory;
  const v = traj({ [sessionId]: { ...clock, voided } });
  assert.deepEqual(v.extra.clock_void, { why: 'watchdog', at: new Date(9_000).toISOString() });
  assert.match(v.notes, /^Void as a timed run: Postbox couldn’t confirm one of the agent’s stopped turns ended \(watchdog\)/);
  assert.equal(traj({ [sessionId]: clock }).extra.clock_void, undefined, 'an expiry without voided is no void');
  assert.match(SNAPSHOT_LOSES[0], /with whether its run was void, are rebuilt/);
  // #1749: a run the person ended comes back ended, with its time used, and a void after the end stays void.
  const ended = { ...clock, state: 'ended', expiredAt: null, usedMs: 4_000, endedAt: 5_000 };
  const e = traj({ [sessionId]: ended });
  assert.deepEqual(
    e.extra.clock_events.slice(0, 2).map((x) => [x.event, x.elapsedMs]),
    [
      ['clock.started', undefined],
      ['clock.ended', 4_000],
    ],
    'the snapshot’s start and end come first, before the log’s own events',
  );
  assert.equal(e.extra.clock_void, undefined, 'an end without voided is no void');
  assert.deepEqual(traj({ [sessionId]: { ...ended, voided } }).extra.clock_void, { why: 'watchdog', at: new Date(9_000).toISOString() });
});

test('a data folder’s snapshot gives a partial record, which the exporter refuses to write without --partial', (t) => {
  const { dir, half } = snapshotFolder();
  const got = readRecording(dir);
  assert.deepEqual(got.partial, { reconstructed_before_event: half + 1, lost: SNAPSHOT_LOSES });
  const out = join(dir, '..', 'out');
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  assert.equal(main([dir, '--out', out]), 1);
  assert.equal(existsSync(out), false, 'nothing written');
  assert.equal(main([dir, '--out', out, '--partial']), 0);
  const files = readdirSync(out);
  assert.ok(files.length > 0);
  for (const f of files) {
    const traj = JSON.parse(readFileSync(join(out, f), 'utf8'));
    assert.deepEqual(traj.extra.partial.lost, [...SNAPSHOT_LOSES]);
    assert.match(traj.notes, /^Partial: steps before event \d+ are rebuilt from the store’s snapshot/);
  }
});

test('the UAT kit’s recorder notes where its stream had to resync, so a run’s record says what it lost', () => {
  const rec2 = streamRecorder();
  const item = (seq, id) => `id: ${seq}\nevent: item.add\ndata: ${JSON.stringify({ threadId: 't', item: { id, kind: 'user', at: 1 } })}`;
  rec2.take(item(1, 'i1'));
  // As server/live-streams.mjs sends it when the backlog no longer covers `since`, or after a new epoch.
  rec2.take('event: resync\ndata: {}');
  rec2.take('event: resync\ndata: {}');
  rec2.take(item(900, 'i900'));
  assert.deepEqual(
    rec2.gaps().map((g) => g.after),
    [1],
    'one gap, once, after the last event it had',
  );
  assert.deepEqual(
    rec2.events().map((e) => e.seq),
    [1, 900],
  );
});

test('a run whose stream lost events exports its trajectories marked partial, with where it lost them', (t) => {
  const dir = tempDir('pb-atif-gaps-');
  for (const f of ['events.jsonl', 'live.jsonl']) writeFileSync(join(dir, f), readFileSync(new URL(`fixtures/atif/dry-run/${f}`, import.meta.url), 'utf8'));
  writeFileSync(join(dir, 'stream-gaps.json'), JSON.stringify([{ after: 40, at: 1 }]));
  const out = join(dir, 'out');
  t.mock.method(console, 'log', () => {});
  assert.equal(main([dir, '--out', out]), 0);
  for (const f of readdirSync(out)) {
    const traj = JSON.parse(readFileSync(join(out, f), 'utf8'));
    assert.deepEqual(traj.extra.partial.stream_gaps, [{ after: 40, at: 1 }]);
    assert.match(traj.notes, /^Partial: the recording of \/api\/stream lost events once, after event 40/);
  }
});

test('a gap after a restart names its epoch, since event numbers start lower again there', (t) => {
  const dir = tempDir('pb-atif-gaps-');
  for (const f of ['events.jsonl', 'live.jsonl']) writeFileSync(join(dir, f), readFileSync(new URL(`fixtures/atif/dry-run/${f}`, import.meta.url), 'utf8'));
  writeFileSync(
    join(dir, 'stream-gaps.json'),
    JSON.stringify([
      { after: 40, at: 1, epoch: 0 },
      { after: 3, at: 2, epoch: 1 },
    ]),
  );
  const out = join(dir, 'out');
  t.mock.method(console, 'log', () => {});
  assert.equal(main([dir, '--out', out]), 0);
  for (const f of readdirSync(out)) assert.match(JSON.parse(readFileSync(join(out, f), 'utf8')).notes, /lost events 2 times, after event 40, 3 of epoch 1,/);
});

test('after a restart numbers events from lower again, the recorder keeps them, in their own epoch, after one gap', () => {
  const r = streamRecorder();
  const item = (seq, id) => `id: ${seq}\nevent: item.add\ndata: ${JSON.stringify({ threadId: 't', item: { id, kind: 'user', at: 1 } })}`;
  // As server/live-streams.mjs opens a stream: its epoch first. After the restart, the new epoch, then a resync.
  r.take('event: epoch\ndata: "epoch-a"');
  r.take(item(100, 'before'));
  r.take('event: epoch\ndata: "epoch-b"');
  r.take('event: resync\ndata: {}');
  r.take(item(90, 'after-1'));
  r.take(item(91, 'after-2'));
  assert.deepEqual(
    r.events().map((e) => [e.seq, e.epoch ?? 0]),
    [
      [100, 0],
      [90, 1],
      [91, 1],
    ],
  );
  assert.deepEqual(
    r.gaps().map((g) => [g.after, g.epoch]),
    [[100, 0]],
  );
  assert.equal(r.last(), 91);
  assert.equal(r.epoch(), '"epoch-b"');
});

test('a stream cut off and reopened in the same epoch notes the live frames it lost, and the export says so', (t) => {
  const r = streamRecorder();
  r.take('event: epoch\ndata: "epoch-a"');
  r.take(`id: 40\nevent: item.add\ndata: ${JSON.stringify({ threadId: 't', item: { id: 'i40', kind: 'user', at: 1 } })}`);
  // followEvents, when an open stream ends: its events come again from `since`, its live frames don’t.
  r.dropped();
  assert.deepEqual(
    r.gaps().map((g) => [g.after, g.lost]),
    [[40, 'live']],
  );
  const dir = tempDir('pb-atif-cut-');
  for (const f of ['events.jsonl', 'live.jsonl']) writeFileSync(join(dir, f), readFileSync(new URL(`fixtures/atif/dry-run/${f}`, import.meta.url), 'utf8'));
  writeFileSync(join(dir, 'stream-gaps.json'), JSON.stringify(r.gaps()));
  const out = join(dir, 'out');
  t.mock.method(console, 'log', () => {});
  assert.equal(main([dir, '--out', out]), 0);
  const traj = JSON.parse(readFileSync(join(out, readdirSync(out)[0]), 'utf8'));
  assert.match(traj.notes, /^Partial: the recording of \/api\/stream was cut off once, after event 40, so tool inputs and outputs sent while it was away/);
});
