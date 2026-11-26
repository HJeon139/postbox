// A recorded stream is matched to its agent’s turn, not to a reply by time (tools/atif-streams.mjs, #1758): the turn
// gives the session and the replies its calls go with, and a turn with no stream is counted, since the calls it made
// that made no step can’t be in the trajectory. The fixture is a real run’s events and Claude Code streams
// (tests/fixtures/atif/uat-pairwork.md), one stream per turn.

import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { trajectories } from '../tools/atif.mjs';
import { POSTBOX_VERSION, readRecording } from '../tools/atif-export.mjs';
import { recordedCalls } from '../tools/atif-streams.mjs';
import { tempDir } from './temp-dirs.mjs';

const DIR = new URL('fixtures/atif/uat-pairwork/', import.meta.url).pathname;
const rec = readRecording(DIR);
/** Each handle’s trajectory from these events and streams. */
const byHandle = (events = rec.events, streams = rec.streams) =>
  Object.fromEntries(trajectories(events, { version: POSTBOX_VERSION, streams }).map((t) => [t.handle, t.trajectory]));
const callsOf = (/** @type {any} */ t) => t.steps.flatMap((/** @type {any} */ s) => s.tool_calls ?? []);
/** The calls of one reply’s step, by the ends of their ids. @param {any} t @param {string} itemId */
const callsOn = (t, itemId) =>
  (t.steps.find((/** @type {any} */ s) => s.extra?.item_id === itemId)?.tool_calls ?? []).map((/** @type {any} */ c) => c.tool_call_id.slice(-6));
/** The streams without the developer’s whose file names start with these times. @param {...number} started */
const without = (...started) => rec.streams.filter((s) => !(s.handle === 'developer' && started.includes(/** @type {number} */ (s.started))));

test('#1758 with a stream for every turn, no turn is counted as having none', () => {
  for (const t of Object.values(byHandle())) {
    assert.equal(t.extra.calls_from, 'recorded streams');
    assert.equal(t.extra.turns_without_stream, undefined);
    assert.doesNotMatch(t.notes, /no Claude Code stream/);
  }
});

test('#1758 a turn with no stream is counted and noted, and its reply gets no other turn’s calls', () => {
  // The developer’s turn that reacted once (oGiu3L), on its reply it_ViP3oJux, has no stream here.
  const t = byHandle(rec.events, without(1795679564202)).developer;
  assert.equal(t.extra.calls_from, 'recorded streams');
  assert.equal(t.extra.turns_without_stream, 1);
  assert.match(
    t.notes,
    / 1 of this agent’s turns in this conversation has no Claude Code stream, so a call it made that made no step isn’t in this trajectory\.$/,
  );
  assert.deepEqual(callsOn(t, 'it_ViP3oJux'), []);
  assert.deepEqual(callsOn(t, 'it_cdhhf5Nk'), ['ck2VUP', 'Uogfnu'], 'the turn before keeps its own');
  assert.deepEqual(callsOn(t, 'it_FDHI4xc6'), ['Zt7bhX'], 'the turn after keeps its own');
  // With the turn before’s reply gone too, its calls have no reply: counted, never put on the next turn’s.
  const noReply = rec.events.filter((e) => !(e.type === 'item.add' && e.data.item.id === 'it_cdhhf5Nk'));
  const gone = byHandle(noReply, without(1795679564202)).developer;
  assert.deepEqual(callsOn(gone, 'it_ViP3oJux'), []);
  assert.equal(gone.extra.unplaced_calls, 2);
});

test('#1758 an agent whose first turn alone has a stream has the rest counted, as on a run that switched backends', () => {
  const firstOnly = rec.streams.filter((s) => s.handle !== 'developer' || s.started === 1795679514826);
  const { developer, critic } = byHandle(rec.events, firstOnly);
  // Seven turns have no stream; two of them called no tool, so they lack nothing a stream would add.
  assert.equal(developer.extra.turns_without_stream, 5);
  assert.match(
    developer.notes,
    / 5 of this agent’s turns in this conversation have no Claude Code stream, so a call they made that made no step isn’t in this trajectory\.$/,
  );
  assert.equal(callsOf(developer).length, 5, 'its first turn’s three calls and the two later ones that made a step');
  assert.equal(critic.extra.turns_without_stream, undefined, 'another agent’s turns all have one');
});

test('#1758 a stream is its agent’s latest turn that started at or before it, and only that session’s turns are counted', () => {
  /** @param {string} id @param {string} turnId @param {string[]} steps */
  const reply = (id, turnId, steps) => ({ id, turnId, steps: new Map(steps.map((s) => [s, {}])) });
  const sessions = new Map([
    // t1 made two replies: a call with no step before any with one goes with its first.
    ['A', [reply('a1', 't1', []), reply('a1b', 't1', []), reply('a2', 't2', []), reply('a3', 't3', [])]],
    ['B', [reply('b1', 'tb', [])]],
  ]);
  const turns = [
    { id: 't2', sessionId: 'A', startedAt: 2000, toolCalls: 1 },
    { id: 't1', sessionId: 'A', startedAt: 1000, toolCalls: 1 },
    { id: 't3', sessionId: 'A', startedAt: 3000, toolCalls: 2 },
    { id: 'tb', sessionId: 'B', startedAt: 2500, toolCalls: 1 },
    { id: 't4', sessionId: 'A', startedAt: 4000, toolCalls: 1 },
    // A turn stopped before it called anything, as one stopped before its process started: no gap.
    { id: 't5', sessionId: 'A', startedAt: 5000, toolCalls: 0 },
  ];
  const use = (/** @type {string} */ id) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'T', input: {} }] } });
  const streams = [
    // Started the same millisecond as its turn, and a few after the turn before it.
    { handle: 'h', started: 2000, events: [use('p')] },
    { handle: 'h', started: 1003, events: [use('q')] },
    // Another agent’s stream at t3’s time isn’t t3’s.
    { handle: 'other', started: 3001, events: [use('r')] },
  ];
  const a = recordedCalls(streams, 'h', { sessions, turns }, 'A');
  assert.deepEqual(
    [...a.unstepped].map(([at, calls]) => [at, calls.map((c) => c.id)]),
    [
      ['a1', ['q']],
      ['a2', ['p']],
    ],
  );
  assert.equal(a.turnsWithoutStream, 2, 't3 and t4, not B’s');
  assert.equal(recordedCalls(streams, 'h', { sessions, turns }, 'B').turnsWithoutStream, 1);
});

test('#1758 a turn’s stream with no call is an empty file, read with its agent and start from its name', () => {
  const empty = rec.streams.filter((s) => s.events.length === 0);
  assert.deepEqual(empty.map((s) => `${s.started}-${s.handle}`).sort(), [
    '1795679514828-critic',
    '1795679525187-developer',
    '1795679534135-critic',
    '1795679542389-developer',
    '1795679554388-critic',
    '1795679687329-critic',
  ]);
});

test('#1758 an agent whose streams another backend recorded, in streams/sdk/, has its calls from its steps', () => {
  // The run as if the developer ran on the Agent SDK: its streams are in streams/sdk/, which the exporter doesn’t read.
  const dir = tempDir('pb-atif-sdk-');
  mkdirSync(join(dir, 'streams', 'sdk'), { recursive: true });
  copyFileSync(join(DIR, 'events.jsonl'), join(dir, 'events.jsonl'));
  for (const f of readdirSync(join(DIR, 'streams')))
    copyFileSync(join(DIR, 'streams', f), join(dir, 'streams', ...(f.endsWith('-developer.jsonl') ? ['sdk', f] : [f])));
  const run = readRecording(dir);
  assert.deepEqual([...new Set(run.streams?.map((s) => s.handle))], ['critic'], 'streams/sdk/ isn’t read');
  const { developer, critic } = byHandle(run.events, run.streams);
  assert.equal(developer.extra.calls_from, 'steps');
  assert.match(developer.notes, /since the run has no Claude Code stream of this agent’s turns\.$/);
  assert.equal(critic.extra.calls_from, 'recorded streams');
});

test('#1758 a recording with no work ledger turns places its streams as before the ledger kept them', () => {
  // Runs recorded before the ledger kept turns have none: a stream’s step still names its reply, and a stream whose
  // calls made no step goes by time, so each call lands where the ledger’s turns put it.
  const noTurns = rec.events.filter((e) => !(e.type === 'work.add' && e.data.entry.kind === 'turn'));
  const before = byHandle();
  const after = byHandle(noTurns);
  for (const handle of ['developer', 'critic']) {
    const replies = before[handle].steps.filter((/** @type {any} */ s) => s.extra?.item_id && s.tool_calls?.length);
    assert.ok(replies.length > 1, `${handle} has replies with calls`);
    for (const { extra } of replies) {
      assert.deepEqual(callsOn(after[handle], extra.item_id), callsOn(before[handle], extra.item_id), `${handle} ${extra.item_id}`);
    }
    assert.equal(after[handle].extra.unplaced_calls, undefined, handle);
    assert.equal(after[handle].extra.turns_without_stream, undefined, handle);
  }
  // A stream that fits no reply by time is counted, with the reason the recording gives none better.
  const late = { ...rec.streams.find((s) => s.handle === 'developer'), started: Number.MAX_SAFE_INTEGER };
  const foreign = { ...late, events: late.events.map((e) => JSON.parse(JSON.stringify(e).replaceAll('toolu_', 'toolu_other_'))) };
  const lost = byHandle(noTurns, [...rec.streams, foreign]).developer;
  assert.ok(lost.extra.unplaced_calls > 0);
  assert.match(lost.notes, /matched no reply by time, and the recording has no work ledger turns to match their streams to/);
});

test('#1758 a stream with a step goes to that step’s turn, even when two turns started at once, and never takes another session’s call', () => {
  /** @param {string} id @param {string} turnId @param {string[]} steps */
  const reply = (id, turnId, steps) => ({ id, turnId, steps: new Map(steps.map((s) => [s, {}])) });
  const sessions = new Map([
    // t1 made two replies, and only its second has the step: a call before the step goes with t1’s first.
    ['A', [reply('a0', 't1', []), reply('a1', 't1', ['x']), reply('a2', 't2', [])]],
    ['B', [reply('b1', 'tb', ['y'])]],
  ]);
  const turns = [
    { id: 't1', sessionId: 'A', startedAt: 1000, toolCalls: 2 },
    { id: 't2', sessionId: 'A', startedAt: 1000, toolCalls: 1 },
    { id: 'tb', sessionId: 'B', startedAt: 900, toolCalls: 1 },
  ];
  const use = (/** @type {string} */ id) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'T', input: {} }] } });
  // One stream holds a call before t1’s step x, x, a call with no step, and B’s step y, which it must leave to B.
  const streams = [{ handle: 'h', started: 1001, events: [use('m'), use('x'), use('n'), use('y')] }];
  const a = recordedCalls(streams, 'h', { sessions, turns }, 'A');
  assert.deepEqual(
    [...a.unstepped].map(([at, calls]) => [at, calls.map((c) => c.id)]),
    [
      ['a0', ['m']],
      ['a1', ['n']],
    ],
  );
  assert.equal(a.byId.has('y'), false, 'B’s step isn’t A’s');
  assert.equal(a.turnsWithoutStream, 1, 't2, not t1, which its step names');
});

test('#1758 with no ledger turns, a stream with no step goes by time only up to its agent’s next stream', () => {
  const reply = (/** @type {string} */ id, /** @type {number} */ at) => ({ id, at, steps: new Map() });
  const sessions = new Map([['A', [reply('a1', 2500)]]]);
  const use = (/** @type {string} */ id) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'T', input: {} }] } });
  // The first stream’s window ends when the second starts, before the only reply: it isn’t that reply’s.
  const streams = [
    { handle: 'h', started: 1000, events: [use('early')] },
    { handle: 'h', started: 2000, events: [use('late')] },
  ];
  const a = recordedCalls(streams, 'h', { sessions, turns: [] }, 'A');
  assert.deepEqual(
    [...a.unstepped].map(([at, calls]) => [at, calls.map((c) => c.id)]),
    [['a1', ['late']]],
  );
  assert.equal(a.unplaced, 1);
});
