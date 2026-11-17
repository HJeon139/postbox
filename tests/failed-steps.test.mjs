// A failed turn’s progress steps (#664): a turn that really failed leaves the steps it left running failed, and a step
// failed so keeps its time when the agent marks it done or running later. A turn that goes on, as a resend after the
// network dropped, leaves them stalled (server/turn-checks.mjs, failedHow).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settle, setup, sleep } from './side-threads-fixture.mjs';

const lost = () => async () => {
  throw new Error('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
};

/** A progress block of these steps. @param {any[]} steps */
const progress = (steps) => ({ id: 'job', type: 'progress', version: 1, title: 'Reading', fallback: 'Reading', steps });

test('#664 a step its failed turn failed, marked done later, keeps its time; running again keeps its start', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => {
    c.tools.show_block({
      block: progress([
        { id: 'a', label: 'Read A', state: 'running' },
        { id: 'b', label: 'Read B', state: 'running' },
      ]),
    });
    throw new Error('The model didn’t respond.');
  });
  rt.sendMessage(t.id, { text: '@beta read' });
  await settle(rt);
  const shown = store.items(t.id).find((i) => i.kind === 'block');
  assert.equal(shown.block.steps[0].state, 'failed');
  adapter.next.push(async (c) => {
    await sleep(15);
    c.tools.update_block({
      block: progress([
        { id: 'a', label: 'Read A', state: 'done' },
        { id: 'b', label: 'Read B', state: 'running' },
      ]),
    });
  });
  rt.sendMessage(t.id, { text: '@beta go on' });
  await settle(rt);
  const it = store.items(t.id).find((i) => i.kind === 'block');
  assert.match(it.block.steps[0].duration ?? '', /^\d/, 'failed, then done: its time from when it started');
  assert.equal(it.stepTimes.a.startedAt, shown.at, 'it started when it was shown');
  assert.equal(it.stepTimes.b.startedAt, shown.at, 'failed, then running: it keeps its start');
});

test('#664 a turn lost to the network and sent again leaves its running steps stalled, not failed', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => {
    c.tools.show_block({ block: progress([{ id: 'a', label: 'Read A', state: 'running' }]) });
    return lost()();
  });
  rt.sendMessage(t.id, { text: '@beta go' });
  await settle(rt);
  assert.equal(adapter.calls.length, 2, 'the resend ran');
  const it = store.items(t.id).find((i) => i.kind === 'block');
  assert.equal(it.block.steps[0].state, 'stalled', 'its turn goes on as the resend, so the step didn’t fail');
});
