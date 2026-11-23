// The UAT kit keeping what a run’s ATIF trajectories read (tools/uat/room-events.mjs, tools/uat/history.mjs), and no
// more. The fixture is a recorded /api/stream: tests/fixtures/atif/dry-run.md says how it was made.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readHistory } from '../tools/uat/history.mjs';
import { keepEvent } from '../tools/uat/room-events.mjs';
import { CLOCK_EVENTS } from './atif-clock-events.mjs';
import { tempDir } from './temp-dirs.mjs';

const DIR = new URL('fixtures/atif/dry-run/', import.meta.url).pathname;

test('the UAT history keeps the clock’s events, a reply’s stored words, the inboxes and the ledger’s turns and calls', () => {
  const lines = readFileSync(`${DIR}events.jsonl`, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  for (const type of ['clock.started', 'clock.turn', 'clock.expired', 'item.text', 'entry.add', 'entry.patch', 'work.add', 'work.patch']) {
    const e = lines.find((x) => x.type === type);
    assert.ok(e, `the fixture has a ${type}`);
    assert.deepEqual(keepEvent(e.seq, e.type, e.data, new Map(), CLOCK_EVENTS), { seq: e.seq, type, data: e.data }, type);
  }
  // Only a public type is kept: without the run clock’s events in EVENTS (#1526), its events are never recorded.
  const started = lines.find((x) => x.type === 'clock.started');
  assert.equal(keepEvent(started.seq, started.type, started.data, new Map(), { ...CLOCK_EVENTS, 'clock.started': { public: false } }), null);
  assert.ok(lines.some((x) => x.type === 'work.add' && x.data.entry.kind === 'command'));
  // A ledger entry the trajectories don’t read (a file’s change, a publish) isn’t kept.
  assert.equal(keepEvent(1, 'work.add', { convId: 'th_1', entry: { kind: 'publish', id: 'w_1' } }), null);
});

test('a run’s history from Postbox’s log keeps what the trajectories read, and still drops what nothing reads', () => {
  // The kept set grew for the export (a reply’s stored words, the inboxes, the ledger’s turns and calls), so this
  // holds that the history is still a cut: an app, a ledger entry nothing reads and a session’s persona aren’t kept.
  const dir = tempDir('pb-atif-history-');
  mkdirSync(join(dir, 'data'));
  const text = { seq: 2, type: 'item.text', data: { threadId: 't1', id: 'x', text: 'Try' } };
  const log = [
    { seq: 1, type: 'session', data: { id: 's2', state: 'think', personaSnapshot: { instructions: 'long' } } },
    text,
    { seq: 3, type: 'work.add', data: { convId: 't1', entry: { id: 'w_1', kind: 'publish' } } },
    { seq: 4, type: 'app', data: { id: 'ap_1', title: 'An app' } },
  ];
  writeFileSync(join(dir, 'data', 'events-1.jsonl'), log.map((e) => JSON.stringify(e)).join('\n'));
  assert.deepEqual(readHistory(dir), [{ seq: 1, type: 'session', data: { id: 's2', state: 'think', finishedAt: null, updatedAt: null } }, text]);
});
