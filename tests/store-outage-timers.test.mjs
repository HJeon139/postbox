// Runtime timers and pollers while the store is closed (#508’s storage design, “When a write fails (ST-3)”; the 1b
// invariants, I1; the integrator’s review of #598): a timer whose callback writes or kills does nothing while writes are
// closed, and Retry re-arms every timer from the recovered state, so a deletion whose Undo window ended during the
// outage still purges, once, after writes reopen (the integrator’s repro, three kinds). A poller skips its tick while
// closed and consumes nothing: a mirrored terminal’s typed lines and a kept job’s end are recorded after Retry. A thread
// settled while closed makes no summarizer call. A real Postbox (start({ listen: false })) on a data folder.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { deletePersona, purgePersona } from '../server/persona-delete.mjs';
import { settleThread } from '../server/thread-summary.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4443;
const eio = () => Object.assign(new Error('disk sync refused'), { code: 'EIO' });
let app;
let dir;
let rt;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pb-outage-timers-'));
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: false, quiet: true, claudeHome: dir, listen: false, hosts: null });
  rt = app.rt;
  rt.store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  await rt.store.flush();
});
after(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
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
  const [se] = rt.sessionsIn(t.id);
  await rt.store.flush();
  return { p, t, se };
}

test('a deletion whose Undo window ends while the store is closed purges once after Retry, for a thread, a session and a persona (the integrator’s repro)', async () => {
  const thread = await room('tdel');
  const session = await room('sdel');
  const persona = await room('pdel');
  rt.deleteThread(thread.t.id);
  rt.deleteSession(session.se.id);
  deletePersona(rt, persona.p.id);
  // Their Undo windows end now (the stored time is what a re-arm reads), and the store fails before the purges fire.
  const over = Date.now() - 1;
  rt.putThread({ ...rt.s.threads[thread.t.id], deleting: over });
  rt.updateSession(session.se.id, { deleting: over });
  rt.store.emit('persona', { ...rt.s.personas[persona.p.id], deleting: over });
  await rt.store.flush();
  rt.store.fail(eio());
  // The windows end while writes are closed: each purge fires, and must do nothing it can’t save.
  rt.purgeThread(thread.t.id);
  rt.purgeSession(session.se.id);
  await purgePersona(rt, persona.p.id);
  assert.ok(rt.s.threads[thread.t.id], 'the thread is still in memory: nothing was erased unsaved');
  assert.ok(rt.s.sessions[session.se.id], 'the session too');
  assert.ok(rt.s.personas[persona.p.id] && !rt.s.personas[persona.p.id].purging, 'the persona too, not marked purging');
  await rt.store.reload();
  assert.equal(rt.store.writable, true);
  await until(() => !rt.s.threads[thread.t.id], 'the thread to be purged after Retry');
  await until(() => !rt.s.sessions[session.se.id], 'the session to be purged after Retry');
  await until(() => !rt.s.personas[persona.p.id], 'the persona to be purged after Retry');
  assert.ok(!rt.timers.has(`delt:${thread.t.id}`) && !rt.timers.has(`del:${session.se.id}`) && !rt.timers.has(`delp:${persona.p.id}`), 'no timer left');
  // Durable: the next load has none of them.
  await rt.store.flush();
  assert.ok(rt.store.state.seq <= rt.store.status.savedThrough, 'the purges are on disk');
});

test('a mirrored terminal’s poll is skipped while the store is closed, so what was typed is read, once, after Retry', async () => {
  const { t, se } = await room('mirror');
  rt.updateSession(se.id, { backendState: { ...(se.backendState ?? {}), attached: true, transcript: join(dir, 'transcript.jsonl') } });
  rt.mirror(se.id);
  await rt.store.flush();
  const m = rt.mirrors.get(se.id);
  assert.ok(m, 'the mirror is armed');
  let polls = 0;
  const typed = [{ type: 'user', message: { content: 'typed in the terminal' } }];
  m.tail = { poll: () => (++polls === 1 ? typed : []) };
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
  rt.updateSession(se.id, {
    jobs: [{ id: 'j1', sessionId: se.id, label: 'bg', command: 'sleep 9', kept: true, pgid: 99999, groups: [{ pgid: 99999, command: null }] }],
  });
  rt.listProcesses = async () => []; // its process group is gone
  await rt.store.flush();
  rt.store.fail(eio());
  await rt.pollKept();
  assert.equal(rt.s.sessions[se.id].jobs?.[0]?.kept, true, 'not ended while closed: the job is still listed as kept');
  await rt.store.reload();
  await rt.pollKept();
  assert.notEqual(rt.s.sessions[se.id].jobs?.[0]?.kept, true, 'ended after Retry');
  await rt.store.flush();
});

test('a thread settled while the store is closed makes no summarizer call; one settled after Retry does', async () => {
  const { t, se } = await room('topic');
  const root = rt.addItem(t.id, { kind: 'user', text: 'Root' });
  const { threadId: topicId } = rt.startTopic(t.id, root.id);
  rt.addItem(topicId, { kind: 'agent', text: 'Said in the topic', sessionId: se.id });
  let calls = 0;
  rt.summarize = async () => {
    calls++;
    return { text: 'Summary', costUsd: 0 };
  };
  rt.config.summaryDelayMs = 1;
  await rt.store.flush();
  rt.store.fail(eio());
  settleThread(rt, topicId);
  await sleep(40);
  assert.equal(calls, 0, 'no paid call whose summary would be lost');
  await rt.store.reload();
  settleThread(rt, topicId);
  await until(() => calls === 1, 'the summarizer after Retry');
  delete rt.summarize;
  await rt.store.flush();
});
