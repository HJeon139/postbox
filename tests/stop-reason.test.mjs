// Why a reply stopped (#215, #249): Send now, Stop with its background jobs kept running, or a plain Stop. The reply
// records which, and the agent’s next turn hears that its kept jobs are still running.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup, slowToExit } from './stop-fixture.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JOB = { id: 'bgR', command: 'while true; do date >> heartbeat-1.log; sleep 5; done' };

/** Starts a turn with a background job, ends it with `end`, and returns the reply and the next turn’s message. */
async function stopAnd(end) {
  const { rt, store, adapter, t, se } = setup();
  const first = slowToExit({ job: JOB });
  adapter.next.push(first);
  rt.sendMessage(t.id, { text: 'Start the heartbeat loop and check it every 20 seconds.' });
  await sleep(5);
  end(rt, t, se);
  first.exit();
  await sleep(15);
  if (adapter.calls.length < 2) rt.sendMessage(t.id, { text: 'Is it still running?' });
  await sleep(10);
  const reply = store.items(t.id).find((i) => i.kind === 'agent' && i.status === 'stopped');
  return { reply, next: adapter.calls[1].message };
}

test('#249: after Stop with Keep running, the reply says its jobs kept running, and the agent hears they weren’t stopped', async () => {
  const { reply, next } = await stopAnd((rt, _t, se) => rt.requestStop(se.id, { jobs: 'keep' }));
  assert.equal(reply.stopReason, 'kept-jobs');
  // Before #249 it read “…is still running: the person kept it running when your last turn was stopped. Its output…”.
  // Claude Code, resumed, then told the agent the job was “marked stopped”: with no end recorded for a background
  // command, it says it “may have been stopped … or it may have been running when the previous Claude Code process
  // exited” (its resume notice, in the CLI the Agent SDK 0.3.306 ships).
  assert.deepEqual(next.context, [
    `[Postbox] Your background job bgR (\`${JOB.command}\`) is still running: the person stopped your last turn and kept this job running. If your CLI says it was stopped, that’s only because the process that started it has ended: it wasn’t stopped. Its output is in /tmp/out.txt. They can stop it from the conversation. If a progress step follows it, leave that step running while the job runs: when it ends, Postbox tells you on your next turn.`,
  ]);
});

test('#215: a reply Send now interrupted says so, and so does the notice about its job, from the composer or the queue', async () => {
  const now = await stopAnd((rt, t) => rt.sendMessage(t.id, { text: 'Change of plan.', sendNow: true }));
  assert.equal(now.reply.stopReason, 'send-now');
  assert.equal(now.next.text, 'Change of plan.');
  assert.match(now.next.context[0], /bgR .* is still running: a message sent with Send now ended your last turn, but not this job\. If your CLI says/);
  const queued = await stopAnd((rt, t) => rt.sendQueuedNow(t.id, rt.sendMessage(t.id, { text: 'Queued, then sent now.' }).queued.id));
  assert.equal(queued.reply.stopReason, 'send-now');
  assert.equal(queued.next.text, 'Queued, then sent now.');
});

test('#215: a plain Stop says Stop, its jobs stopped or none to keep; a shutdown records no reason', async () => {
  const both = await stopAnd((rt, _t, se) => rt.requestStop(se.id, { jobs: 'stop' }));
  assert.equal(both.reply.stopReason, 'stop');
  // Keep running with nothing left to keep is a plain Stop.
  const { rt, store, adapter, t, se } = setup();
  const reply = () => store.items(t.id).findLast((i) => i.kind === 'agent');
  for (const [opts, want] of [
    [{ jobs: 'keep' }, 'stop'],
    [{ silent: true, by: 'shutdown' }, null],
  ]) {
    const turn = slowToExit();
    adapter.next.push(turn);
    rt.sendMessage(t.id, { text: 'go' });
    await sleep(5);
    assert.equal(rt.stop(se.id, opts), true);
    assert.equal(reply().stopReason, want, JSON.stringify(opts));
    turn.exit();
    await sleep(10);
  }
});

test('#249: Keep running that kept no job after all, with no process left to keep, says only Stopped by you', async () => {
  const { rt, store, adapter, t, se } = setup();
  const first = slowToExit({ job: JOB, kept: null });
  adapter.next.push(first);
  rt.sendMessage(t.id, { text: 'go' });
  await sleep(5);
  rt.requestStop(se.id, { jobs: 'keep' });
  assert.equal(store.items(t.id).find((i) => i.kind === 'agent').stopReason, 'kept-jobs', 'what you chose, until the turn has gone');
  first.exit();
  await sleep(10);
  assert.deepEqual(store.state.sessions[se.id].jobs, []);
  assert.equal(store.items(t.id).find((i) => i.kind === 'agent').stopReason, 'stop');
});

// Review of #264: a kept job stopped from its row before the CLI exited was no longer listed, so the reply lost it.
test('#249: a kept job stopped from its row before its CLI exits still leaves the reply saying its work kept running', async () => {
  const { rt, store, adapter, t, se, procs } = setup();
  const first = slowToExit({ job: JOB });
  adapter.next.push(first);
  rt.sendMessage(t.id, { text: 'go' });
  await sleep(5);
  rt.requestStop(se.id, { jobs: 'keep' });
  await sleep(5);
  assert.ok(
    store.state.sessions[se.id].jobs.some((j) => j.kept),
    'kept',
  );
  procs.length = 0;
  await rt.stopJob(se.id, JOB.id);
  first.exit();
  await sleep(10);
  assert.equal(store.items(t.id).find((i) => i.kind === 'agent').stopReason, 'kept-jobs');
});
