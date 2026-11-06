// The measurement triggers (tools/uat/triggers-measure.mjs): each fires on a run’s facts that show what it names, and
// stays silent on facts that don’t. erased-conversation-commands (#729): the facts are built inline, in the shapes a run
// records: the tester’s deletes and Undos (facts.probes.conversation, tools/uat/conversation-step.mjs) and the turns’
// streams (tools/uat/run-files.mjs). key-frame-measured (#508): it fires when a run with --measure-key-frame measured
// its own seeded room and wrote the report; it doesn’t judge the numbers, the report does. Its rooms are the big-room
// seed, as the run writes it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Store } from '../server/store.mjs';
import { seedBigRoom } from '../tools/uat/big-room.mjs';
import { newProbes } from '../tools/uat/probes.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { TRIGGERS, triggersFired, unknownTriggers } from '../tools/uat/triggers.mjs';

const ID = 'erased-conversation-commands';
const T0 = Date.parse('2026-11-03T10:00:00Z');
const bash = (id) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 1' } }] } });
const turn = (sessionId, events) => ({
  handle: 'researcher',
  started: T0,
  ended: T0 + 20_000,
  events: [{ type: 'system', subtype: 'init', session_id: sessionId }, ...events],
});

/** A live session of the conversation the run kept. */
const LIVE = { s0: { id: 's0', handle: 'developer', backendState: { claudeSessionId: 'live-0' } } };

/** A run that deleted “Second” at T0 + 30 s, with researcher in it; Undo ran out 10 s later unless `undoAt`. */
function facts({ streams, undoAt = null, sessions = LIVE }) {
  const conversation = [{ do: 'delete', at: T0 + 30_000, threadId: 't2', title: 'Second', handles: ['researcher'], until: T0 + 40_000 }];
  if (undoAt !== null) conversation.push({ do: 'undo', at: undoAt, threadId: 't2' });
  return { state: { sessions, threads: {}, items: {} }, streams, probes: { conversation } };
}

test('erased-conversation-commands fires when a purged conversation’s session ran Bash calls', () => {
  const out = TRIGGERS[ID].run(facts({ streams: [turn('gone-1', [bash('b1'), bash('b2')])] }));
  assert.equal(out.length, 1);
  assert.equal(out[0].at, T0 + 40_000);
  assert.match(out[0].evidence, /“Second” was purged with 2 Bash calls in its turns \(by @researcher\)/);
});

test('erased-conversation-commands fires when the sessions left never ran a turn, or none is left (UAT 2026-11-04)', () => {
  const ran = [turn('gone-1', [bash('b1'), bash('b2')])];
  const fresh = { s1: { id: 's1', handle: 'developer', finishedAt: null }, s2: { id: 's2', handle: 'critic', finishedAt: null, backendState: {} } };
  for (const sessions of [fresh, {}]) {
    const out = TRIGGERS[ID].run(facts({ streams: ran, sessions }));
    assert.equal(out.length, 1, JSON.stringify(sessions));
    assert.match(out[0].evidence, /purged with 2 Bash calls/);
  }
});

test('erased-conversation-commands stays silent without a purge, a Bash call, or an erased session', () => {
  const ran = [turn('gone-1', [bash('b1')])];
  // Undo inside the window: nothing was purged.
  assert.deepEqual(TRIGGERS[ID].run(facts({ streams: ran, undoAt: T0 + 35_000 })), []);
  // Purged, but its turns ran no command: only another tool.
  const write = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'notes/a.md' } }] } };
  assert.deepEqual(TRIGGERS[ID].run(facts({ streams: [turn('gone-1', [write])] })), []);
  // The session that ran the command is still in the state.
  const held = { s1: { id: 's1', handle: 'researcher', backendState: { claudeSessionId: 'gone-1' } } };
  assert.deepEqual(TRIGGERS[ID].run(facts({ streams: ran, sessions: held })), []);
  // A session that ran a turn has no id, as before sessions kept them: no stream can be shown erased.
  const legacy = { s1: { id: 's1', handle: 'developer', finishedAt: T0, backendState: {} } };
  assert.deepEqual(TRIGGERS[ID].run(facts({ streams: ran, sessions: legacy })), []);
  // An erased session of an agent that wasn’t in the deleted conversation.
  assert.deepEqual(TRIGGERS[ID].run(facts({ streams: [{ ...ran[0], handle: 'critic' }] })), []);
  // A run that records deletes but did none: false, not unknown.
  assert.deepEqual(triggersFired({ state: { sessions: {} }, streams: [], probes: { conversation: [] } }, [ID]), { [ID]: false });
  // A run that records no deletes, or no streams, can’t say: unknown.
  assert.deepEqual(triggersFired({ state: { sessions: {} }, streams: [], probes: {} }, [ID]), { [ID]: null });
  assert.deepEqual(triggersFired({ state: { sessions: {} }, probes: { conversation: [] } }, [ID]), { [ID]: null });
  assert.equal(triggersFired(facts({ streams: ran }), [ID])[ID].at, T0 + 40_000);
});

test('assets-delete’s phase 1 waits on erased-conversation-commands, a trigger that exists', () => {
  const scenario = parseScenario(readFileSync(new URL('uat/e2e/scenarios/assets-delete.md', import.meta.url), 'utf8'));
  assert.ok(scenario.phases[0].triggers.includes(ID), JSON.stringify(scenario.phases[0]));
  assert.deepEqual(unknownTriggers(scenario), []);
});

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
