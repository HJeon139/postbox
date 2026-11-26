// A trajectory’s tool calls: the tool’s name, its arguments and its session (tools/atif-calls.mjs). The fixture is the
// recorded dry run in tests/fixtures/atif/dry-run, as tests/atif.test.mjs reads it, where these tests were.

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
const sessionOf = (handle) => rec.events.find((e) => e.type === 'session' && e.data.handle === handle).data.id;

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
        started_at: '2026-11-20T01:52:56.530Z',
        exit: 0,
        arguments_source: 'work ledger',
        display_input: 'command: printenv CLAUDE_EFFORT',
        display_output: 'high',
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
  assert.equal(bare.tool_calls[0].extra.display_output, undefined);
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

test('a call’s name comes from its own step, so a call the ledger doesn’t keep is still named', () => {
  const events = rec.events.filter((e) => !(e.type === 'work.add' && e.data.entry.kind === 'command'));
  const call = of('dry', events).steps.find((s) => s.tool_calls)?.tool_calls[0];
  assert.equal(call.function_name, 'Bash');
  assert.deepEqual(call.arguments, {});
  assert.equal(call.extra.arguments_source, 'not recorded');
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
