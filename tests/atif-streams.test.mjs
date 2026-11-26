// A trajectory’s calls from its turns’ recorded streams (tools/atif-streams.mjs, #1758, #1752): every call the turn
// made, a reaction’s too, which made no step, with its input and what it got back. The fixture is a real run’s events
// and Claude Code streams (tests/fixtures/atif/uat-pairwork.md).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trajectories } from '../tools/atif.mjs';
import { POSTBOX_VERSION, readRecording } from '../tools/atif-export.mjs';
import { callsInStream } from '../tools/atif-streams.mjs';

const rec = readRecording(new URL('fixtures/atif/uat-pairwork/', import.meta.url).pathname);
/** Each handle’s trajectory from these events and streams. */
const byHandle = (events = rec.events, streams = rec.streams) =>
  Object.fromEntries(trajectories(events, { version: POSTBOX_VERSION, streams }).map((t) => [t.handle, t.trajectory]));
const callsOf = (/** @type {any} */ t) => t.steps.flatMap((/** @type {any} */ s) => s.tool_calls ?? []);
const resultsOf = (/** @type {any} */ t) =>
  new Map(t.steps.flatMap((/** @type {any} */ s) => s.observation?.results ?? []).map((r) => [r.source_call_id, r.content]));
/** Every call each handle’s streams recorded, in order. */
const recorded = (/** @type {string} */ handle) => rec.streams.filter((s) => s.handle === handle).flatMap((s) => callsInStream(s.events));

test('the fixture is the gap #1758 is about: 17 recorded calls, 10 of them steps', () => {
  assert.equal(rec.streams.length, 9);
  assert.deepEqual([recorded('developer').length, recorded('critic').length], [9, 8]);
  const steps = byHandle(rec.events, []);
  assert.deepEqual([callsOf(steps.developer).length, callsOf(steps.critic).length], [4, 6]);
});

test('#1758 with no streams, a trajectory says its calls are its steps’, and one that made no step isn’t in it', () => {
  for (const t of Object.values(byHandle(rec.events, []))) {
    assert.equal(t.extra.calls_from, 'steps');
    assert.match(t.notes, /one that made none, such as a reaction, isn’t in it, since the run recorded no stream of this agent’s turns\.$/);
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

test('#1758 a stream that shares no call with the session and holds none of its replies’ times is counted, not placed', () => {
  const late = { ...rec.streams.find((s) => s.handle === 'critic'), started: Number.MAX_SAFE_INTEGER };
  const foreign = { ...late, events: late.events.map((e) => JSON.parse(JSON.stringify(e).replaceAll('toolu_', 'toolu_other_'))) };
  const t = byHandle(rec.events, [...rec.streams, foreign]).critic;
  assert.equal(t.extra.unplaced_calls, callsInStream(foreign.events).length);
  assert.match(t.notes, /recorded calls? matched no reply/);
  assert.equal(callsOf(t).length, 8, 'its calls aren’t in the trajectory');
  // Nor one whose time holds no reply before the agent’s next stream started: the next turn’s reply isn’t its.
  const between = { ...foreign, handle: 'developer', started: 1795679530000 };
  assert.equal(byHandle(rec.events, [...rec.streams, between]).developer.extra.unplaced_calls, callsInStream(between.events).length);
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
