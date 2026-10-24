// Kept jobs that share processes (#167): stopping one ends another only when every process group still its own was
// signaled, so a job with a group left running stays listed, where it can be stopped.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './stop-fixture.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('#167: a job that shares one of its groups with the job stopped, but has another running, stays listed', async () => {
  const { rt, store, adapter, t, se, procs } = setup();
  const groups = { bgX: [500, 501], bgY: [500, 502] };
  let exit = () => {};
  adapter.next.push(async (c) => {
    Object.keys(groups).forEach((id, n) => {
      c.activity({ id: `tu_${n}`, label: id, state: 'running', job: id });
      c.job({ id, toolUseId: `tu_${n}`, label: id, command: `run ${id}`, outputFile: null, state: 'running' });
    });
    await new Promise((r) => c.signal.addEventListener('abort', r));
    for (const [id, gs] of Object.entries(groups)) c.job({ id, kept: true, pgid: gs[0], groups: gs.map((pgid) => ({ pgid, command: null })) });
    await new Promise((r) => {
      exit = r;
    });
  });
  rt.sendMessage(t.id, { text: 'go' });
  await sleep(5);
  rt.stop(se.id, { jobs: 'keep' });
  exit();
  await sleep(10);
  // Each group has a running member and no leader, so each is still the job’s own.
  procs.push(...[500, 501, 502].map((pgid) => ({ pid: pgid + 100, ppid: 1, pgid, command: 'sleep 5' })));
  await rt.stopJob(se.id, 'bgX');
  assert.deepEqual(
    store.state.sessions[se.id].jobs.map((j) => `${j.id} ${j.kept}`),
    ['bgY true'],
  );
});
