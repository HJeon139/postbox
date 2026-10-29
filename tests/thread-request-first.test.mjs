// #504: a direct request in a topic thread leads the prompt; the room backlog is background after it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatMessage } from '../server/adapters/guide.mjs';
import { THREAD_CHECKS } from '../server/room-checks-threads.mjs';
import { held, settle, setup } from './side-threads-fixture.mjs';

/** A room with a topic on alpha’s first reply, while beta has not taken a turn. */
async function roomAndTopic() {
  const f = setup();
  f.adapter.next.push(async (ctx) => ctx.text('We tested the demo app end to end. It works well.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha write a status note' });
  await settle(f.rt);
  const reply = f.store.items(f.t.id).find((item) => item.kind === 'agent' && item.handle === 'alpha');
  const topic = f.store.state.threads[f.rt.startTopic(f.t.id, reply.id).threadId];
  return { ...f, topic };
}

test('#504 a topic turn leads with its request and labels the room backlog as background', async () => {
  const f = await roomAndTopic();
  const backlog = `@beta review the parser changes. ${'Detailed room context. '.repeat(260)}`;
  f.rt.addItem(f.t.id, {
    kind: 'agent',
    sessionId: f.alpha.id,
    personaId: f.alpha.personaId,
    handle: f.alpha.handle,
    text: backlog,
    status: 'done',
  });
  const request = '@beta please check only the English grammar of this note, nothing else.';
  f.rt.sendMessage(f.topic.id, { text: request });
  await settle(f.rt);

  const call = f.adapter.calls.at(-1);
  const prompt = formatMessage(call.message);
  const taskAt = prompt.indexOf(request);
  const roomAt = prompt.indexOf('@beta review the parser changes.');
  assert.equal(call.thread, f.topic.id);
  assert.match(prompt, new RegExp(`^\\[Postbox\\] You’re answering in the thread .*thread ${f.topic.id}`));
  assert.match(prompt.slice(0, roomAt), /Your task in this topic or side thread/);
  assert.ok(taskAt >= 0 && roomAt > taskAt, 'the thread request leads the room backlog');
  assert.match(prompt.slice(taskAt, roomAt), /Meanwhile in the room.*background.*answer room work in the room/s);
  assert.equal(prompt.split(request).length - 1, 1, 'the request appears once');
  assert.equal(f.store.items(f.topic.id).findLast((item) => item.kind === 'agent')?.promptFirst, 'thread-task');
});

test('#504 a follow-up in the same topic thread still leads with its new request', async () => {
  const f = await roomAndTopic();
  f.rt.sendMessage(f.topic.id, { text: '@beta check the first sentence.' });
  await settle(f.rt);
  f.rt.addItem(f.t.id, {
    kind: 'agent',
    sessionId: f.alpha.id,
    personaId: f.alpha.personaId,
    handle: f.alpha.handle,
    text: `@beta review the second parser revision. ${'Room work remains background. '.repeat(220)}`,
    status: 'done',
  });
  const request = '@beta now check the second sentence only.';
  f.rt.sendMessage(f.topic.id, { text: request });
  await settle(f.rt);

  const call = f.adapter.calls.at(-1);
  const prompt = formatMessage(call.message);
  assert.equal(call.thread, f.topic.id);
  assert.match(call.message.taskContext, new RegExp(`^\\[Postbox\\] You’re answering in the thread .*thread ${f.topic.id}`));
  assert.equal(f.store.items(f.topic.id).findLast((item) => item.kind === 'agent')?.promptFirst, 'thread-task');
  assert.ok(prompt.indexOf(request) < prompt.indexOf('@beta review the second parser revision.'), 'the follow-up leads the new room work');
  assert.match(prompt, /Meanwhile in the room.*background.*answer room work in the room/s);
});

test('#504 a thread request stays whole even when the room summary already gave its source message', async () => {
  const f = await roomAndTopic();
  const sent = f.rt.addItem(f.t.id, {
    kind: 'agent',
    sessionId: f.alpha.id,
    personaId: f.alpha.personaId,
    handle: f.alpha.handle,
    text: '@beta inspect this exact request in the topic.',
    status: 'done',
  });
  f.rt.updateSession(f.beta.id, { seenItem: sent.id, givenMentions: [sent.id] });
  f.rt.deliver(f.beta.id, { kind: 'agent', from: '@alpha', text: sent.text, itemId: sent.id }, { threadId: f.topic.id });
  await settle(f.rt);

  const call = f.adapter.calls.at(-1);
  assert.equal(call.message.text, sent.text);
  assert.doesNotMatch(call.message.text, /message above|read_message/);
  assert.equal(f.store.items(f.topic.id).findLast((item) => item.kind === 'agent')?.promptFirst, 'thread-task');
});

test('#504 slash commands, host reattachments and Postbox notices in a topic are not mislabeled as direct tasks', async () => {
  const f = await roomAndTopic();
  for (const [message, first] of [
    [{ kind: 'user', text: '/compact', slash: true }, 'slash'],
    [{ kind: 'user', text: '', attach: 'host-turn-1' }, 'attach'],
    [{ kind: 'notice', text: 'The prior check finished.' }, 'system'],
  ]) {
    f.rt.deliver(f.beta.id, message, { threadId: f.topic.id });
    await settle(f.rt);
    const item = f.store.items(f.topic.id).findLast((entry) => entry.kind === 'agent');
    assert.equal(item.promptFirst, first);
    assert.equal(f.adapter.calls.at(-1).message.taskContext, undefined);
  }
});

test('#504 failed and stopped topic turns without text keep their prompt marker', async () => {
  const failed = await roomAndTopic();
  failed.adapter.next.push(async () => {
    throw new Error('Backend failed.');
  });
  failed.rt.sendMessage(failed.topic.id, { text: '@beta check this sentence.' });
  await settle(failed.rt);
  assert.equal(failed.store.items(failed.topic.id).findLast((item) => item.kind === 'agent')?.promptFirst, 'thread-task');
  assert.deepEqual(THREAD_CHECKS[0].run({ state: failed.store.state, threads: [failed.t.id, failed.topic.id] }), []);

  const stopped = await roomAndTopic();
  const waiting = held();
  stopped.adapter.next.push(waiting.step);
  stopped.rt.sendMessage(stopped.topic.id, { text: '@beta check another sentence.' });
  for (let i = 0; i < 20 && !stopped.rt.turns.has(stopped.beta.id); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped.rt.stop(stopped.beta.id), true);
  waiting.release();
  await settle(stopped.rt);
  assert.equal(stopped.store.items(stopped.topic.id).findLast((item) => item.kind === 'agent')?.promptFirst, 'thread-task');
  assert.deepEqual(THREAD_CHECKS[0].run({ state: stopped.store.state, threads: [stopped.t.id, stopped.topic.id] }), []);
});

test('#504 #508 a turn in the room leads with its request, its catch-up labeled as background after it', async () => {
  const f = setup();
  f.rt.addItem(f.t.id, { kind: 'user', text: 'Earlier room context.' });
  f.rt.sendMessage(f.t.id, { text: '@beta answer in the room.' });
  await settle(f.rt);

  const call = f.adapter.calls.at(-1);
  assert.equal(call.thread, f.t.id);
  assert.equal(call.message.taskContext, undefined);
  // #508 (DL-4) puts the request first in a room turn too; the catch-up follows as background.
  const prompt = formatMessage(call.message);
  assert.match(prompt, /^@beta answer in the room\.\n\n\[Postbox\] Background for this turn:/);
  assert.ok(prompt.indexOf('[Postbox] What happened in this room since your last turn:') > prompt.indexOf('[Postbox] Background for this turn:'));
  assert.equal(f.store.items(f.t.id).findLast((item) => item.kind === 'agent')?.promptFirst, 'room');
});
