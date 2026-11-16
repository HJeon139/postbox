// What #1428’s review found in a turn given turn-input.mjs’s text (#1427), each asserted on the text the agent is given:
// a topic thread’s talk is lines of the tail, not one note its budget drops whole; an entry the budget held back isn’t
// also in the tail; each entry is read from its own thread; a failed reply’s mention says it failed; the person’s
// message that waited comes whole, once; and the threads the person links come with it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { READING } from '../shared/limits.mjs';
import * as arrange from './arrange.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

/** The text of each turn an agent was given, an input’s or any other message’s. */
const texts = (f, se) => f.adapter.calls.filter((c) => c.sessionId === se.id).map((c) => String(c.message.text ?? ''));
const say = (f, se, threadId, text) =>
  arrange.post(f.rt, threadId, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text, status: 'done' });

/** A room with a topic thread on alpha’s first reply, `root` long. */
async function roomAndTopic(root = 'The status note.') {
  const f = setup();
  f.adapter.next.push(async (ctx) => ctx.text(root));
  f.rt.sendMessage(f.t.id, { text: '@alpha write a status note' });
  await settle(f.rt);
  const reply = f.store.items(f.t.id).find((i) => i.kind === 'agent' && i.handle === 'alpha');
  return { ...f, topic: f.rt.startTopic(f.t.id, reply.id).threadId };
}

test('#1427 a topic thread’s talk is lines of the tail: past the tail’s size its newest are kept, not none', async () => {
  // The reviewer’s probe: a long message the thread is on, and nine long replies in it.
  const f = await roomAndTopic(`The status note. ${'ROOT '.repeat(300)}`);
  for (let i = 0; i < 9; i++) say(f, f.alpha, f.topic, `THREADTALK-${i} ${'x'.repeat(1900)}`);
  f.rt.sendMessage(f.topic, { text: '@beta summarize this thread' });
  await settle(f.rt);
  const given = texts(f, f.beta).at(-1);
  const seen = [...Array(9).keys()].filter((i) => given.includes(`THREADTALK-${i} `));
  assert.ok(seen.length >= 8, `${seen.length} of 9 kept`);
  assert.ok(seen.includes(8), 'the newest is kept');
});

test('#1427 an entry the turn’s budget held back isn’t also in its tail, and comes once, in the next turn', async () => {
  const f = setup();
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.sendMessage(f.t.id, { text: '@beta start' });
  await sleep(5);
  // Three mentions of beta, each past one entry’s ceiling, so two fill the turn’s budget and the third waits.
  for (const n of [1, 2, 3]) f.rt.agentWake(f.alpha.id, 'beta', `@beta part ${n}: MARK-${n} ${'y'.repeat(READING.mention)}`);
  busy.release();
  await settle(f.rt);
  const all = texts(f, f.beta).slice(1).join('\n');
  for (const n of [1, 2, 3]) assert.equal(all.split(`MARK-${n} `).length - 1, 1, `MARK-${n} given once`);
});

test('#1427 each entry is read from its own thread: a notice riding from another thread doesn’t move the turn there', async () => {
  const f = await roomAndTopic();
  f.rt.delivery.send({ sessionId: f.beta.id, threadId: f.topic, source: 'notice', text: 'A note from the topic.' }, { wake: false });
  f.rt.sendMessage(f.t.id, { text: '@beta read the totals' });
  await settle(f.rt);
  const given = texts(f, f.beta).at(-1);
  assert.match(given, /for you in this room\. Your reply posts there\./, 'the turn is where its message is');
  assert.match(given, /The person, \d\d:\d\d UTC: @beta read the totals/);
  assert.doesNotMatch(given, /deleted since it was sent/);
});

test('#1427 #485 a failed reply’s mention reaches its agent saying it failed and may be cut off', async () => {
  const f = setup();
  f.adapter.next.push(async (c) => {
    c.text('@beta the totals are in.');
    throw new Error('API 500');
  });
  f.rt.sendMessage(f.t.id, { text: '@alpha report' });
  await settle(f.rt);
  const given = texts(f, f.beta).at(-1);
  assert.match(given, /@alpha, \d\d:\d\d UTC: \(This reply failed before it finished: API 500\. It may be cut off\.\)\n\n@beta the totals are in\./);
});

test('#1427 the person’s message that waited for a busy agent comes whole, once, in its own turn', async () => {
  const f = setup();
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.sendMessage(f.t.id, { text: '@beta start' });
  await sleep(5);
  f.rt.sendMessage(f.t.id, { text: '@beta WAITED-ONCE then this' });
  busy.release();
  await settle(f.rt);
  const given = texts(f, f.beta);
  assert.equal(given.join('\n').split('WAITED-ONCE').length - 1, 1, 'once in all');
  assert.match(given.at(-1), /The person, \d\d:\d\d UTC: @beta WAITED-ONCE then this/);
});

test('#1427 #121 the threads the person’s message links to come with the input, with how to read each', async () => {
  const f = await roomAndTopic();
  f.rt.sendMessage(f.t.id, { text: `@beta read #/t/${f.t.id}/side/${f.topic}` });
  await settle(f.rt);
  const call = f.adapter.calls.filter((c) => c.sessionId === f.beta.id).at(-1);
  assert.equal(call.message.kind, 'input');
  assert.ok(
    (call.message.context ?? []).some((c) => c.includes(`(thread ${f.topic})`) && c.includes('read_conversation')),
    JSON.stringify(call.message.context),
  );
});

test('#1427 #121 in a batch of two messages, the thread the second links comes with the input', async () => {
  const f = await roomAndTopic();
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.sendMessage(f.t.id, { text: '@beta start' });
  await sleep(5);
  f.rt.sendMessage(f.t.id, { text: '@beta first, no link' });
  f.rt.sendMessage(f.t.id, { text: `@beta then read #/t/${f.t.id}/side/${f.topic}` });
  busy.release();
  await settle(f.rt);
  const call = f.adapter.calls.filter((c) => c.sessionId === f.beta.id).at(-1);
  assert.equal(call.message.kind, 'input');
  assert.match(call.message.text, /first, no link[\s\S]*then read/, 'one turn, both messages');
  assert.ok(
    (call.message.context ?? []).some((c) => c.includes(`(thread ${f.topic})`) && c.includes('read_conversation')),
    JSON.stringify(call.message.context),
  );
});
