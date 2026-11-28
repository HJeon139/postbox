// #585: the conformance probe opens Codex threads through the adapter’s own openCodexThread and codexOpenConfig, so
// what it sends is what Postbox sends: a start with the guide, a resume and a fork with excludeTurns, as
// server/adapters/codex-thread.mjs sends them, and no skills root, as for a turn on a host.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexOpenConfig } from '../server/adapters/codex-thread.mjs';
import { openThread } from '../tools/conformance/codex-open.mjs';

/** A request function that records each call and answers with a thread. */
const recorder = () => {
  /** @type {{ method: string, params: any }[]} */
  const calls = [];
  const request = async (/** @type {string} */ method, /** @type {any} */ params) => {
    calls.push({ method, params });
    return { thread: { id: 'thr-1' } };
  };
  return { calls, request };
};

test('a start, a resume and a fork each send the adapter’s params, with the guide where the adapter puts it', async () => {
  const guide = 'guide MARK-1';
  const { calls, request } = recorder();
  await openThread(request, { cwd: '/work', guide });
  await openThread(request, { cwd: '/work', guide, sourceThreadId: 'thr-1' });
  await openThread(request, { cwd: '/work', guide, sourceThreadId: 'thr-1', forkTurnId: 'turn-2' });
  assert.deepEqual(calls, [
    { method: 'thread/start', params: { cwd: '/work', ...codexOpenConfig(guide) } },
    { method: 'thread/resume', params: { threadId: 'thr-1', cwd: '/work', excludeTurns: true, ...codexOpenConfig(guide) } },
    { method: 'thread/fork', params: { threadId: 'thr-1', lastTurnId: 'turn-2', excludeTurns: true, ...codexOpenConfig(guide) } },
  ]);
});
