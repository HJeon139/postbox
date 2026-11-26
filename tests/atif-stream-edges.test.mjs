// The edges of reading a turn’s recorded stream (tools/atif-streams.mjs, #1758): a turn with two replies, a long
// result, a call with no result, a step no stream holds, a line of the wrong type, an input that isn’t an object, a
// call with no name, and the note on one unplaced call.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callsOf, RESULT_CHARS } from '../tools/atif-calls.mjs';
import { callsInStream, recordedCalls, withCalls } from '../tools/atif-streams.mjs';

/** A stream’s line for a call, and for what it got back. */
const use = (/** @type {string} */ id) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'T', input: {} }] } });
const got = (/** @type {string} */ id, /** @type {string} */ content) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
});
/** A reply of turn `t` with these steps. @param {string} id @param {string[]} steps */
const replyWith = (id, steps) => ({ id, turnId: 't', steps: new Map(steps.map((s) => [s, { id: s, label: s, tool: 'T' }])) });
/** The agent’s one turn, in session A, which its stream started after. */
const turns = [{ id: 't', sessionId: 'A', startedAt: 899 }];

test('#1758 a turn that made two replies: a call with no step goes with the last call before it that has one', () => {
  const sessions = new Map([['A', [replyWith('a1', ['x']), replyWith('a2', ['y'])]]]);
  const { unstepped } = recordedCalls([{ handle: 'h', started: 900, events: [use('x'), use('x2'), use('y'), use('y2')] }], 'h', { sessions, turns }, 'A');
  assert.deepEqual(
    [...unstepped].map(([reply, calls]) => [reply, calls.map((c) => c.id)]),
    [
      ['a1', ['x2']],
      ['a2', ['y2']],
    ],
  );
});

test('#1758 a long stream result is cut, a call with no result has none, and calls stay as they were when a step’s call is in no stream', () => {
  const long = 'z'.repeat(RESULT_CHARS + 1);
  const it = replyWith('a1', ['old', 'x']);
  const events = [use('n'), use('x'), got('x', long), use('x2'), got('x2', long), use('x3')];
  const recorded = recordedCalls([{ handle: 'h', started: 900, events }], 'h', { sessions: new Map([['A', [it]]]), turns }, 'A');
  const { tool_calls, results } = callsOf(it, new Map(), new Map(), () => null, recorded);
  // `old` is a step no stream holds, so the stream can’t order the reply’s calls: the ones with no step follow its steps.
  assert.deepEqual(
    tool_calls.map((c) => c.tool_call_id),
    ['old', 'x', 'n', 'x2', 'x3'],
  );
  assert.deepEqual(
    results.map((r) => r.source_call_id),
    ['x', 'x2'],
  );
  for (const r of results) assert.match(r.content, /^z{16384}\n\[cut by the exporter: 16,384 of 16,385 characters\]$/);
});

test('#1758 a stream’s call is read once, from an assistant line, and its result from a user line', () => {
  const again = callsInStream([use('a'), got('a', 'ok'), use('a')]);
  assert.deepEqual(
    again.map((c) => [c.id, c.result]),
    [['a', 'ok']],
  );
  const swapped = callsInStream([use('a'), { ...got('a', 'ok'), type: 'assistant' }, { ...use('b'), type: 'user' }]);
  assert.deepEqual(
    swapped.map((c) => [c.id, c.result]),
    [['a', null]],
  );
});

test('#1758 a stream’s call whose input isn’t an object has none, and one with no name is “unknown”', () => {
  const events = [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'n', name: '', input: 'not an object' }] } }];
  assert.deepEqual(callsInStream(events)[0].input, {});
  const it = replyWith('a1', []);
  const recorded = recordedCalls([{ handle: 'h', started: 900, events }], 'h', { sessions: new Map([['A', [it]]]), turns }, 'A');
  const [call] = callsOf(it, new Map(), new Map(), () => null, recorded).tool_calls;
  assert.equal(call.function_name, 'unknown');
  assert.deepEqual(call.arguments, {});
});

test('#1758 one unplaced call is noted as one', () => {
  const { notes, extra } = withCalls({ notes: 'Scope.', extra: {} }, { streamed: true, unplaced: 1, turnsWithoutStream: 0 });
  assert.equal(notes, 'Scope. 1 of this agent’s recorded calls matched no reply in any of its conversations, so it isn’t in any trajectory.');
  assert.deepEqual(extra, { calls_from: 'recorded streams', unplaced_calls: 1 });
});
