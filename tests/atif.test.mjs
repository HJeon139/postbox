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
const all = (events = rec.events, live = rec.live) => trajectories(events, { version: POSTBOX_VERSION, live });
const of = (handle, events, live) => {
  const found = all(events, live).filter((t) => t.handle === handle);
  assert.equal(found.length, 1, handle);
  return found[0].trajectory;
};
const AGENT_ONLY = ['model_name', 'reasoning_effort', 'reasoning_content', 'tool_calls', 'metrics'];
const sessionOf = (handle) => rec.events.find((e) => e.type === 'session' && e.data.handle === handle).data.id;

test('the recorded run gives each agent one trajectory that keeps Harbor’s rules for a step', () => {
  assert.deepEqual(
    all()
      .map((t) => t.handle)
      .sort(),
    ['dry', 'dry2'],
  );
  for (const { trajectory: t } of all()) {
    assert.equal(t.schema_version, 'ATIF-v1.8');
    assert.equal(t.agent.name, 'postbox/claude-code');
    assert.equal(t.agent.version, POSTBOX_VERSION);
    t.steps.forEach((s, i) => {
      assert.equal(s.step_id, i + 1);
      assert.ok(['system', 'user', 'agent'].includes(s.source));
      assert.ok(typeof s.message === 'string');
      assert.match(s.timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      if (s.source !== 'agent') for (const k of AGENT_ONLY) assert.equal(s[k], undefined, `${k} on a ${s.source} step`);
      const calls = new Set((s.tool_calls ?? []).map((c) => c.tool_call_id));
      for (const r of s.observation?.results ?? []) assert.ok(calls.has(r.source_call_id), r.source_call_id);
    });
  }
});

test('a step is each message that reached the agent’s inbox, each reply, each clock event and each prompt, at the server’s time', () => {
  const t = of('dry');
  const id = sessionOf('dry');
  const added = rec.events.filter((e) => e.type === 'item.add').map((e) => e.data.item);
  const entries = new Map(rec.events.filter((e) => e.type === 'entry.add' && e.data.sessionId === id).map((e) => [e.data.entry.id, e.data.entry.itemId]));
  const taken = rec.events.filter((e) => e.type === 'entry.patch' && e.data.patch.takenBy && entries.has(e.data.id));
  const delivered = new Set(taken.map((e) => entries.get(e.data.id)));
  const own = added.filter((it) => it.sessionId === id && it.kind === 'agent');
  const clocks = rec.events.filter((e) => e.type.startsWith('clock.') && e.data.sessionId === id);
  // Each prompt it was sent, and its guide before the first prompt that went with it.
  const prompts = rec.events.filter((e) => e.type === 'turn.prompt' && e.data.sessionId === id);
  const guides = new Set(prompts.map((e) => e.data.guideSha)).size;
  assert.equal(prompts.length, 3);
  assert.equal(guides, 1);
  assert.equal(t.steps.length, added.filter((it) => delivered.has(it.id)).length + own.length + clocks.length + prompts.length + guides);
  assert.equal(t.final_metrics.total_steps, t.steps.length);
  const at = new Map(added.map((it) => [it.id, it.at]));
  // A prompt step is at its prompt’s time, and its guide’s at the same prompt’s.
  const promptAt = new Map(prompts.map((e) => [e.data.turnId, e.data.at]));
  const timeOf = (s) => {
    if (s.extra.event === 'turn.prompt') return promptAt.get(s.extra.turn_id);
    if (s.extra.event === 'turn.guide') return prompts.find((e) => e.data.guideSha === s.extra.sha).data.at;
    return s.extra.event ? s.extra.at : at.get(s.extra.item_id);
  };
  for (const s of t.steps) assert.equal(s.timestamp, new Date(timeOf(s)).toISOString(), `step ${s.step_id}`);
  assert.deepEqual(
    t.steps.filter((s) => s.extra.event?.startsWith('clock.')).map((s) => s.extra.event),
    ['clock.started', 'clock.turn', 'clock.turn', 'clock.turn', 'clock.expired'],
  );
  // The replayed Claude Code lines carry the time they were recorded, on another host: no step takes it.
  assert.ok(!t.steps.some((s) => s.timestamp.startsWith('2026-10-22')));
});

test('a message to another agent that never reached this one’s inbox is no step of its', () => {
  const toDry2 = rec.events.find((e) => e.type === 'item.add' && /only for you/.test(e.data.item.text ?? '')).data.item;
  assert.ok(!of('dry').steps.some((s) => s.extra.item_id === toDry2.id));
  assert.deepEqual(
    of('dry2')
      .steps.filter((s) => s.source === 'user')
      .map((s) => s.extra.item_id),
    [toDry2.id],
  );
});

test('a turn’s tokens and cost go on its first reply, and a figure its backend didn’t report is left out', () => {
  const replies = of('dry').steps.filter((s) => s.source === 'agent');
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

test('a total only some turns reported is a partial sum in extra, never a total; one every turn reported is a total', () => {
  const f = of('dry').final_metrics;
  assert.equal(f.total_cost_usd, undefined);
  assert.deepEqual(f.extra.partial.total_cost_usd, { sum: 0.0794152, turns_reported: 1, turns_unreported: 2 });
  assert.deepEqual(f.extra.partial.total_completion_tokens, { sum: 384, turns_reported: 2, turns_unreported: 1 });
  assert.equal(of('dry2').final_metrics.total_cost_usd, 0.0794152);
});

// A turn whose only output is a block, from the recorded run: its reply’s item.add is left out and a block item of the
// same turn takes its place, as server/block-show.mjs adds one ({ kind: 'block', sessionId, handle, turnId, block }).
// The ledger’s events for the turn are as recorded.
function withBlockTurn({ keepBlock }) {
  const id = sessionOf('dry');
  const reply = rec.events.filter((e) => e.type === 'item.add' && e.data.item.sessionId === id && e.data.item.kind === 'agent')[1];
  const { item } = reply.data;
  const block = {
    id: 'it_block',
    at: item.at,
    kind: 'block',
    sessionId: id,
    handle: 'dry',
    turnId: item.turnId,
    block: { type: 'choice', id: 'drink', fallback: 'Tea or coffee?' },
  };
  const events = rec.events.flatMap((e) => {
    if (e !== reply) return e.data?.id === item.id ? [] : [e];
    return keepBlock ? [{ ...e, data: { threadId: e.data.threadId, item: block } }] : [];
  });
  return { turnId: item.turnId, t: of('dry', events) };
}

test('a turn that only showed a block has its tokens on the block’s step, and still counts toward the totals', () => {
  const { turnId, t } = withBlockTurn({ keepBlock: true });
  const shown = t.steps.find((s) => s.extra.item_id === 'it_block');
  assert.equal(shown.source, 'agent');
  assert.equal(shown.extra.turn_id, turnId);
  assert.equal(shown.metrics.completion_tokens, 282);
  assert.equal(t.final_metrics.extra.unattached_turns, undefined);
  assert.equal(t.final_metrics.extra.partial.total_completion_tokens.sum, 384);
});

test('a turn the ledger has figures for but no step carries is listed, and its figures still count', () => {
  const { turnId, t } = withBlockTurn({ keepBlock: false });
  assert.deepEqual(
    t.final_metrics.extra.unattached_turns.map((u) => [u.turn_id, u.metrics.completion_tokens]),
    [[turnId, 282]],
  );
  assert.equal(t.final_metrics.extra.partial.total_completion_tokens.sum, 384);
});

test('a tool call names the tool its harness ran, with the arguments the work ledger kept', () => {
  const [reply] = of('dry').steps.filter((s) => s.source === 'agent');
  assert.deepEqual(reply.tool_calls, [
    {
      tool_call_id: 'toolu_01UvPeupBvnh1ZXh1p8WXmXv',
      function_name: 'Bash',
      arguments: { command: 'printenv CLAUDE_EFFORT', description: 'Print CLAUDE_EFFORT environment variable', run_in_background: false },
      extra: {
        label: 'Print CLAUDE_EFFORT environment variable',
        state: 'done',
        ms: reply.tool_calls[0].extra.ms,
        arguments_source: 'work ledger',
        display_input: 'command: printenv CLAUDE_EFFORT',
      },
    },
  ]);
  assert.equal(typeof reply.tool_calls[0].extra.ms, 'number');
  assert.deepEqual(reply.observation, { results: [{ source_call_id: 'toolu_01UvPeupBvnh1ZXh1p8WXmXv', content: 'high' }] });
  // From the stored events alone: the same name and arguments, and nothing it returned, which only live frames carry.
  const [bare] = of('dry', rec.events, []).steps.filter((s) => s.source === 'agent');
  assert.equal(bare.tool_calls[0].function_name, 'Bash');
  assert.equal(bare.tool_calls[0].arguments.command, 'printenv CLAUDE_EFFORT');
  assert.equal(bare.tool_calls[0].extra.display_input, undefined);
  assert.equal(bare.observation, undefined);
});

test('a call whose step has no tool name and no ledger entry says so, with no arguments made up', () => {
  const id = sessionOf('dry');
  const events = rec.events
    .filter((e) => !(e.type === 'work.add' && e.data.entry.kind === 'command'))
    .map((e) =>
      e.type === 'item.patch' && e.data.activityStep ? { ...e, data: { ...e.data, activityStep: { ...e.data.activityStep, tool: undefined } } } : e,
    );
  const live = rec.live.map((l) => (l.kind === 'step' ? { ...l, step: { ...l.step, tool: undefined } } : l));
  const call = of('dry', events, live).steps.find((s) => s.tool_calls)?.tool_calls[0];
  assert.ok(id && call);
  assert.equal(call.function_name, 'unknown');
  assert.deepEqual(call.arguments, {});
  assert.equal(call.extra.function_name, 'not recorded');
  assert.equal(call.extra.arguments_source, 'not recorded');
});

test('the exporter reads a recording given as its events file as it reads the run’s folder', () => {
  const file = readRecording(`${DIR}events.jsonl`);
  assert.equal(file.events.length, rec.events.length);
  assert.equal(file.live.length, rec.live.length);
  assert.ok(rec.events.length > 0 && rec.live.length > 0);
  assert.equal(trajectories(rec.events, { version: '0', sessionId: 'se_none' }).length, 0);
});

test('the UAT history keeps the clock’s events, a reply’s stored words, the inboxes and the ledger’s turns and calls', () => {
  const lines = readFileSync(`${DIR}events.jsonl`, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  for (const type of ['clock.started', 'clock.turn', 'clock.expired', 'item.text', 'entry.add', 'entry.patch', 'work.add', 'work.patch']) {
    const e = lines.find((x) => x.type === type);
    assert.ok(e, `the fixture has a ${type}`);
    assert.deepEqual(keepEvent(e.seq, e.type, e.data), { seq: e.seq, type, data: e.data }, type);
  }
  assert.ok(lines.some((x) => x.type === 'work.add' && x.data.entry.kind === 'command'));
  // A ledger entry the trajectories don’t read (a file’s change, a publish) isn’t kept.
  assert.equal(keepEvent(1, 'work.add', { convId: 'th_1', entry: { kind: 'publish', id: 'w_1' } }), null);
});

test('a message that waited in the agent’s inbox and no turn took is no step of its', () => {
  // From the recorded run: the take of @dry’s second message is left out, as when its clock had expired first.
  const second = rec.events.filter((e) => e.type === 'entry.patch' && e.data.sessionId === sessionOf('dry') && e.data.patch.takenBy)[1];
  const entry = rec.events.find((e) => e.type === 'entry.add' && e.data.entry.id === second.data.id).data.entry;
  const t = of(
    'dry',
    rec.events.filter((e) => e !== second),
  );
  assert.ok(!t.steps.some((s) => s.extra.item_id === entry.itemId));
  assert.ok(of('dry').steps.some((s) => s.extra.item_id === entry.itemId));
});

test('a call’s name comes from its own step, so a call the ledger doesn’t keep is still named', () => {
  const events = rec.events.filter((e) => !(e.type === 'work.add' && e.data.entry.kind === 'command'));
  const call = of('dry', events).steps.find((s) => s.tool_calls)?.tool_calls[0];
  assert.equal(call.function_name, 'Bash');
  assert.deepEqual(call.arguments, {});
  assert.equal(call.extra.arguments_source, 'not recorded');
});

test('a session whose only output was a block still has a trajectory', () => {
  // From the recorded run: @dry2’s reply is left out, and a block of its turn takes its place, shaped as
  // server/block-show.mjs adds one.
  const id = sessionOf('dry2');
  const reply = rec.events.find((e) => e.type === 'item.add' && e.data.item.sessionId === id && e.data.item.kind === 'agent');
  const { item } = reply.data;
  const block = {
    id: 'it_only_block',
    at: item.at,
    kind: 'block',
    sessionId: id,
    handle: 'dry2',
    turnId: item.turnId,
    block: { type: 'choice', id: 'pick', fallback: 'Pick one.' },
  };
  const events = rec.events.flatMap((e) => {
    if (e === reply) return [{ ...e, data: { threadId: e.data.threadId, item: block } }];
    return e.data?.id === item.id ? [] : [e];
  });
  const t = of('dry2', events);
  assert.deepEqual(
    t.steps.map((s) => [s.source, s.extra.item_id ?? s.extra.event]),
    [
      ['user', t.steps[0].extra.item_id],
      ['system', 'turn.guide'],
      ['system', 'turn.prompt'],
      ['agent', 'it_only_block'],
    ],
  );
  assert.equal(t.steps[3].metrics.completion_tokens, 102);
});

test('each reply names the model that ran it, and the trajectory names a default only when one model ran it all', () => {
  // The recorded run replays a Claude Code turn on claude-sonnet-5-5, then two on claude-opus-5-5 (dry-run.md).
  const t = of('dry');
  assert.deepEqual(
    t.steps.filter((s) => s.source === 'agent').map((s) => s.model_name),
    ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5'],
  );
  assert.equal(t.agent.model_name, undefined, 'no default: two models ran');
  assert.deepEqual(t.agent.extra.models, ['claude-sonnet-5-5', 'claude-opus-5-5']);
  assert.equal(of('dry2').agent.model_name, 'claude-sonnet-5-5');
});
