// Reads of a session that decide a write read it as written (#623): a session field written while a commit is held is
// pending, not published, so a reader of the published session misses it, and the write it decides undoes or repeats
// what the held write did. Each test writes the field behind a held commit, then makes the write that reads it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { offerNeed, releaseNeed } from '../server/card-needs.mjs';
import { recordJob, settleJobs } from '../server/job-records.mjs';
import { newId } from '../server/store.mjs';
import { threadLines } from '../server/thread-catch-up.mjs';
import * as arrange from './arrange.mjs';
import { heldStore, setup, until } from './stop-reply-fixture.mjs';

/** A room whose store holds a commit; `release` lets the commit, and what it held, through. */
async function heldRoom(step = async () => {}) {
  const h = await heldStore();
  const env = await setup(step, h.store);
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
  return { ...env, store: h.store, hold, close: () => h.store.close() };
}

/** A turn record as the job functions read it. @param {any} env */
const turnOf = (env) => ({ id: newId('tu'), sessionId: env.se.id, threadId: env.t.id, keepJobs: new Set(), stopReason: null });

test('a need set while a commit is held is released when its card is answered (#623, card-needs releaseNeed)', async () => {
  const env = await heldRoom();
  const release = await env.hold();
  arrange.setSession(env.rt, env.se.id, { needs: { kind: 'block', itemId: 'it_card', threadId: env.t.id }, state: 'needs' });
  releaseNeed(env.rt, env.se, 'it_card');
  await release();
  const se = env.store.state.sessions[env.se.id];
  assert.equal(se.needs, null, 'the need is released');
  assert.equal(se.state, 'idle');
  await env.close();
});

test('a lower card offered while a held commit set a higher need doesn’t take it (#623, card-needs offerNeed)', async () => {
  const env = await heldRoom();
  const release = await env.hold();
  arrange.setSession(env.rt, env.se.id, { needs: { kind: 'permission', itemId: 'it_perm', threadId: env.t.id }, state: 'needs' });
  const took = offerNeed(env.rt, env.se, { kind: 'hop', itemId: 'it_hop', threadId: env.t.id }, 'needs');
  await release();
  assert.equal(took, false, 'the hop card waits behind the permission');
  assert.equal(env.store.state.sessions[env.se.id].needs?.itemId, 'it_perm');
  await env.close();
});

test('a job recorded while a commit is held is ended at its turn’s end (#623, job-records settleJobs)', async () => {
  const env = await heldRoom();
  const turn = turnOf(env);
  const release = await env.hold();
  recordJob(env.rt, turn, { id: 'job1', state: 'running', command: 'sleep 60', label: 'Sleep' });
  settleJobs(env.rt, turn);
  await release();
  assert.deepEqual(env.store.state.sessions[env.se.id].jobs, [], 'the job went with its CLI');
  await env.close();
});

test('a job’s end reported while its start is held behind a commit ends it (#623, job-records recordJob)', async () => {
  const env = await heldRoom();
  const turn = turnOf(env);
  const release = await env.hold();
  recordJob(env.rt, turn, { id: 'job1', state: 'running', command: 'sleep 1', label: 'Sleep' });
  recordJob(env.rt, turn, { id: 'job1', state: 'done' });
  await release();
  assert.deepEqual(env.store.state.sessions[env.se.id].jobs, [], 'the job ended');
  await env.close();
});

test('a turn’s end reads the turns it keeps as a held commit left them, so their failed reply stays the need (#623, turn-finish endTurn)', async () => {
  const env = await heldRoom();
  const old = arrange.post(env.rt, env.t.id, {
    kind: 'agent',
    sessionId: env.se.id,
    handle: 'researcher',
    turnId: 'tu_old',
    text: '',
    status: 'failed',
    error: 'It failed.',
  });
  /** @type {(() => Promise<void>) | null} */
  let release = null;
  // The turn says something and ends on its own, with the kept turns written behind a held commit as it runs.
  arrange.adapter(env.rt, 'claude-code').deliver = async (/** @type {any} */ _s, /** @type {any} */ _m, /** @type {any} */ ctx) => {
    ctx.text('Done.');
    release = await env.hold();
    arrange.setSession(env.rt, env.se.id, { keptTurnIds: ['tu_old'] });
  };
  arrange.deliver(env.rt, env.se.id, { kind: 'agent', from: '@critic', text: 'Here are the numbers.' });
  await until(() => release !== null && !arrange.running(env.rt, env.se.id), 'the turn’s end');
  await /** @type {any} */ (release)();
  assert.equal(env.store.state.sessions[env.se.id].needs?.itemId, old.id, 'the kept turn’s failed reply is the need');
  await env.close();
});

test('a thread told while a commit is held isn’t told again in the next catch-up (#623, thread-catch-up threadLines)', async () => {
  const env = await heldRoom();
  const root = arrange.post(env.rt, env.t.id, { kind: 'user', text: 'The numbers.' });
  const topic = arrange.putThread(env.rt, {
    id: newId('th'),
    projectId: env.t.projectId,
    title: 'Numbers',
    kind: 'topic',
    parentId: env.t.id,
    rootItemId: root.id,
    members: [],
    lastSpeaker: null,
    hops: 0,
    queue: [],
    createdAt: Date.now(),
  });
  arrange.setItem(env.rt, env.t.id, root.id, { topicId: topic.id, replies: 1 });
  arrange.post(env.rt, topic.id, { kind: 'user', text: 'A closer look.' });
  const release = await env.hold();
  // The first catch-up tells it, its write held behind the commit; the second must see that.
  assert.equal(threadLines(env.rt.memory, env.se, 0).length, 1, 'the topic is new to the agent');
  const again = threadLines(env.rt.memory, env.se, 0);
  await release();
  assert.deepEqual(again, [], 'told once');
  await env.close();
});
