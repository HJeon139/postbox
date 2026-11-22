// The harness-event contract’s core (server/harness-events.mjs): what Postbox builds from an adapter’s events.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HarnessEvents } from '../server/harness-events.mjs';
import { stepInput, stepOutput } from '../server/step-text.mjs';
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
  assert.ok(output.length <= STEP_TEXT.output, 'the mark is within the bound');
  assert.equal(stepOutput(output), output, 'so the runtime’s bound keeps it');
});

test('a short output is kept whole, unmarked', () => {
  const { ctx, activity } = fakeCtx();
  const { event } = new HarnessEvents(ctx, { now: () => 0 });
  event({ kind: 'tool_call', id: 't1', name: 'Bash', input: { command: 'wc -w a.txt' }, final: true });
  event({ kind: 'tool_result', id: 't1', text: '3 a.txt' });
  assert.equal(activity.at(-1).output, '3 a.txt');
});

test('a long path in a step’s input is cut in its middle, so its file name stays', () => {
  const path = `/workspace/projects/${'project-folder/'.repeat(10)}scratchpad/notes-on-the-review.md`;
  const line = stepInput({ file_path: path });
  assert.ok(line.endsWith('scratchpad/notes-on-the-review.md'), line);
  assert.ok(line.startsWith('file_path: /workspace/projects/'), line);
  assert.ok(line.includes('…'), 'marked as cut');
  assert.ok(line.length < 140, 'and bounded');
  const command = stepInput({ command: `echo ${'word '.repeat(60)}` });
  assert.ok(command.endsWith('…') && command.startsWith('command: echo word'), 'anything else is cut at its end');
});

test('one long line, cut, keeps its mark through the runtime’s bound', () => {
  const { ctx, activity } = fakeCtx();
  const { event } = new HarnessEvents(ctx, { now: () => 0 });
  event({ kind: 'tool_call', id: 't1', name: 'Bash', input: { command: 'cat min.js' }, final: true });
  event({ kind: 'tool_result', id: 't1', text: 'x'.repeat(1000) });
  const { output } = activity.at(-1);
  assert.equal(output.length, STEP_TEXT.output);
  assert.ok(output.startsWith('…'));
});

test('a thought shows while the agent writes it: a running step with its text so far, at most once a second, then whole', () => {
  const { ctx, activity } = fakeCtx();
  let t = 0;
  const { event } = new HarnessEvents(ctx, { now: () => t });
  const thoughts = () => activity.filter((a) => a.kind === 'thought');
  event({ kind: 'thinking', text: 'The sum is wrong.', block: 'b1' });
  assert.equal(thoughts().length, 0, 'not in its first second: a short thought shows once, whole');
  t = 1100;
  event({ kind: 'thinking', text: ' It subtracts.', block: 'b1' });
  assert.deepEqual(
    thoughts().map((a) => [a.state, a.detail]),
    [['running', 'The sum is wrong. It subtracts.']],
    'its text so far, a second on',
  );
  t = 1500;
  event({ kind: 'thinking', text: ' Fix the operator.', block: 'b1' });
  assert.equal(thoughts().length, 1, 'not again within the second');
  event({ kind: 'thinking_end', block: 'b1' });
  const last = thoughts().at(-1);
  assert.deepEqual([last.state, last.detail], ['done', 'The sum is wrong. It subtracts. Fix the operator.']);
  assert.equal(new Set(thoughts().map((a) => a.id)).size, 1, 'one step throughout');
});

test('a step’s input leaves out what its label already says, such as a command’s description', () => {
  const { ctx, activity } = fakeCtx();
  const { event } = new HarnessEvents(ctx, { now: () => 0 });
  event({ kind: 'tool_call', id: 't1', name: 'Bash', input: { command: 'head -n 5 *.md', description: 'Preview each project file' }, final: true });
  const step = activity.at(-1);
  assert.equal(step.label, 'Preview each project file');
  assert.equal(step.input, 'command: head -n 5 *.md', 'the description is the label, said once');
  const long = 'Preview the opening lines of every file in the project folder, each one of the nine, to say what it holds';
  event({ kind: 'tool_call', id: 't2', name: 'Bash', input: { command: 'head *', description: long }, final: true });
  assert.equal(activity.at(-1).input, 'command: head *', 'also when the label is the description cut short');
});
