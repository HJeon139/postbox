// ATIF v1.8 trajectories from Postbox’s recorded events (tools/atif.mjs, tools/atif-export.mjs), and the UAT kit keeping
// what they read (tools/uat/room-events.mjs). The fixture is a recorded /api/stream: tests/fixtures/atif/dry-run.md says
// how it was made. The rules checked here are Harbor’s (harbor-framework/harbor, src/harbor/models/trajectories/).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { trajectories } from '../tools/atif.mjs';
import { POSTBOX_VERSION, readRecording } from '../tools/atif-export.mjs';
import { keepEvent } from '../tools/uat/room-events.mjs';

const DIR = new URL('fixtures/atif/dry-run/', import.meta.url).pathname;
const rec = readRecording(DIR);
const only = (opts = {}) => {
  const found = trajectories(rec.events, { version: POSTBOX_VERSION, live: rec.live, ...opts });
  assert.equal(found.length, 1);
  return found[0].trajectory;
};
const AGENT_ONLY = ['model_name', 'reasoning_effort', 'reasoning_content', 'tool_calls', 'metrics'];

test('the recorded run gives @dry one trajectory that keeps Harbor’s rules for a step', () => {
  const t = only();
  assert.equal(t.schema_version, 'ATIF-v1.8');
  assert.equal(t.agent.name, 'postbox/claude-code');
  assert.equal(t.agent.version, POSTBOX_VERSION);
  assert.equal(t.agent.extra.handle, 'dry');
  t.steps.forEach((s, i) => {
    assert.equal(s.step_id, i + 1);
    assert.ok(['system', 'user', 'agent'].includes(s.source));
    assert.ok(typeof s.message === 'string');
    assert.match(s.timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    if (s.source !== 'agent') for (const k of AGENT_ONLY) assert.equal(s[k], undefined, `${k} on a ${s.source} step`);
    const calls = new Set((s.tool_calls ?? []).map((c) => c.tool_call_id));
    for (const r of s.observation?.results ?? []) assert.ok(calls.has(r.source_call_id), r.source_call_id);
  });
});

test('there is one step per message, reply and clock event the stream recorded, each at the server’s time', () => {
  const t = only();
  const added = rec.events.filter((e) => e.type === 'item.add').map((e) => e.data.item);
  const clocks = rec.events.filter((e) => e.type.startsWith('clock.'));
  assert.equal(t.steps.length, added.length + clocks.length);
  assert.equal(t.final_metrics.total_steps, t.steps.length);
  const byItem = new Map(added.map((it) => [it.id, it.at]));
  for (const s of t.steps) {
    const at = s.extra.event ? s.extra.at : byItem.get(s.extra.item_id);
    assert.equal(s.timestamp, new Date(at).toISOString(), `step ${s.step_id}`);
  }
  assert.deepEqual(
    t.steps.filter((s) => s.extra.event).map((s) => s.extra.event),
    ['clock.started', 'clock.turn', 'clock.turn', 'clock.turn', 'clock.expired'],
  );
  // The replayed Claude Code lines carry the time they were recorded, on another host: no step takes it.
  assert.ok(!t.steps.some((s) => s.timestamp.startsWith('2026-10-22')));
});

test('a turn’s tokens and cost go on its first reply, and a figure its backend didn’t report is left out', () => {
  const replies = only().steps.filter((s) => s.source === 'agent');
  assert.deepEqual(replies[0].metrics, {
    prompt_tokens: 4 + 62632 + 18031,
    completion_tokens: 102,
    cached_tokens: 62632,
    cost_usd: 0.0794152,
    extra: { cache_write_tokens: 18031 },
  });
  // block.jsonl’s result has no cost: tokens, and no cost_usd at all.
  assert.equal(replies[1].metrics.completion_tokens, 282);
  assert.equal(Object.hasOwn(replies[1].metrics, 'cost_usd'), false);
  // The turn the clock stopped reported nothing.
  assert.equal(replies[2].metrics, undefined);
  assert.equal(replies[2].extra.status, 'stopped');
});

test('a total only some turns reported is a partial sum in extra, never a total', () => {
  const f = only().final_metrics;
  assert.equal(f.total_cost_usd, undefined);
  assert.deepEqual(f.extra.partial.total_cost_usd, { sum: 0.0794152, turns_reported: 1, turns_unreported: 2 });
  assert.deepEqual(f.extra.partial.total_completion_tokens, { sum: 384, turns_reported: 2, turns_unreported: 1 });
});

test('a tool call keeps the live view’s input and output, which only the live frames carry', () => {
  const [reply] = only().steps.filter((s) => s.source === 'agent');
  assert.deepEqual(reply.tool_calls, [
    {
      tool_call_id: 'toolu_01UvPeupBvnh1ZXh1p8WXmXv',
      function_name: 'Print CLAUDE_EFFORT environment variable',
      arguments: { input: 'command: printenv CLAUDE_EFFORT' },
      extra: { state: 'done', ms: 151 },
    },
  ]);
  assert.deepEqual(reply.observation, { results: [{ source_call_id: 'toolu_01UvPeupBvnh1ZXh1p8WXmXv', content: 'high' }] });
  // From the stored events alone, the call is there with no arguments, and nothing it returned.
  const [bare] = trajectories(rec.events, { version: POSTBOX_VERSION })[0].trajectory.steps.filter((s) => s.source === 'agent');
  assert.deepEqual(bare.tool_calls[0].arguments, {});
  assert.equal(bare.observation, undefined);
});

test('the exporter reads a recording given as its events file as it reads the run’s folder', () => {
  const file = readRecording(`${DIR}events.jsonl`);
  assert.equal(file.events.length, rec.events.length);
  assert.equal(file.live.length, rec.live.length);
  assert.ok(rec.events.length > 0 && rec.live.length > 0);
  assert.equal(trajectories(rec.events, { version: '0', sessionId: 'se_none' }).length, 0);
});

test('the UAT history keeps the clock’s events, a reply’s stored words and the work ledger’s turns', () => {
  const lines = readFileSync(`${DIR}events.jsonl`, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  for (const type of ['clock.started', 'clock.turn', 'clock.expired', 'item.text', 'work.add', 'work.patch']) {
    const e = lines.find((x) => x.type === type);
    assert.ok(e, `the fixture has a ${type}`);
    assert.deepEqual(keepEvent(e.seq, e.type, e.data), { seq: e.seq, type, data: e.data }, type);
  }
  // A work entry that isn’t a turn (a command, an edit) isn’t one the trajectories read.
  assert.equal(keepEvent(1, 'work.add', { convId: 'th_1', entry: { kind: 'command', id: 'w_1' } }), null);
});
