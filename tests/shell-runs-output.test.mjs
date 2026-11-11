// A running `!command`’s output in memory (#67, server/shell-runs.mjs): between flushes it holds at most twice the
// bound, so a command that floods its output can’t grow Postbox’s memory without limit before the next flush.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandOutput, MAX_COMMAND_OUTPUT } from '../server/shell-runs.mjs';

/** A runtime with an item that exists, which takes the flushes and keeps nothing. */
const rt = { store: { pending: { item: () => ({}) }, emit() {} }, patchItem() {} };

test('#67: a flood of output between flushes keeps at most twice the bound in memory, and its end', () => {
  const output = commandOutput(rt, 'th', 'it', '');
  let most = 0;
  for (let i = 0; i < 100; i++) {
    output.add('x'.repeat(16 * 1024));
    most = Math.max(most, output.kept());
  }
  output.add('END');
  assert.ok(most <= 2 * MAX_COMMAND_OUTPUT, `it held ${most} characters before a flush`);
  assert.equal(output.cut(), true);
  output.flush({ final: true });
});
