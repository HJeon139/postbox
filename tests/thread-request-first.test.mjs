// #504: a direct request in a topic thread leads the prompt; the room backlog is background after it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatMessage } from '../server/adapters/guide.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

const events = (store, type) => store.events.map((event) => JSON.parse(event.line)).filter((event) => event.type === type);

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
  assert.deepEqual(events(f.store, 'turn.context').at(-1)?.data, {
    turnId: f.store.items(f.topic.id).find((item) => item.kind === 'agent')?.turnId,
    sessionId: f.beta.id,
    threadId: f.topic.id,
    first: 'thread-task',
  });
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
  assert.ok(prompt.indexOf(request) < prompt.indexOf('@beta review the second parser revision.'), 'the follow-up leads the new room work');
  assert.match(prompt, /Meanwhile in the room.*background.*answer room work in the room/s);
});

test('#504 a turn in the room keeps the existing context order', async () => {
  const f = setup();
  f.rt.addItem(f.t.id, { kind: 'user', text: 'Earlier room context.' });
  f.rt.sendMessage(f.t.id, { text: '@beta answer in the room.' });
  await settle(f.rt);

  const call = f.adapter.calls.at(-1);
  assert.equal(call.thread, f.t.id);
  assert.equal(call.message.taskContext, undefined);
  assert.match(formatMessage(call.message), /^\[Postbox\] What happened in this room since your last turn:/);
  assert.equal(events(f.store, 'turn.context').length, 0);
});
