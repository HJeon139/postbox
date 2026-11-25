// ATIF v1.8 trajectories from Postbox’s recorded events (tools/atif.mjs, tools/atif-export.mjs). The fixture is a recorded /api/stream and its prompts.jsonl:
// tests/fixtures/atif/dry-run.md says how it was made. The rules checked here are Harbor’s (harbor-framework/harbor,
// src/harbor/models/trajectories/).

import assert from 'node:assert/strict';

import { test } from 'node:test';
import { trajectories } from '../tools/atif.mjs';
import { POSTBOX_VERSION, readRecording } from '../tools/atif-export.mjs';

const DIR = new URL('fixtures/atif/dry-run/', import.meta.url).pathname;
const rec = readRecording(DIR);
const all = (events = rec.events, live = rec.live, prompts = rec.prompts) => trajectories(events, { version: POSTBOX_VERSION, live, prompts });
const of = (handle, events, live, prompts) => {
  const found = all(events, live, prompts).filter((t) => t.handle === handle);
  assert.equal(found.length, 1, handle);
  return found[0].trajectory;
};
const AGENT_ONLY = ['model_name', 'reasoning_effort', 'reasoning_content', 'tool_calls', 'metrics'];
/** Whether an item reached the agent in a trajectory: as a step of its own, or carried by a turn’s recorded prompt. */
const reached = (t, itemId) => t.steps.some((s) => s.extra.item_id === itemId || s.extra.delivered?.some((d) => d.item_id === itemId));
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

test('a step is each reply and each prompt, which carries what reached the inbox, at the server’s time', () => {
  const t = of('dry');
  const id = sessionOf('dry');
  const added = rec.events.filter((e) => e.type === 'item.add').map((e) => e.data.item);
  const entries = new Map(rec.events.filter((e) => e.type === 'entry.add' && e.data.sessionId === id).map((e) => [e.data.entry.id, e.data.entry.itemId]));
  const taken = rec.events.filter((e) => e.type === 'entry.patch' && e.data.patch.takenBy && entries.has(e.data.id));
  const delivered = new Set(taken.map((e) => entries.get(e.data.id)));
  const own = added.filter((it) => it.sessionId === id && it.kind === 'agent');
  // Each prompt it was sent, and its guide before the first prompt that went with it.
  const prompts = rec.prompts.filter((r) => r.type === 'prompt' && r.sessionId === id);
  const guides = new Set(prompts.map((r) => r.guideSha)).size;
  assert.equal(prompts.length, 3);
  assert.equal(guides, 1);
  // Every message a turn took is carried by that turn’s prompt, so none is a step of its own; the clock is no step.
  assert.equal(t.steps.length, own.length + prompts.length + guides);
  assert.deepEqual(
    t.steps
      .flatMap((s) => s.extra.delivered ?? [])
      .map((d) => d.item_id)
      .sort(),
    [...delivered].sort(),
  );
  assert.equal(t.final_metrics.total_steps, t.steps.length);
  const at = new Map(added.map((it) => [it.id, it.at]));
  // A prompt step is at its prompt’s time, and its guide’s at the same prompt’s.
  const promptAt = new Map(prompts.map((r) => [r.turnId, r.at]));
  const timeOf = (s) => {
    if (s.extra.record === 'prompt') return promptAt.get(s.extra.turn_id);
    if (s.extra.record === 'guide') return prompts.find((r) => r.guideSha === s.extra.sha).at;
    return at.get(s.extra.item_id);
  };
  for (const s of t.steps) assert.equal(s.timestamp, new Date(timeOf(s)).toISOString(), `step ${s.step_id}`);
  // The replayed Claude Code lines carry the time they were recorded, on another host: no step takes it.
  assert.ok(!t.steps.some((s) => s.timestamp.startsWith('2026-10-22')));
});

test('a message to another agent that never reached this one’s inbox is no step of its', () => {
  const toDry2 = rec.events.find((e) => e.type === 'item.add' && /only for you/.test(e.data.item.text ?? '')).data.item;
  assert.equal(reached(of('dry'), toDry2.id), false);
  // @dry2’s one turn carried it, in the prompt it was sent.
  const [prompt] = of('dry2').steps.filter((s) => s.source === 'user');
  assert.equal(prompt.extra.record, 'prompt');
  assert.deepEqual(
    prompt.extra.delivered.map((d) => d.item_id),
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

test('a block the agent showed is a step with no model call, and its turn’s tokens still count toward the totals', () => {
  const { turnId, t } = withBlockTurn({ keepBlock: true });
  const shown = t.steps.find((s) => s.extra.item_id === 'it_block');
  assert.equal(shown.source, 'agent');
  assert.equal(shown.extra.turn_id, turnId);
  // Harbor’s rule for llm_call_count 0: no metrics, no reasoning; and no model is credited with it either.
  assert.equal(shown.llm_call_count, 0);
  assert.equal(shown.metrics, undefined);
  assert.equal(shown.model_name, undefined);
  assert.deepEqual(
    t.final_metrics.extra.unattached_turns.map((u) => [u.turn_id, u.metrics.completion_tokens]),
    [[turnId, 282]],
  );
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
  assert.deepEqual(file.prompts, rec.prompts);
  assert.equal(rec.prompts.length, 6, 'the prompts.jsonl beside it');
  assert.ok(rec.events.length > 0 && rec.live.length > 0);
  assert.equal(trajectories(rec.events, { version: '0', sessionId: 'se_none' }).length, 0);
});

test('a message that waited in the agent’s inbox and no turn took is no step of its', () => {
  // From the recorded run: the take of @dry’s second message is left out, as when its clock had expired first.
  const second = rec.events.filter((e) => e.type === 'entry.patch' && e.data.sessionId === sessionOf('dry') && e.data.patch.takenBy)[1];
  const entry = rec.events.find((e) => e.type === 'entry.add' && e.data.entry.id === second.data.id).data.entry;
  const t = of(
    'dry',
    rec.events.filter((e) => e !== second),
  );
  assert.equal(reached(t, entry.itemId), false);
  assert.equal(reached(of('dry'), entry.itemId), true);
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
    t.steps.map((s) => [s.source, s.extra.item_id ?? s.extra.record]),
    [
      ['system', 'guide'],
      ['user', 'prompt'],
      ['agent', 'it_only_block'],
    ],
  );
  assert.equal(t.steps[1].extra.delivered.length, 1, 'the prompt carried the message to it');
  assert.equal(t.final_metrics.extra.unattached_turns[0].metrics.completion_tokens, 102);
});

test('a reply with no time keeps its step, with no timestamp, and every trajectory of the run is still made', () => {
  // One item without `at` used to throw in toISOString and lose every trajectory of the run. ATIF’s timestamp is optional.
  const reply = rec.events.find((e) => e.type === 'item.add' && e.data.item.kind === 'agent');
  const events = rec.events.map((e) => (e === reply ? { ...e, data: { ...e.data, item: { ...e.data.item, at: undefined } } } : e));
  const before = all().map((t) => t.handle);
  const got = all(events);
  assert.deepEqual(
    got.map((t) => t.handle),
    before,
  );
  const step = got.flatMap((t) => t.trajectory.steps).find((s) => s.extra?.item_id === reply.data.item.id);
  assert.ok(step, 'its step is kept');
  assert.equal(step.timestamp, undefined);
});

test('a call’s ledger entry is its own session’s, though another session’s call has the same id', () => {
  // From the recorded run: @dry and @dry2 each ran `printenv CLAUDE_EFFORT` under the same tool call id. With @dry2’s
  // command line changed, @dry’s call still names its own.
  const events = rec.events.map((e) =>
    e.type === 'work.add' && e.data.entry.kind === 'command' && e.data.entry.handle === 'dry2'
      ? { ...e, data: { ...e.data, entry: { ...e.data.entry, command: 'echo not dry' } } }
      : e,
  );
  const call = (h) => of(h, events).steps.find((s) => s.tool_calls)?.tool_calls[0];
  assert.equal(call('dry').arguments.command, 'printenv CLAUDE_EFFORT');
  assert.equal(call('dry2').arguments.command, 'echo not dry');
});
