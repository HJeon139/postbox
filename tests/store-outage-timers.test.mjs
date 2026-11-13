// Runtime timers and pollers while the store is closed (#508’s storage design, “When a write fails (ST-3)”; the 1b
// invariants, I1; the integrator’s review of #598): a timer whose callback writes or kills does nothing while writes are
// closed, and Retry re-arms every timer from the recovered state. A poller skips its tick while
// closed and consumes nothing: a mirrored terminal’s typed lines and a kept job’s end are recorded after Retry. A thread
// settled while closed makes no summarizer call. A real Postbox (start({ listen: false })) on a data folder.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { settleThread } from '../server/thread-summary.mjs';
import * as arrange from './arrange.mjs';
import { eio } from './outage-log.mjs';
import { assertNoServerFailures, captureServerLog } from './server-log.mjs';
import { tempDir } from './temp-dirs.mjs';

// Its Postbox runs in this process: a test fails on an error or a warning it logs (tests/server-log.mjs).
captureServerLog();
afterEach(assertNoServerFailures);

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise((r) => {
    resolve = () => r(undefined);
  });
  return { promise, resolve };
};

const PORT = 4443;
let app;
let dir;
let rt;
before(async () => {
  dir = tempDir('pb-outage-timers-');
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: false, quiet: true, claudeHome: dir, listen: false, hosts: null });
  rt = app.rt;
  rt.store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  await rt.store.flush();
});
after(async () => {
  await app.close();
});

// A spec that fails may leave writes closed: the next one starts open, so each fails for its own reason.
beforeEach(async () => {
  if (!rt.store.writable) await rt.store.reload();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Waits for a condition, up to 5 s. @param {() => boolean} pred @param {string} what */
const until = async (pred, what) => {
  for (let i = 0; i < 200 && !pred(); i++) await sleep(25);
  assert.ok(pred(), `waited for ${what}`);
};
/** A room with one agent, durable. */
async function room(handle) {
  const p = rt.createPersona({ handle });
  const t = rt.createThread({ projectId: 'p1', title: `T ${handle}`, personaIds: [p.id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  await rt.store.flush();
  return { p, t, se };
}

test('a mirrored terminal’s poll is skipped while the store is closed, so what was typed is read, once, after Retry', async () => {
  const { t, se } = await room('mirror');
  arrange.setSession(rt, se.id, { backendState: { ...(se.backendState ?? {}), attached: true, transcript: join(dir, 'transcript.jsonl') } });
  rt.mirror(se.id);
  await rt.store.flush();
  assert.ok(arrange.mirrored(rt, se.id), 'the mirror is armed');
  let polls = 0;
  const typed = [{ type: 'user', message: { content: 'typed in the terminal' } }];
  arrange.withMirrorTail(rt, se.id, { poll: () => (++polls === 1 ? typed : []) });
  rt.store.fail(eio());
  rt.pollMirror(se.id);
  assert.equal(polls, 0, 'the tail is not advanced while closed: the line waits in the file');
  assert.equal(rt.store.items(t.id).filter((i) => i.via === 'terminal').length, 0);
  await rt.store.reload();
  rt.pollMirror(se.id);
  assert.equal(polls, 1);
  const lines = rt.store.items(t.id).filter((i) => i.via === 'terminal');
  assert.deepEqual(
    lines.map((i) => i.text),
    ['typed in the terminal'],
    'read once, into the recovered state',
  );
  await rt.store.flush();
  rt.stopMirrors();
});

test('a kept job that ends while the store is closed is recorded ended after Retry, not into memory only', async () => {
  const { se } = await room('kept');
  arrange.setSession(rt, se.id, {
    jobs: [{ id: 'j1', sessionId: se.id, label: 'bg', command: 'sleep 9', kept: true, pgid: 99999, groups: [{ pgid: 99999, command: null }] }],
  });
  arrange.withProcesses(rt, { list: async () => [] }); // its process group is gone
  await rt.store.flush();
  rt.store.fail(eio());
  await rt.pollKept();
  assert.equal(rt.session(se.id).jobs?.[0]?.kept, true, 'not ended while closed: the job is still listed as kept');
  await rt.store.reload();
  await rt.pollKept();
  assert.notEqual(rt.session(se.id).jobs?.[0]?.kept, true, 'ended after Retry');
  await rt.store.flush();
});

test('a kept job’s Stop while the store is closed records it ended after Retry, and the job sharing its groups too, not into memory only (the integrator’s nit)', async () => {
  const { se } = await room('keptstop');
  const groups = [{ pgid: 99997, command: null }];
  arrange.setSession(rt, se.id, {
    jobs: ['j3', 'j4'].map((id) => ({ id, sessionId: se.id, label: id, command: 'sleep 9', kept: true, pgid: 99997, groups, startedAt: Date.now() })),
  });
  const putBack = arrange.withProcesses(rt, { list: async () => [{ pid: 99996, ppid: 1, pgid: 99997, command: 'sleep 9' }] }); // a member, its leader gone: the group is still the jobs’
  arrange.withProcesses(rt, { signal: () => {} });
  await rt.store.flush();
  rt.store.fail(eio());
  await rt.stopJob(se.id, 'j3'); // Stop is allowed while closed; its records wait
  await rt.store.reload();
  putBack();
  assert.deepEqual(rt.session(se.id).jobs ?? [], [], 'both jobs recorded ended once writes reopened, not lost with memory');
  await rt.store.flush();
});

test('a thread settled while the store is closed makes no summarizer call; one settled after Retry does', async () => {
  const { t, se } = await room('topic');
  const root = arrange.post(rt, t.id, { kind: 'user', text: 'Root' });
  const { threadId: topicId } = rt.startTopic(t.id, root.id);
  arrange.post(rt, topicId, { kind: 'agent', text: 'Said in the topic', sessionId: se.id });
  let calls = 0;
  arrange.withSummarizer(rt, async () => {
    calls++;
    return { text: 'Summary', costUsd: 0 };
  });
  arrange.withDelays(rt, { summaryDelayMs: 1 });
  await rt.store.flush();
  rt.store.fail(eio());
  settleThread(rt, topicId);
  await sleep(40);
  assert.equal(calls, 0, 'no paid call whose summary would be lost');
  await rt.store.reload();
  settleThread(rt, topicId);
  await until(() => calls === 1, 'the summarizer after Retry');
  arrange.withSummarizer(rt, undefined);
  await rt.store.flush();
});

test('a callback held across an outage and Retry applies nothing to the old history: the kept-job poll and the summarizer', async () => {
  const { t, se } = await room('held');
  // The kept-job poll, held in its process listing.
  arrange.setSession(rt, se.id, {
    jobs: [{ id: 'j2', sessionId: se.id, label: 'bg', command: 'sleep 9', kept: true, pgid: 99998, groups: [{ pgid: 99998, command: null }] }],
  });
  const listing = deferred();
  arrange.withProcesses(rt, {
    list: async () => {
      await listing.promise;
      return [];
    },
  });
  // The summarizer, held in its call.
  const root = arrange.post(rt, t.id, { kind: 'user', text: 'Root 2' });
  const { threadId: topicId } = rt.startTopic(t.id, root.id);
  arrange.post(rt, topicId, { kind: 'agent', text: 'Said', sessionId: se.id });
  const call = deferred();
  arrange.withSummarizer(rt, async () => {
    await call.promise;
    return { text: 'Late summary', costUsd: 0 };
  });
  arrange.withDelays(rt, { summaryDelayMs: 1 });
  const poll = rt.pollKept();
  settleThread(rt, topicId);
  await sleep(20); // each is now past its entry check, awaiting
  const epoch = rt.store.epoch;
  rt.store.fail(eio());
  await rt.store.reload();
  assert.notEqual(rt.store.epoch, epoch, 'another history');
  listing.resolve();
  call.resolve();
  await poll;
  await sleep(30);
  assert.equal(rt.session(se.id).jobs?.[0]?.kept, true, 'the held poll ended nothing against the new history');
  assert.equal(rt.store.items(t.id).find((i) => i.id === root.id)?.threadSummary, undefined, 'the held summary was not written');
  await rt.pollKept();
  assert.notEqual(rt.session(se.id).jobs?.[0]?.kept, true, 'the next tick ends the job');
  arrange.withSummarizer(rt, undefined);
  await rt.store.flush();
});

test('a scheduled wake that fires while the store is closed is delivered exactly once after Retry, even when its turn outlasts the reload (the integrator’s double-wake)', async () => {
  const calls = [];
  arrange.withAdapter(rt, {
    name: 'slow-wake',
    async deliver(_se, message, ctx) {
      calls.push(message);
      await new Promise((r) => {
        const t = setTimeout(r, 600); // the turn outlasts the reload
        ctx.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            r(undefined);
          },
          { once: true },
        );
      });
    },
  });
  const p = rt.createPersona({ handle: 'waketwice', backend: 'slow-wake' });
  const t = rt.createThread({ projectId: 'p1', title: 'Wake twice', personaIds: [p.id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  await rt.store.flush();
  const sc = arrange.schedule(rt, se.id, { inMs: 30, note: 'once' });
  await rt.store.flush();
  rt.store.fail(eio());
  await sleep(1300); // a wake waits at least 1 s: the timer fires while closed
  assert.equal(calls.length, 0, 'nothing delivered while closed');
  await rt.store.reload();
  await until(() => calls.length >= 1, 'the wake after Retry');
  await until(() => !arrange.running(rt, se.id) && !arrange.exiting(rt, se.id), 'its turn and anything held behind it to end');
  await sleep(100);
  assert.equal(calls.filter((m) => m.scheduledWakeId === sc.id).length, 1, `one delivery for one wake, not ${calls.length}`);
  await rt.store.flush();
});
