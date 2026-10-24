// Stop settles every step its turn hadn’t finished (#288): a background job Stop kept running stays running, as the
// job does, and anything else still running reads as stopped. After Stop the turn takes no more activity, so nothing
// else would say how a foreground call ended.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup, shellRow } from './stop-fixture.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The reply’s steps as the p0 UAT recorded them at its Stop (Postbox 0.30.1, the store’s events for one reply): a
// background loop with its job, a wait that had finished, and the same wait running when the person pressed Stop.
const BG = {
  id: 'b2k0z7ukq',
  label: 'Append timestamps to heartbeat-2.log every 5 seconds for 3 minutes',
  command: 'for i in $(seq 1 36); do echo "$(date)" >> heartbeat-2.log; sleep 5; done',
};
const WAIT = 'Wait 20 seconds, then count lines in heartbeat-2.log';

/** A turn that starts the job, finishes one wait and is in the next when it’s stopped; its CLI reports the job’s end. */
function heartbeat() {
  return async (c) => {
    c.text('Started the loop.');
    c.activity({ id: 'toolu_bg', label: BG.label, state: 'running', job: BG.id });
    c.job({ id: BG.id, toolUseId: 'toolu_bg', label: BG.label, command: BG.command, outputFile: '/tmp/out.txt', state: 'running' });
    c.activity({ id: 'toolu_w1', label: WAIT, state: 'done', ms: 21237 });
    c.activity({ id: 'toolu_w2', label: WAIT, state: 'running' });
    await new Promise((r) => c.signal.addEventListener('abort', r));
    c.job(c.signal.reason?.keepJobs?.length ? { id: BG.id, kept: true, pgid: 4242 } : { id: BG.id, state: 'stopped' });
  };
}

async function stopWith(jobs) {
  const { rt, store, adapter, t, se, procs } = setup();
  procs.push(shellRow(4242, BG.command));
  adapter.next.push(heartbeat());
  rt.sendMessage(t.id, { text: 'Start a background loop that appends the time to heartbeat-2.log, and check it every 20 seconds.' });
  await sleep(5);
  assert.deepEqual(rt.requestStop(se.id, { jobs }), { stopped: true });
  await sleep(15);
  const reply = store.items(t.id).find((i) => i.kind === 'agent');
  return { reply, steps: reply.activity.steps.map((s) => [s.label, s.state]) };
}

test('#288 Stop it too: the foreground call and the background job both read as stopped', async () => {
  const { reply, steps } = await stopWith('stop');
  assert.equal(reply.status, 'stopped');
  // Before #288 the running wait stayed “running” on the stopped reply, and its header said so.
  assert.deepEqual(steps, [
    [BG.label, 'stopped'],
    [WAIT, 'done'],
    [WAIT, 'stopped'],
  ]);
});

test('#288 Keep running: the kept job’s step runs on, and the foreground call reads as stopped', async () => {
  const { reply, steps } = await stopWith('keep');
  assert.equal(reply.stopReason, 'kept-jobs');
  assert.deepEqual(steps, [
    [BG.label, 'running'],
    [WAIT, 'done'],
    [WAIT, 'stopped'],
  ]);
});
