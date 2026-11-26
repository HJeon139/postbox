// Reads of a session that decide a write read it as written (#623): a session field written while a commit is held is
// pending, not published, so a reader of the published session misses it, and the write it decides undoes or repeats
// what the held write did. Each test writes the field behind a held commit, then makes the write that reads it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { offerNeed, releaseNeed } from '../server/card-needs.mjs';
import { recordJob, runningJobs, settleJobs } from '../server/job-records.mjs';
import { newId } from '../server/store.mjs';
import { endSubagent } from '../server/subagent-end.mjs';
import { threadLines } from '../server/thread-catch-up.mjs';
import { heldBy } from '../server/turn-held.mjs';
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

const DIAGRAM = '```mermaid\ngraph LR\nA-->B\n```';
/** The browser’s report of a diagram drawn too small to read. */
const TOO_SMALL = { src: 'graph LR\nA-->B', textPx: 7, width: 728 };

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

test('a job kept while a commit is held isn’t ended at its turn’s end (#623, job-records settleJobs)', async () => {
  const env = await heldRoom();
  const turn = turnOf(env);
  recordJob(env.rt, turn, { id: 'job1', state: 'running', command: 'sleep 60', label: 'Sleep' });
  await env.store.flush();
  const job = env.store.state.sessions[env.se.id].jobs[0];
  const release = await env.hold();
  // Stop’s Keep running marks it kept, held behind the commit; its CLI then goes and the turn ends.
  arrange.setSession(env.rt, env.se.id, { jobs: [{ ...job, kept: true }] });
  settleJobs(env.rt, turn);
  await release();
  assert.deepEqual(
    env.store.state.sessions[env.se.id].jobs.map((/** @type {any} */ j) => [j.id, j.kept]),
    [['job1', true]],
    'the kept job runs on',
  );
  await env.close();
});

test('a subagent ended twice while a commit is held is ended once, with one notice (#623, subagent-end endSubagent)', async () => {
  const env = await heldRoom(async (/** @type {any} */ c) => {
    c.status({ state: 'tool', subagents: [{ id: 'toolu_reader', name: 'general-purpose', state: 'tool', asked: 'Count the words' }] });
  });
  arrange.deliver(env.rt, env.se.id, { kind: 'user', text: 'Count them, with a subagent.' });
  await until(() => (arrange.liveSession(env.rt, env.se.id)?.subagents ?? []).length > 0, 'the subagent at work');
  const release = await env.hold();
  // The person presses End, then again before the first press is written.
  endSubagent(env.rt, env.se.id, 'toolu_reader');
  endSubagent(env.rt, env.se.id, 'toolu_reader');
  await release();
  const se = env.store.state.sessions[env.se.id];
  assert.deepEqual(se.endingSubagents, ['toolu_reader'], 'ending once');
  assert.equal((se.context ?? []).filter((/** @type {string} */ x) => x.includes('toolu_reader')).length, 1, 'one notice');
  arrange.abortTurn(env.rt, env.se.id);
  await until(() => !arrange.running(env.rt, env.se.id), 'the turn’s end');
  await env.close();
});

test('a diagram reported while its first report is held behind a commit isn’t reported again (#623, diagram-check diagramCheck)', async () => {
  const env = await heldRoom();
  const turnId = newId('tu');
  const reply = arrange.post(env.rt, env.t.id, { kind: 'agent', sessionId: env.se.id, handle: 'researcher', turnId, text: DIAGRAM });
  // The turn has ended, and its lint turn waits to settle, as the browser’s reports reach it.
  arrange.armLint(env.rt, turnId, { sessionId: env.se.id, kind: null, ended: false, sent: false, problems: [], timer: null, threadId: env.t.id });
  await env.store.flush();
  const release = await env.hold();
  const first = env.rt.diagramCheck(env.t.id, reply.id, TOO_SMALL).sent;
  const again = env.rt.diagramCheck(env.t.id, reply.id, TOO_SMALL).sent;
  await release();
  assert.equal(first, true, 'the first report reaches the agent');
  assert.equal(again, false, 'the same diagram isn’t reported twice');
  await env.close();
});

test('a job recorded while a commit is held is one Stop asks about, and one a failed turn says it held (#623, runningJobs, heldBy)', async () => {
  const env = await heldRoom();
  const turn = turnOf(env);
  const release = await env.hold();
  recordJob(env.rt, turn, { id: 'job1', state: 'running', command: 'sleep 60', label: 'Sleep' });
  const running = runningJobs(env.rt, env.se.id, turn.id).map((/** @type {any} */ j) => j.id);
  const held = heldBy(env.rt, env.se, turn).stopped;
  await release();
  assert.deepEqual(running, ['job1'], 'Stop asks about the held job');
  assert.deepEqual(held, ['Sleep'], 'the failed reply names it');
  await env.close();
});

test('a job kept while a commit is held is one the kept-jobs poll watches (#623, kept-jobs keptJobs)', async () => {
  const env = await heldRoom();
  const turn = turnOf(env);
  recordJob(env.rt, turn, { id: 'job1', state: 'running', command: 'sleep 60', label: 'Sleep' });
  await env.store.flush();
  const job = env.store.state.sessions[env.se.id].jobs[0];
  const release = await env.hold();
  arrange.setSession(env.rt, env.se.id, { jobs: [{ ...job, kept: true, pgid: 4242, groups: [{ pgid: 4242 }] }] });
  const kept = env.rt.keptJobs().map((/** @type {any} */ j) => j.id);
  await release();
  assert.deepEqual(kept, ['job1'], 'the held kept job is watched');
  await env.close();
});
