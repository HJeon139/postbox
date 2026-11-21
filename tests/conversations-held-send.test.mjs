// #1292: a conversation started while a commit is held exists only in the store’s pending state until the commit
// lands. POST /api/threads answers with it at once (#1280), so the page can send the first message, or open a topic on
// it, before then. sendMessage and startTopic found the thread through rt.thread, the published state, and refused
// both with “That thread doesn’t exist”. Each now reads the thread it writes to as written (Threads.toWrite), and so do
// the other first lines a new conversation takes: an agent’s /command and a `!` command.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { heldStore, setup } from './stop-reply-fixture.mjs';

/** A runtime on a store whose next commit is held, with fn run, and awaited, while it is (conversations-held.test.mjs). */
async function whileHeld(fn) {
  const h = await heldStore();
  const env = await setup(async () => {}, h.store);
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  let result;
  try {
    result = await fn(env);
  } finally {
    h.release();
    await commit;
    await h.store.flush();
  }
  return { env, result, store: h.store };
}

test('#1292: the first message in a conversation started while a commit is held is sent, not refused', async () => {
  const { result, store } = await whileHeld(({ rt }) => {
    const p = arrange.persona(rt, 'researcher');
    const t = rt.createThread({ projectId: 'p1', title: 'Held room', personaIds: [p.id] });
    return { t, sent: rt.sendMessage(t.id, { text: '@researcher check the table' }) };
  });
  assert.ok(result.sent, 'sendMessage answered');
  assert.ok(
    store.items(result.t.id).some((i) => i.kind === 'user' && i.text === '@researcher check the table'),
    'and the message was written',
  );
  const se = Object.values(store.state.sessions).find((x) => x.threadId === result.t.id && x.handle === 'researcher');
  assert.ok(
    (store.state.inbox[se.id] ?? []).some((e) => e.source === 'person'),
    'and researcher got it',
  );
  await store.close();
});

test('#1292: a topic opens on a message in a conversation started while a commit is held', async () => {
  const { result, store } = await whileHeld(({ rt }) => {
    const p = arrange.persona(rt, 'researcher');
    const t = rt.createThread({ projectId: 'p1', title: 'Held room', personaIds: [p.id] });
    const item = rt.threads.addItem(t.id, { kind: 'user', text: 'The table', status: 'done' });
    return { t, topic: rt.startTopic(t.id, item.id) };
  });
  assert.equal(result.topic.created, true);
  assert.equal(store.state.threads[result.topic.threadId]?.parentId, result.t.id, 'the topic was written');
  await store.close();
});

test('#1292: an agent’s /command as the first line of a conversation started while a commit is held runs', async () => {
  const { result, store } = await whileHeld(({ rt }) => {
    const p = arrange.persona(rt, 'researcher');
    const t = rt.createThread({ projectId: 'p1', title: 'Held room', personaIds: [p.id] });
    const se = Object.values(rt.store.pending.sessions()).find((x) => x.threadId === t.id);
    return { t, ran: rt.runAgentCommand(t.id, { sessionId: se.id, text: '/review' }) };
  });
  assert.ok(result.ran);
  assert.ok(
    store.items(result.t.id).some((i) => i.text === '/review'),
    'the command was posted',
  );
  await store.close();
});

test('#1292: a `!` command as the first line of a conversation started while a commit is held runs', async () => {
  const { result, store } = await whileHeld(async ({ rt }) => {
    rt.work.spawnShell = () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 1 });
    // The agent works in a folder of its own, so the command runs where it works only if its session is found.
    rt.adapters.get('claude-code').folderFor = async () => '/work/space/researcher';
    const p = arrange.persona(rt, 'researcher');
    const t = rt.createThread({ projectId: 'p1', title: 'Held room', personaIds: [p.id] });
    await rt.runShellCommand(t.id, 'pwd');
    return { t };
  });
  const command = store.items(result.t.id).find((i) => i.kind === 'command');
  assert.ok(command, 'the command item was written');
  assert.equal(command.cwd, '/work/space/researcher', 'where the conversation’s agent works');
  await store.close();
});
