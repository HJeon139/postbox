// #1292: a conversation started while a commit is held exists only in the store’s pending state until the commit
// lands. POST /api/threads answers with it at once (#1280), so the page can send the first message, or open a topic on
// it, before then. sendMessage and startTopic found the thread through rt.thread, the published state, and refused
// both with “That thread doesn’t exist”. Each now reads the thread it writes to as written (Threads.toWrite), and so do
// the other first lines a new conversation takes: an agent’s /command and a `!` command.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createPersonaFor } from '../server/persona-create.mjs';
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
    const q = rt.createPersona({ handle: 'critic', backend: 'claude-code' });
    const t = rt.createThread({ projectId: 'p1', title: 'Held room', personaIds: [p.id, q.id] });
    const se = Object.values(rt.store.pending.sessions()).find((x) => x.threadId === t.id && x.handle === 'researcher');
    return { t, ran: rt.runAgentCommand(t.id, { sessionId: se.id, text: '/review' }) };
  });
  assert.ok(result.ran);
  assert.ok(
    store.items(result.t.id).some((i) => i.text === '/review'),
    'the command was posted',
  );
  // In a room, it says whom it woke.
  assert.ok(store.items(result.t.id).some((i) => i.kind === 'system' && i.variant === 'wake' && i.to === 'researcher'));
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

test('#1292: a first message with no @-mention goes to the conversation’s agent', async () => {
  // Pre-review: the usual first line in a conversation started with an agent names no one.
  const { result, store } = await whileHeld(({ rt }) => {
    const p = arrange.persona(rt, 'researcher');
    const t = rt.createThread({ projectId: 'p1', title: 'Held room', personaIds: [p.id] });
    return { t, sent: rt.sendMessage(t.id, { text: 'check the table' }) };
  });
  const se = Object.values(store.state.sessions).find((x) => x.threadId === result.t.id && x.handle === 'researcher');
  assert.ok((store.state.inbox[se.id] ?? []).some((e) => e.source === 'person'));
  await store.close();
});

test('#1292: the page’s retry of a first message is answered with what the first try posted, not posted again', async () => {
  const { result, store } = await whileHeld(({ rt }) => {
    const p = arrange.persona(rt, 'researcher');
    const t = rt.createThread({ projectId: 'p1', title: 'Held room', personaIds: [p.id] });
    rt.sendMessage(t.id, { text: '@researcher check the table', clientId: 'c1' });
    rt.sendMessage(t.id, { text: '@researcher check the table', clientId: 'c1' });
    return { t };
  });
  assert.equal(store.items(result.t.id).filter((i) => i.kind === 'user').length, 1);
  await store.close();
});

test('#1292: a topic opened in a held conversation is answered by its agent, with or without an @-mention', async () => {
  const { result, store } = await whileHeld(({ rt }) => {
    const p = arrange.persona(rt, 'researcher');
    const t = rt.createThread({ projectId: 'p1', title: 'Held room', personaIds: [p.id] });
    const item = rt.threads.addItem(t.id, { kind: 'user', text: 'The table', status: 'done' });
    const topic = rt.startTopic(t.id, item.id);
    rt.sendMessage(topic.threadId, { text: 'is row 3 right?' });
    rt.sendMessage(topic.threadId, { text: '@researcher and row 4?' });
    return { t, topic };
  });
  assert.equal(store.state.threads[result.topic.threadId].woke, 'researcher', 'who answers in it');
  const se = Object.values(store.state.sessions).find((x) => x.threadId === result.t.id && x.handle === 'researcher');
  assert.equal((store.state.inbox[se.id] ?? []).filter((e) => e.source === 'person').length, 2, 'both reached it');
  await store.close();
});

test('#1292: a topic opened on an agent’s message in a held room is answered by that agent', async () => {
  const { result, store } = await whileHeld(({ rt }) => {
    const p = arrange.persona(rt, 'researcher');
    const q = rt.createPersona({ handle: 'critic', backend: 'claude-code' });
    const t = rt.createThread({ projectId: 'p1', title: 'Held room', personaIds: [p.id, q.id] });
    const critic = Object.values(rt.store.pending.sessions()).find((x) => x.threadId === t.id && x.handle === 'critic');
    const item = rt.threads.addItem(t.id, { kind: 'agent', sessionId: critic.id, handle: 'critic', text: 'Row 3 is wrong.', status: 'done' });
    return { topic: rt.startTopic(t.id, item.id) };
  });
  assert.equal(store.state.threads[result.topic.threadId].woke, 'critic');
  await store.close();
});

test('#1292: a new agent added to a conversation started while a commit is held joins it', async () => {
  // Second pre-review: POST /api/personas with join found the conversation through the published state, and refused.
  const { result, store } = await whileHeld(({ rt }) => {
    const t = rt.createThread({ projectId: 'p1', title: 'Held room' });
    try {
      return { t, p: createPersonaFor(rt, rt.store, { handle: 'helper', backend: 'claude-code', join: { threadId: t.id } }) };
    } catch (e) {
      return { t, e };
    }
  });
  assert.equal(result.e, undefined, result.e?.message);
  assert.ok(Object.values(store.state.sessions).some((x) => x.threadId === result.t.id && x.handle === 'helper'));
  await store.close();
});

test('#1292: a `!` command runs where an agent made behind the same held commit works, in its project as changed', async () => {
  // Critic’s review of PR #1569: the session was read as written, but its persona and project weren’t, so the first
  // command of a conversation and agent made behind one held commit, in a project changed then, ran in the project’s
  // own folder.
  const { result, store } = await whileHeld(async ({ rt }) => {
    rt.work.spawnShell = () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 1 });
    rt.adapters.get('claude-code').folderFor = async (persona, project) => `/work/space/${persona?.handle}/${project?.name}`;
    rt.store.emit('project', { ...rt.store.state.projects.p1, name: 'Renamed' });
    assert.equal(rt.store.state.projects.p1.name, 'P', 'the rename is held, not yet published');
    const p = rt.createPersona({ handle: 'helper', backend: 'claude-code' });
    const t = rt.createThread({ projectId: 'p1', title: 'Held room', personaIds: [p.id] });
    await rt.runShellCommand(t.id, 'pwd');
    return { t };
  });
  const command = store.items(result.t.id).find((i) => i.kind === 'command');
  assert.equal(command?.cwd, '/work/space/helper/Renamed');
  await store.close();
});
