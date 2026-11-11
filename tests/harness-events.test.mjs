// The harness-event contract’s core (server/harness-events.mjs): what Postbox builds from an adapter’s events.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HarnessEvents } from '../server/harness-events.mjs';
import { STEP_TEXT } from '../shared/limits.mjs';

/** A turn context that records each step. */
const fakeCtx = () => {
  /** @type {any[]} */
  const activity = [];
  return { activity, ctx: { activity: (/** @type {any} */ a) => activity.push(a), status: () => {}, text: () => {} } };
};

test('a long output keeps its end, from a whole line, marked as cut', () => {
  const { ctx, activity } = fakeCtx();
  const { event } = new HarnessEvents(ctx, { now: () => 0 });
  const lines = Array.from({ length: 200 }, (_, i) => `/workspace/project/file-${i}.json`).join('\n');
  event({ kind: 'tool_call', id: 't1', name: 'Bash', input: { command: 'ls' }, final: true });
  event({ kind: 'tool_result', id: 't1', text: lines });
  const { output } = activity.at(-1);
  assert.ok(output.startsWith('…/workspace/project/file-'), 'it starts at a whole line, marked');
  assert.ok(output.endsWith('file-199.json'), 'and keeps the end');
  assert.ok(output.length <= STEP_TEXT.output + 1);
});

test('a short output is kept whole, unmarked', () => {
  const { ctx, activity } = fakeCtx();
  const { event } = new HarnessEvents(ctx, { now: () => 0 });
  event({ kind: 'tool_call', id: 't1', name: 'Bash', input: { command: 'wc -w a.txt' }, final: true });
  event({ kind: 'tool_result', id: 't1', text: '3 a.txt' });
  assert.equal(activity.at(-1).output, '3 a.txt');
});
