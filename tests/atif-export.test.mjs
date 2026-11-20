// The ATIF exporter’s command and its recordings (tools/atif-export.mjs): one rebuilt from a data folder’s snapshot is
// partial, and is written only when asked. Built from the recorded run in tests/fixtures/atif/dry-run.md.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply, emptyState } from '../shared/state.mjs';
import { main, readRecording, SNAPSHOT_LOSES } from '../tools/atif-export.mjs';
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
