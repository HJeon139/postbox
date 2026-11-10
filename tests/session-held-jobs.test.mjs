// Session writes decided from a session read behind a held commit (#796's class in sessions): an item brought forward
// moves the catch-up markers held on it (#956), and a kept job's end decides on its held steps (#957).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catchUp } from '../server/catch-up.mjs';
import { setup } from './side-threads-fixture.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

/** The side-thread room on a store whose log sync can be held; hold() holds a commit and returns its release. */
async function heldRoom() {
  const h = await heldStore();
  const f = setup(h.store);
  await h.store.flush();
  const hold = async () => {
    h.hold();
    const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
    await h.atSync;
    return async () => {
      h.release();
      await commit;
      await h.store.flush();
    };
  };
  return { ...f, h, hold };
}

/** Three messages in the conversation, it_a, it_x and it_b, on disk. */
async function threeItems(f) {
  for (const id of ['it_a', 'it_x', 'it_b']) f.store.emit('item.add', { threadId: f.t.id, item: { id, kind: 'user', text: `text of ${id}`, at: Date.now() } });
  await f.store.flush();
}

const stubOf = (f, threadId, id) => f.store.items(threadId).find((x) => x.kind === 'moved' && x.itemId === id);

test('bringForward unheld moves the marker to the stub', async () => {
  const f = await heldRoom();
  await threeItems(f);
  f.rt.updateSession(f.alpha.id, { seenItem: 'it_x' });
  assert.equal(f.rt.bringForward(f.t.id, 'it_x', { what: 'block', title: 'X' }), true);
  await f.store.flush();
  assert.equal(f.store.state.sessions[f.alpha.id].seenItem, stubOf(f, f.t.id, 'it_x').id);
  await f.store.close();
});

test('bringForward behind a held commit: a session whose held seenItem was the moved item reads on from the stub', async () => {
  const f = await heldRoom();
  await threeItems(f);
  f.rt.updateSession(f.beta.id, { seenItem: 'it_a' });
  await f.store.flush();
  const release = await f.hold();
  f.rt.updateSession(f.alpha.id, { seenItem: 'it_x' }); // a catch-up that just ran, held
  const moved = f.rt.bringForward(f.t.id, 'it_x', { what: 'block', title: 'X' });
  await release();
  assert.equal(moved, true);
  const stub = stubOf(f, f.t.id, 'it_x');
  assert.ok(stub, 'a stub took its place');
  assert.equal(f.store.state.sessions[f.alpha.id].seenItem, stub.id, 'seenItem moved to the stub');
  assert.equal(f.store.state.sessions[f.beta.id].seenItem, 'it_a', 'a marker on another item is untouched');
  assert.match(catchUp(f.rt, f.store.state.sessions[f.alpha.id]) ?? '', /text of it_b/, 'the next catch-up skips nothing');
  await f.store.close();
});

/** A progress step running in the conversation, it_p:s, and kept jobs of @alpha's (bg1, ...), on disk. */
async function keptJobs(f, ids = ['bg1'], { kept = true, heldSteps = true } = {}) {
  const se = f.alpha;
  f.store.emit('item.add', {
    threadId: f.t.id,
    item: {
      id: 'it_p',
      kind: 'block',
      valid: true,
      sessionId: se.id,
      block: { id: 'hb', type: 'progress', version: 1, title: 'Heartbeat', fallback: 'Heartbeat', steps: [{ id: 's', label: 'Watch', state: 'running' }] },
    },
  });
  const job = (id) => ({
    id,
    sessionId: se.id,
    threadId: f.t.id,
    turnId: 'tu_x',
    toolUseId: `toolu_${id}`,
    command: 'sleep 60',
    state: 'running',
    kept,
    startedAt: Date.now(),
  });
  f.rt.updateSession(se.id, { jobs: ids.map(job), ...(heldSteps ? { heldSteps: { threadId: f.t.id, keys: ['it_p:s'] } } : {}) });
  await f.store.flush();
  return se;
}

const stepState = (f) => f.store.items(f.t.id).find((x) => x.id === 'it_p').block.steps[0].state;
const told = (f, se) => (f.store.state.sessions[se.id].context ?? []).join(' | ');

test('control: the last kept job ends, unheld: its held steps stall and heldSteps clears', async () => {
  const f = await heldRoom();
  const se = await keptJobs(f);
  f.rt.endJob(se.id, 'bg1', 'done');
  await f.store.flush();
  const now = f.store.state.sessions[se.id];
  assert.deepEqual(now.jobs, []);
  assert.equal(now.heldSteps, null);
  assert.equal(stepState(f), 'stalled');
  await f.store.close();
});

test('the last kept job ends behind a held commit: its held steps stall and heldSteps clears', async () => {
  const f = await heldRoom();
  const se = await keptJobs(f);
  const release = await f.hold();
  f.rt.endJob(se.id, 'bg1', 'done');
  await release();
  const now = f.store.state.sessions[se.id];
  assert.deepEqual(now.jobs, [], 'the job left the list');
  assert.equal(now.heldSteps, null, 'heldSteps cleared once the last kept job ended');
  assert.equal(stepState(f), 'stalled', 'the step held with the job stalls');
  assert.match(told(f, se), /ended while progress steps were running/, 'the agent is told');
  await f.store.close();
});

test('one of two kept jobs ends behind a held commit: its held steps run on', async () => {
  const f = await heldRoom();
  const se = await keptJobs(f, ['bg1', 'bg2']);
  const release = await f.hold();
  f.rt.endJob(se.id, 'bg1', 'done');
  await release();
  const now = f.store.state.sessions[se.id];
  assert.deepEqual(
    now.jobs.map((j) => j.id),
    ['bg2'],
  );
  assert.deepEqual(now.heldSteps?.keys, ['it_p:s'], 'still held: bg2 runs');
  assert.equal(stepState(f), 'running');
  await f.store.close();
});

test('two kept jobs end behind one held commit: both leave the list, and the held steps stall', async () => {
  const f = await heldRoom();
  const se = await keptJobs(f, ['bg1', 'bg2']);
  const release = await f.hold();
  f.rt.endJob(se.id, 'bg1', 'done');
  f.rt.endJob(se.id, 'bg2', 'done');
  await release();
  const now = f.store.state.sessions[se.id];
  assert.deepEqual(now.jobs, [], 'the second end starts from the list the first left');
  assert.equal(now.heldSteps, null);
  assert.equal(stepState(f), 'stalled');
  await f.store.close();
});

test('a job Keep running lost, behind Stop’s held write, stalls its held steps', async () => {
  const f = await heldRoom();
  const se = await keptJobs(f, ['bg1'], { kept: false, heldSteps: false });
  const release = await f.hold();
  // What stop({ jobs: 'keep' }) writes, held, then the job it couldn't keep ends (server/runtime.mjs, KEEP_LOST).
  f.rt.updateSession(se.id, { heldSteps: { threadId: f.t.id, keys: ['it_p:s'] } });
  const lost = 'Postbox couldn’t find its process to keep it running: it may have ended with the agent, and Postbox can’t show it or stop it.';
  f.rt.endJob(se.id, 'bg1', 'stopped', lost);
  await release();
  assert.equal(f.store.state.sessions[se.id].heldSteps, null);
  assert.equal(stepState(f), 'stalled');
  assert.match(told(f, se), /ended while progress steps were running/);
  await f.store.close();
});

test('a kept job recorded behind a held commit and ended behind it leaves the list', async () => {
  const f = await heldRoom();
  const se = await keptJobs(f, ['bg1']);
  const release = await f.hold();
  const bg2 = { ...f.store.pending.session(se.id).jobs[0], id: 'bg2', toolUseId: 'toolu_bg2' };
  f.rt.updateSession(se.id, (s) => ({ jobs: [...s.jobs, bg2] })); // recorded, held
  f.rt.endJob(se.id, 'bg2', 'done');
  await release();
  assert.deepEqual(
    f.store.state.sessions[se.id].jobs.map((j) => j.id),
    ['bg1'],
    'the job recorded behind the commit is found, and ends',
  );
  await f.store.close();
});
