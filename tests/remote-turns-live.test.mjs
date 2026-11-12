// A turn on a host reports through the harness-event contract (server/harness-events.mjs) as a local one does: the
// recorded Claude Code stream the fake daemon replays (tests/fixtures/claude-code/permission-allow.jsonl) goes
// through the Claude Code adapter's mapper on this computer, and its reply keeps the steps the live view draws
// (app/js/activity-live.mjs): each call's input and output, where it fell in the reply's words, and its state.
// The rig is tests/remote-turns-helpers.mjs; nothing here starts a process or opens a connection.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rig, running, settled, until } from './remote-turns-helpers.mjs';

test('#120 a host turn’s steps carry their input, output and place in the words, as the contract builds them here', async () => {
  const r = rig();
  const turn = await running(r);
  // While it runs: the live view's detail goes with the turn (shared/step-fold.mjs).
  await until(() => r.store.items(r.t.id).some((i) => i.activity?.steps?.some((s) => s.output)), 'the command’s output');
  const parts = r.store.items(r.t.id).filter((i) => i.kind === 'agent');
  const first = parts.find((i) => i.activity);
  assert.ok(first, `a part with steps: ${JSON.stringify(parts.map((p) => p.text))}`);
  const bash = first.activity.steps.find((s) => s.input?.includes('echo hello > hello.txt'));
  assert.ok(bash, JSON.stringify(first.activity.steps));
  assert.equal(bash.state, 'done');
  assert.match(bash.input, /^command: echo hello > hello\.txt && cat hello\.txt/, 'its input, as the step shows it');
  assert.equal(bash.output, 'hello', 'the end of what it printed');
  assert.equal(typeof bash.at, 'number', 'where it fell in the reply’s words');
  assert.ok(bash.at <= first.text.length);
  r.d.end(turn);
  await settled(r);
  assert.match(
    r.store
      .items(r.t.id)
      .map((p) => p.text ?? '')
      .join(''),
    /hello\.txt/,
    'and the words after it',
  );
});
