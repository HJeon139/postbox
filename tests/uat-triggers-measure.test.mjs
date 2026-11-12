// The measurement triggers (tools/uat/triggers-measure.mjs): each fires on a run’s facts that show what it names, and
// stays silent on facts that don’t. key-frame-measured (#508): it fires when a run with --measure-key-frame measured
// its own seeded room and wrote the report; it doesn’t judge the numbers, the report does. Its rooms are the big-room
// seed, as the run writes it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { seedBigRoom } from '../tools/uat/big-room.mjs';
import { newProbes } from '../tools/uat/probes.mjs';
import { TRIGGERS, triggersFired } from '../tools/uat/triggers.mjs';

/** A run’s facts after `- seed: big-room`, with --measure-key-frame on, and what it recorded of a measurement, if any. */
function seededRun(keyFrame = []) {
  const store = new Store(null);
  store.emit('thread', { id: 'th_big', kind: 'room', title: 'The release, in a long room', members: [] });
  seedBigRoom(store, 'th_big');
  return { state: store.state, threads: ['th_big'], probes: { ...newProbes(), keyFrameOn: true, keyFrame } };
}

const measured = { threadId: 'th_big', items: 1000, keys: 40, below: 0, report: 'key-frame.md', at: 1 };

test('key-frame-measured fires when the run measured its own room and wrote the report', () => {
  const hits = TRIGGERS['key-frame-measured'].run(seededRun([measured]));
  assert.equal(hits.length, 1);
  assert.match(hits[0].evidence, /40 keys in th_big’s 1,000 items/);
  assert.match(hits[0].evidence, /key-frame\.md/);
});

test('key-frame-measured stays silent on a seeded run that didn’t measure, and says the run could have shown it', () => {
  const f = seededRun();
  assert.deepEqual(TRIGGERS['key-frame-measured'].run(f), []);
  assert.deepEqual(triggersFired(f, ['key-frame-measured']), { 'key-frame-measured': false });
});

test('key-frame-measured can’t tell on a run without --measure-key-frame, or a recheck of one from before it recorded that', () => {
  const off = seededRun();
  off.probes.keyFrameOn = false;
  // A recheck merges the run’s saved probes over newProbes(), as tools/uat/recheck.mjs’s savedFacts() does.
  const saved = { fullScreen: [], answers: [] };
  const older = seededRun();
  older.probes = { ...newProbes(), ...saved };
  for (const f of [off, older]) assert.deepEqual(triggersFired(f, ['key-frame-measured']), { 'key-frame-measured': null });
});

test('key-frame-measured stays silent on a measurement of another conversation, one that wrote no report, one that failed, or one of no keys', () => {
  const other = seededRun([{ ...measured, threadId: 'th_other' }]);
  const unwritten = seededRun([{ ...measured, report: null }]);
  const failed = seededRun([{ ...measured, keys: 0, report: null, error: 'Timed out waiting for: the composer' }]);
  assert.deepEqual(TRIGGERS['key-frame-measured'].run(other), []);
  assert.deepEqual(TRIGGERS['key-frame-measured'].run(unwritten), []);
  assert.deepEqual(TRIGGERS['key-frame-measured'].run(failed), []);
  assert.deepEqual(TRIGGERS['key-frame-measured'].run(seededRun([{ ...measured, keys: 0 }])), [], 'a report of no keys measured nothing');
});

test('key-frame-measured fires on a fast machine’s room, where most keys had no Event Timing entry: the report judges it', () => {
  const run = (m) => TRIGGERS['key-frame-measured'].run(seededRun([{ ...measured, ...m }]));
  assert.equal(run({ below: 20 }).length, 1, 'half the keys under one frame');
  assert.equal(run({ below: 40 }).length, 1, 'every key under one frame');
  assert.deepEqual(run({ keys: '40' }), [], 'a count that isn’t a number measured nothing');
});
