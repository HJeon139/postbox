// The measurement triggers (tools/uat/triggers-measure.mjs): each fires on a run’s facts that show what it names, and
// stays silent on facts that don’t. The facts are built inline, in the shapes a run records: the tester’s deletes and
// Undos (facts.probes.conversation, tools/uat/conversation-step.mjs) and the turns’ streams (tools/uat/run-files.mjs).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
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
  // No session in the state has an id, as before sessions kept them: no stream can be shown erased.
  assert.deepEqual(TRIGGERS[ID].run(facts({ streams: ran, sessions: {} })), []);
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
