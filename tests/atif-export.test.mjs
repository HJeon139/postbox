// The ATIF exporter’s command and its recordings (tools/atif-export.mjs): one rebuilt from a data folder’s snapshot is
// partial, and is written only when asked. Built from the recorded run in tests/fixtures/atif/dry-run.md.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply, emptyState } from '../shared/state.mjs';
import { main, readRecording, SNAPSHOT_LOSES } from '../tools/atif-export.mjs';
import { streamRecorder } from '../tools/uat/history.mjs';
import { tempDir } from './temp-dirs.mjs';

const rec = readRecording(new URL('fixtures/atif/dry-run/', import.meta.url).pathname);

/**
 * A data folder whose log starts partway: the recorded run’s first half applied to a state, as the store’s snapshot
 * keeps it, and the rest as its log segment.
 */
function snapshotFolder() {
  const dir = join(tempDir('pb-atif-'), 'data');
  mkdirSync(dir, { recursive: true });
  const half = rec.events[Math.floor(rec.events.length / 2)].seq;
  const state = emptyState();
  for (const e of rec.events.filter((x) => x.seq <= half)) apply(state, e.type, e.data);
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify({ ...state, seq: half }));
  const rest = rec.events.filter((x) => x.seq > half);
  writeFileSync(join(dir, `events-${half + 1}.jsonl`), rest.map((e) => JSON.stringify(e)).join('\n'));
  return { dir, half };
}

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
