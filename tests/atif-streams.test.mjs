// A trajectory’s calls from its turns’ recorded streams (tools/atif-streams.mjs, #1758, #1752): every call the turn
// made, a reaction’s too, which made no step, with its input and what it got back. The fixture is a real run’s events
// and Claude Code streams (tests/fixtures/atif/uat-pairwork.md).

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { trajectories } from '../tools/atif.mjs';
import { callsOf as callsOfReply } from '../tools/atif-calls.mjs';
import { POSTBOX_VERSION, readRecording, writeTrajectories } from '../tools/atif-export.mjs';
import { callsInStream, recordedCalls } from '../tools/atif-streams.mjs';
import { tempDir } from './temp-dirs.mjs';

const DIR = new URL('fixtures/atif/uat-pairwork/', import.meta.url).pathname;
const rec = readRecording(DIR);
/** Each handle’s trajectory from these events and streams. */
const byHandle = (events = rec.events, streams = rec.streams) =>
  Object.fromEntries(trajectories(events, { version: POSTBOX_VERSION, streams }).map((t) => [t.handle, t.trajectory]));
const callsOf = (/** @type {any} */ t) => t.steps.flatMap((/** @type {any} */ s) => s.tool_calls ?? []);
const resultsOf = (/** @type {any} */ t) =>
  new Map(t.steps.flatMap((/** @type {any} */ s) => s.observation?.results ?? []).map((r) => [r.source_call_id, r.content]));
/** Every call each handle’s streams recorded, in order. */
const recorded = (/** @type {string} */ handle) => rec.streams.filter((s) => s.handle === handle).flatMap((s) => callsInStream(s.events));

test('the fixture is the gap #1758 is about: 17 recorded calls, 10 of them steps', () => {
  assert.equal(rec.streams.length, 15, 'one per turn, six of them with no call');
  assert.deepEqual([recorded('developer').length, recorded('critic').length], [9, 8]);
  const steps = byHandle(rec.events, []);
  assert.deepEqual([callsOf(steps.developer).length, callsOf(steps.critic).length], [4, 6]);
});

test('#1758 with no streams, a trajectory says its calls are its steps’, and one that made no step isn’t in it', () => {
  for (const t of Object.values(byHandle(rec.events, []))) {
    assert.equal(t.extra.calls_from, 'steps');
    assert.match(t.notes, /one that made none, such as a reaction, isn’t in it, since the run has no Claude Code stream of this agent’s turns\.$/);
  }
});

test('#1758 with the streams, every recorded call is in its agent’s trajectory once, with its input and what it got back', () => {
  const all = byHandle();
  for (const handle of ['developer', 'critic']) {
    const t = all[handle];
    const calls = callsOf(t);
    assert.deepEqual(
      calls.map((/** @type {any} */ c) => c.tool_call_id).sort(),
      recorded(handle)
        .map((c) => c.id)
        .sort(),
      handle,
    );
    assert.equal(t.extra.calls_from, 'recorded streams');
    assert.equal(t.extra.unplaced_calls, undefined);
    const results = resultsOf(t);
    for (const c of recorded(handle)) {
      const call = calls.find((/** @type {any} */ x) => x.tool_call_id === c.id);
      assert.equal(call.function_name, c.name, c.id);
      if (call.extra.step === 'none') {
        assert.deepEqual(call.arguments, c.input, `${c.id}’s input`);
        assert.equal(call.extra.arguments_source, 'recorded stream');
      }
      if (typeof c.result === 'string') assert.equal(results.get(c.id), c.result, `${c.id}’s result is what the stream says it got back`);
    }
  }
  const reacts = callsOf(all.developer).filter((/** @type {any} */ c) => c.function_name === 'mcp__postbox__react');
  assert.equal(reacts.length, 3);
  assert.ok(reacts.every((/** @type {any} */ c) => c.extra.step === 'none'));
});

test('#1758 a call with no step goes with its turn’s reply: beside its turn’s call with a step, or by its turn’s time', () => {
  const steps = byHandle().developer.steps;
  const stepOf = (/** @type {string} */ id) => steps.find((/** @type {any} */ s) => s.tool_calls?.some((/** @type {any} */ c) => c.tool_call_id.endsWith(id)));
  // read_conversation came between two Bash calls of the developer’s first turn.
  assert.equal(stepOf('dXx5MW'), stepOf('RV7rz9'));
  // A turn that only reacted and read a message: the reply its turn added, after its stream started.
  assert.equal(stepOf('ck2VUP')?.extra.item_id, 'it_cdhhf5Nk');
  assert.equal(stepOf('Uogfnu'), stepOf('ck2VUP'));
});

test('#1758 a stream that started before any of its agent’s turns, or whose turn made no reply, is counted, not placed', () => {
  const early = { ...rec.streams.find((s) => s.handle === 'critic' && s.events.length), started: 0 };
  const foreign = { ...early, events: early.events.map((e) => JSON.parse(JSON.stringify(e).replaceAll('toolu_', 'toolu_other_'))) };
  const t = byHandle(rec.events, [...rec.streams, foreign]).critic;
  assert.equal(t.extra.unplaced_calls, callsInStream(foreign.events).length);
  assert.match(t.notes, /recorded calls? matched no reply/);
  assert.equal(callsOf(t).length, 8, 'its calls aren’t in the trajectory');
  // Nor one whose turn made no reply: the developer’s second turn, with its reply gone. The next turn’s reply isn’t its.
  const between = { ...foreign, handle: 'developer', started: 1795679530000 };
  const noReply = rec.events.filter((e) => !(e.type === 'item.add' && e.data.item.id === 'it_qAd0QnoV'));
  assert.equal(byHandle(noReply, [...rec.streams, between]).developer.extra.unplaced_calls, callsInStream(between.events).length);
});

test('#1758 the count of unplaced calls stays on a trajectory when the agent’s first session made none', () => {
  // The developer joins another room first and never replies there: that session has no trajectory.
  const first = rec.events.find((e) => e.type === 'session' && e.data.handle === 'developer');
  const idle = { ...first, seq: 0, data: { ...first.data, id: 'se_idle', threadId: 'th_elsewhere' } };
  const early = { ...rec.streams.find((s) => s.handle === 'developer' && s.events.length), started: 0 };
  const foreign = { ...early, events: early.events.map((e) => JSON.parse(JSON.stringify(e).replaceAll('toolu_', 'toolu_other_'))) };
  const t = byHandle([idle, ...rec.events], [...rec.streams, foreign]).developer;
  assert.equal(t.extra.unplaced_calls, callsInStream(foreign.events).length);
});

test('#1758 so does an agent with no reply anywhere, whose only trajectory is a block’s', () => {
  const first = rec.events.find((e) => e.type === 'session' && e.data.handle === 'developer');
  const idle = { ...first, seq: 0, data: { ...first.data, id: 'se_idle', threadId: 'th_elsewhere' } };
  const noReplies = rec.events.filter((e) => !(e.type === 'item.add' && e.data.item.kind === 'agent' && e.data.item.handle === 'developer'));
  const at = Math.max(...noReplies.map((e) => e.seq)) + 1;
  const block = {
    seq: at,
    type: 'item.add',
    data: { threadId: first.data.threadId, item: { id: 'it_block', at: 1795679517816, kind: 'block', sessionId: first.data.id, handle: 'developer' } },
  };
  const t = byHandle([idle, ...noReplies, block]).developer;
  assert.ok(t, 'the block’s session has a trajectory');
  assert.equal(t.extra.unplaced_calls, recorded('developer').length, 'none of its calls has a reply to go with');
});

test('#1758 a call’s result is what its stream says the model got, ahead of the stored output', () => {
  // The developer’s commands have stored outputs the ledger names; read back, each would be this text instead.
  const stored = trajectories(rec.events, { version: POSTBOX_VERSION, streams: rec.streams, blob: () => 'the stored output' });
  const developer = stored.find((t) => t.handle === 'developer')?.trajectory;
  const commands = callsOf(developer).filter((/** @type {any} */ c) => c.function_name === 'Bash');
  assert.ok(commands.length > 0, 'the fixture has commands with stored outputs');
  const got = resultsOf(developer);
  for (const c of commands) {
    const streamed = recorded('developer').find((r) => r.id === c.tool_call_id)?.result;
    assert.equal(typeof streamed, 'string', `${c.tool_call_id} has a result in its stream`);
    assert.equal(got.get(c.tool_call_id), streamed);
  }
});

test('#1758 a call the ledger kept input for keeps it over its stream’s, and a subagent’s call names its parent', () => {
  // The stream’s input differs from the ledger’s, as a Read’s absolute path does from the target the ledger shows.
  const relabeled = rec.streams.map((st) =>
    st.handle !== 'critic'
      ? st
      : {
          ...st,
          events: st.events.map((e) =>
            e.type !== 'assistant'
              ? e
              : {
                  ...e,
                  parent_tool_use_id: 'toolu_parent',
                  message: {
                    ...e.message,
                    content: e.message.content.map((/** @type {any} */ p) => (p.type === 'tool_use' ? { ...p, input: { from: 'the stream' } } : p)),
                  },
                },
          ),
        },
  );
  const reads = callsOf(byHandle(rec.events, relabeled).critic).filter((/** @type {any} */ c) => c.function_name === 'Read');
  assert.equal(reads.length, 6);
  for (const c of reads) {
    assert.notDeepEqual(c.arguments, { from: 'the stream' }, 'the ledger’s input is kept');
    assert.notEqual(c.extra.arguments_source, 'recorded stream');
    assert.equal(c.extra.parent_tool_call_id, 'toolu_parent');
  }
});

test('#1752 a call the ledger kept no input for takes it from its turn’s stream, and says so', () => {
  const noReads = rec.events.filter((e) => !(e.type === 'work.add' && e.data.entry.kind === 'read'));
  const critic = byHandle(noReads).critic;
  const reads = callsOf(critic).filter((/** @type {any} */ c) => c.function_name === 'Read');
  assert.equal(reads.length, 6);
  for (const c of reads) {
    assert.equal(c.extra.arguments_source, 'recorded stream');
    assert.deepEqual(c.arguments, recorded('critic').find((r) => r.id === c.tool_call_id)?.input);
  }
  // Without the streams, such a call has none, and says so.
  const bare = callsOf(byHandle(noReads, []).critic).filter((/** @type {any} */ c) => c.function_name === 'Read');
  assert.ok(bare.every((/** @type {any} */ c) => c.extra.arguments_source === 'not recorded' && Object.keys(c.arguments).length === 0));
});

test('#1758 the export reads the streams from a run’s folder and from its events file alike, and writes them out', () => {
  const fromFile = readRecording(join(DIR, 'events.jsonl'));
  assert.equal(fromFile.streams?.length, 15);
  const out = tempDir('pb-atif-streams-');
  const written = writeTrajectories(out, rec);
  assert.equal(written.length, 2);
  const counts = Object.fromEntries(
    readdirSync(out).map((f) => {
      const t = JSON.parse(readFileSync(join(out, f), 'utf8'));
      return [t.agent.extra.handle, callsOf(t).length];
    }),
  );
  assert.deepEqual(counts, { developer: 9, critic: 8 });
});

test('#1758 a reply’s calls keep the order its turn made them in, stepped or not', () => {
  const first = byHandle().developer.steps.find((/** @type {any} */ s) => s.tool_calls?.some((/** @type {any} */ c) => c.tool_call_id.endsWith('RV7rz9')));
  assert.deepEqual(
    first.tool_calls.map((/** @type {any} */ c) => c.tool_call_id.slice(-6)),
    ['RV7rz9', 'dXx5MW', 'aEpAyS'],
  );
  assert.deepEqual(
    first.observation.results.map((/** @type {any} */ r) => r.source_call_id.slice(-6)),
    ['RV7rz9', 'dXx5MW', 'aEpAyS'],
  );
});

test('#1758 a call with no tool name on its step or in the ledger takes its stream’s name', () => {
  const nameless = rec.events
    .filter((e) => !(e.type === 'work.add' && e.data.entry.kind === 'read'))
    .map((e) => JSON.parse(JSON.stringify(e).replaceAll('"tool":"Read",', '').replaceAll(',"tool":"Read"', '')));
  const reads = callsOf(byHandle(nameless).critic).filter((/** @type {any} */ c) => c.extra.arguments_source === 'recorded stream' && c.extra.step !== 'none');
  assert.equal(reads.length, 6);
  assert.ok(reads.every((/** @type {any} */ c) => c.function_name === 'Read' && !c.extra.function_name));
});

test('#1758 a result that isn’t all text names its other parts, and an error or a subagent’s call says so', () => {
  const [call] = callsInStream([
    {
      type: 'assistant',
      parent_tool_use_id: 'toolu_parent',
      message: { content: [{ type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: 'shot.png' } }] },
    },
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_a',
            is_error: true,
            content: [
              { type: 'image', source: {} },
              { type: 'text', text: 'done' },
            ],
          },
        ],
      },
    },
  ]);
  assert.equal(call.result, '[image]\ndone');
  assert.equal(call.isError, true);
  assert.equal(call.parent, 'toolu_parent');
  const [only] = callsInStream([
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_b', name: 'Read', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: [{ type: 'image' }] }] } },
  ]);
  assert.equal(only.result, '[image]', 'an image alone is a result, not none');
});

test('#1758 one agent in two sessions: a stream goes to its turn’s session, and one with no turn, or whose turn made no reply, is counted on the first', () => {
  /** @param {string} id @param {string} turnId @param {string[]} steps */
  const reply = (id, turnId, steps) => ({ id, turnId, steps: new Map(steps.map((s) => [s, {}])) });
  const sessions = new Map([
    ['A', [reply('a1', 'ta', ['x'])]],
    ['B', [reply('b1', 'tb', ['y'])]],
  ]);
  const turns = [
    { id: 'ta', sessionId: 'A', startedAt: 900 },
    { id: 'tb', sessionId: 'B', startedAt: 1000 },
    { id: 'tc', sessionId: 'B', startedAt: 1100 },
  ];
  const use = (/** @type {string} */ id) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'T', input: {} }] } });
  const streams = [
    // Before any of the agent’s turns started: no turn is its.
    { handle: 'h', started: 850, events: [use('w')] },
    { handle: 'h', started: 902, events: [use('x'), use('x2')] },
    // The same calls again, as a stray process’s stream can hold them: read once.
    { handle: 'h', started: 903, events: [use('x'), use('x2')] },
    // B’s turn: a call before its first stepped one goes with the turn’s first reply.
    { handle: 'h', started: 1001, events: [use('y2'), use('y')] },
    // A turn that made no reply: its calls have none to go with.
    { handle: 'h', started: 1102, events: [use('z')] },
  ];
  const a = recordedCalls(streams, 'h', { sessions, turns }, 'A');
  const b = recordedCalls(streams, 'h', { sessions, turns }, 'B');
  assert.deepEqual([...a.byId.keys()].sort(), ['x', 'x2']);
  assert.deepEqual([...b.byId.keys()].sort(), ['y', 'y2']);
  assert.deepEqual([...a.unstepped], [['a1', [a.byId.get('x2')]]]);
  assert.deepEqual([...b.unstepped], [['b1', [b.byId.get('y2')]]]);
  assert.deepEqual([a.unplaced, b.unplaced], [2, 0], 'counted on the agent’s first session only');
});

test('#1758 a call’s result that its stream marks an error says so in its extra', () => {
  const step = { id: 'x', label: 'Read shot.png', tool: 'Read', state: 'failed' };
  const it = { id: 'a1', turnId: 't', steps: new Map([['x', step]]) };
  const recorded = recordedCalls(
    [
      {
        handle: 'h',
        started: 900,
        events: [
          { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }] } },
          { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'no such file' }] } },
        ],
      },
    ],
    'h',
    { sessions: new Map([['A', [it]]]), turns: [{ id: 't', sessionId: 'A', startedAt: 900 }] },
    'A',
  );
  const { tool_calls, results } = callsOfReply(it, new Map(), new Map(), () => null, recorded);
  assert.equal(tool_calls[0].extra.result_is_error, true);
  assert.deepEqual(results, [{ source_call_id: 'x', content: 'no such file' }]);
});
