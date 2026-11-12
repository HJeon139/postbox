// A running `!command`’s output in memory (#67, server/shell-runs.mjs): between flushes it holds at most twice the
// bound, so a command that floods its output can’t grow Postbox’s memory without limit before the next flush, and
// what it keeps is the output’s end, which the item shows when the command ends.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandOutput, MAX_COMMAND_OUTPUT } from '../server/shell-runs.mjs';

/** A runtime with an item that exists, which keeps the text each refresh of the item writes. */
function fakeRuntime() {
  const written = [];
  const rt = { store: { pending: { item: () => ({}) }, emit() {} }, patchItem: (_t, _id, patch) => written.push(patch.text) };
  return { rt, written };
}

test('#67: a flood of output between flushes keeps at most twice the bound in memory', () => {
  const output = commandOutput(fakeRuntime().rt, 'th', 'it', '');
  let most = 0;
  for (let i = 0; i < 100; i++) {
    output.add('x'.repeat(16 * 1024));
    most = Math.max(most, output.kept());
  }
  assert.ok(most <= 2 * MAX_COMMAND_OUTPUT, `it held ${most} characters before a flush`);
  assert.equal(output.cut(), true);
  output.flush({ final: true });
});

test('#67: what a flood keeps between flushes is its end, so the item ends with the last output', () => {
  const { rt, written } = fakeRuntime();
  const output = commandOutput(rt, 'th', 'it', '');
  let all = '';
  // Each chunk is its own letter, so a kept start and a kept end differ.
  for (let i = 0; i < 100; i++) {
    const chunk = String.fromCharCode(97 + (i % 26)).repeat(16 * 1024);
    all += chunk;
    output.add(chunk);
  }
  output.flush({ final: true });
  assert.equal(written.at(-1), all.slice(-MAX_COMMAND_OUTPUT), 'the item shows the last output');
});
