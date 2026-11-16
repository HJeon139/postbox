// #506: a message a turn's summary gives in full reaches the agent once. A combined batch (the person's queued message
// and an agent's wake, delivered as one) left every message but the last in the turn's summary too, so the agent read
// it twice in one prompt; and the person's message, already posted and waiting behind a turn in another thread, came in
// full after that turn's summary gave it, since the pointer #484 made was only for an agent's mention. Since #1404 the
// person's message is posted when it's sent, and one still waiting for the agent stays out of a summary: it comes once,
// whole, in its own turn.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { READING } from '../shared/limits.mjs';
import * as arrange from './arrange.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

// Longer than the pointer's quote of a message's start (pointerIfSeen), so a repeat in full can be told from it.
const MINE = `@alpha please recount the totals in the tally. ${'Each column needs its own check. '.repeat(8)}`;
const THEIRS = `@alpha the review of the totals is done: two fixes needed. ${'Details follow on each fix. '.repeat(8)}`;

/** How many times `text` reached alpha in one call: its message (a batch's is its messages' joined), a thread's task context and its context. */
const copies = (call, text) =>
  [call.message.text, call.message.taskContext, ...(call.message.context ?? [])].filter((s) => String(s ?? '').includes(text)).length;
const toAlpha = (f) => f.adapter.calls.filter((c) => c.handle === 'alpha');

/** @alpha busy in a turn that waits until the returned release(). */
async function busyAlpha(f) {
  const b = held();
  f.adapter.next.push(b.step);
  f.rt.sendMessage(f.t.id, { text: '@alpha Check the build.' });
  for (let i = 0; i < 200 && !f.adapter.calls.length; i++) await sleep(5);
  assert.equal(f.rt.turns.has(f.alpha.id), true, '@alpha is busy');
  return b;
}

test('#506 your queued mention batched with a later wake reaches the agent once', async () => {
  const f = setup();
  const b = await busyAlpha(f);
  f.rt.sendMessage(f.t.id, { text: MINE });
  f.rt.agentWake(f.beta.id, 'alpha', 'Also, the tally is in the shared folder.');
  b.release();
  await settle(f.rt);
  const batch = toAlpha(f)[1];
  assert.equal(batch.message.messages?.length, 2, 'the two came as one batch');
  assert.equal(copies(batch, MINE), 1);
});

test('#506 an agent’s mention batched with your later message reaches the agent once', async () => {
  const f = setup();
  const b = await busyAlpha(f);
  f.rt.agentWake(f.beta.id, 'alpha', THEIRS);
  f.rt.sendMessage(f.t.id, { text: '@alpha and keep the old column too.' });
  b.release();
  await settle(f.rt);
  const batch = toAlpha(f)[1];
  assert.equal(batch.message.messages?.length, 2, 'the two came as one batch');
  assert.equal(copies(batch, THEIRS), 1);
});

test('#506 your message waiting behind a turn in a topic thread stays out of that turn’s summary, and comes whole after it', async () => {
  const f = setup();
  const root = arrange.post(f.rt, f.t.id, {
    kind: 'agent',
    sessionId: f.beta.id,
    personaId: f.beta.personaId,
    handle: 'beta',
    text: 'The tally is ready.',
    status: 'done',
  });
  const topic = f.rt.startTopic(f.t.id, root.id).threadId;
  const b = await busyAlpha(f);
  // Your Send now in the topic stops alpha's turn, and your message in the conversation, posted while it stops, waits
  // behind the topic's.
  const { queued } = f.rt.sendMessage(topic, { text: '@alpha Which column is off?' });
  f.rt.sendQueuedNow(topic, queued[0].id);
  f.rt.sendMessage(f.t.id, { text: MINE });
  b.release();
  await settle(f.rt);
  const [, inTopic, after] = toAlpha(f);
  assert.equal(inTopic.thread, topic, 'the topic’s turn came first');
  assert.equal(copies(inTopic, MINE), 0, 'its summary leaves out what waits for the agent');
  assert.equal(after.message.text, MINE, 'the next turn gives it whole, once');
});

test('#506 each of your messages waiting behind a topic thread’s turn comes whole after it, in one batch', async () => {
  const f = setup();
  const root = arrange.post(f.rt, f.t.id, {
    kind: 'agent',
    sessionId: f.beta.id,
    personaId: f.beta.personaId,
    handle: 'beta',
    text: 'The tally is ready.',
    status: 'done',
  });
  const topic = f.rt.startTopic(f.t.id, root.id).threadId;
  const b = await busyAlpha(f);
  const { queued } = f.rt.sendMessage(topic, { text: '@alpha Which column is off?' });
  f.rt.sendQueuedNow(topic, queued[0].id);
  f.rt.sendMessage(f.t.id, { text: MINE });
  f.rt.sendMessage(f.t.id, { text: THEIRS.replace('@alpha the review', '@alpha my review') });
  b.release();
  await settle(f.rt);
  const after = toAlpha(f).at(-1);
  assert.equal(after.message.messages?.length, 2, 'your two came as one batch');
  assert.deepEqual(
    after.message.messages.map((m) => m.text),
    [MINE, THEIRS.replace('@alpha the review', '@alpha my review')],
  );
  assert.equal(copies(toAlpha(f).at(-2), MINE), 0, 'the topic’s turn didn’t give it first');
});

test('#506 your queued mention alone comes in full: no summary gave it', async () => {
  const f = setup();
  const b = await busyAlpha(f);
  f.rt.sendMessage(f.t.id, { text: MINE });
  b.release();
  await settle(f.rt);
  assert.equal(toAlpha(f)[1].message.text, MINE);
});

test('#506 the pointer to your message keeps its attachments', async () => {
  const f = setup();
  const attachments = [{ id: 'att1', name: 'tally.csv', path: '/tmp/tally.csv', size: 10, type: 'text/csv' }];
  const it = arrange.post(f.rt, f.t.id, { kind: 'user', text: MINE, attachments });
  f.rt.deliver(f.alpha.id, { kind: 'user', text: 'Check the build.' });
  await settle(f.rt);
  f.rt.deliver(f.alpha.id, { kind: 'user', text: MINE, attachments, itemId: it.id });
  await settle(f.rt);
  const last = toAlpha(f).at(-1).message;
  assert.match(last.text, /The person’s message above/);
  assert.deepEqual(last.attachments, attachments);
});

test('#506 your message a summary left out, past the mentions’ cap, comes in full', async () => {
  const f = setup();
  const first = arrange.post(f.rt, f.t.id, { kind: 'user', text: `@alpha the oldest: ${'check this first. '.repeat(55)}` });
  for (let i = 0; i < 40; i++) arrange.post(f.rt, f.t.id, { kind: 'user', text: `@alpha note ${i + 1}: ${'the tally needs another look. '.repeat(33)}` });
  f.rt.deliver(f.alpha.id, { kind: 'user', text: 'Check the build.' });
  await settle(f.rt);
  f.rt.deliver(f.alpha.id, { kind: 'user', text: first.text, itemId: first.id });
  await settle(f.rt);
  assert.equal(toAlpha(f).at(-1).message.text, first.text);
});

test('#506 your two queued messages in a topic thread, delivered as one batch, reach the agent once each', async () => {
  const f = setup();
  const root = arrange.post(f.rt, f.t.id, {
    kind: 'agent',
    sessionId: f.beta.id,
    personaId: f.beta.personaId,
    handle: 'beta',
    text: 'The tally is ready.',
    status: 'done',
  });
  const topic = f.rt.startTopic(f.t.id, root.id).threadId;
  const b = await busyAlpha(f);
  f.rt.sendMessage(topic, { text: MINE });
  f.rt.sendMessage(topic, { text: '@alpha and keep the old column too.' });
  b.release();
  await settle(f.rt);
  const batch = toAlpha(f).at(-1);
  assert.equal(batch.thread, topic);
  assert.equal(batch.message.messages?.length, 2, 'the two came as one batch');
  assert.equal(copies(batch, MINE), 1);
});

test('#506 a command of yours a summary gave comes again whole on Retry: a command is never a pointer', async () => {
  const f = setup();
  const line = `/review @alpha ${'the totals, column by column. '.repeat(10)}`;
  const it = arrange.post(f.rt, f.t.id, { kind: 'user', text: line, attachments: [], command: { sessionId: f.alpha.id, handle: 'alpha' } });
  f.rt.deliver(f.alpha.id, { kind: 'user', text: 'Check the build.' });
  await settle(f.rt);
  f.rt.deliver(f.alpha.id, { kind: 'user', text: line, attachments: [], itemId: it.id, slash: true });
  await settle(f.rt);
  assert.equal(toAlpha(f).at(-1).message.text, line);
});

// Past READING.mention (15,000), so a summary cuts it: a message may be 50,000 characters.
const LONG = `@alpha please recount the totals. ${'Each column needs its own check. '.repeat(600)}THE-END-MARK`;

test('#506 your long message a topic thread’s summary cut comes after it in full, not as a pointer to what was cut', async () => {
  const f = setup();
  const root = arrange.post(f.rt, f.t.id, {
    kind: 'agent',
    sessionId: f.beta.id,
    personaId: f.beta.personaId,
    handle: 'beta',
    text: 'The tally is ready.',
    status: 'done',
  });
  const topic = f.rt.startTopic(f.t.id, root.id).threadId;
  const b = await busyAlpha(f);
  const { queued } = f.rt.sendMessage(topic, { text: '@alpha Which column is off?' });
  f.rt.sendQueuedNow(topic, queued[0].id);
  f.rt.sendMessage(f.t.id, { text: LONG });
  b.release();
  await settle(f.rt);
  const [, inTopic, after] = toAlpha(f);
  assert.equal(inTopic.thread, topic, 'the topic’s turn came first');
  assert.equal(copies(inTopic, 'THE-END-MARK'), 0, 'its summary cut your message');
  assert.equal(after.message.text, LONG);
});

test('#506 an agent’s mention one character past what a summary gives whole comes in full when its wake is delivered, not as a pointer', async () => {
  const f = setup();
  // One character past what a summary gives whole.
  const text = `@alpha from beta: ${'x'.repeat(READING.mention + 1 - 30)}THE-END-MARK`;
  assert.equal(text.length, READING.mention + 1);
  const it = arrange.post(f.rt, f.t.id, { kind: 'agent', sessionId: f.beta.id, personaId: f.beta.personaId, handle: 'beta', text, status: 'done' });
  f.rt.deliver(f.alpha.id, { kind: 'user', text: 'Check the build.' });
  await settle(f.rt);
  f.rt.deliver(f.alpha.id, { kind: 'agent', from: '@beta', text, itemId: it.id });
  await settle(f.rt);
  const [first, second] = toAlpha(f);
  assert.equal(copies(first, 'THE-END-MARK'), 0, 'the summary cut it');
  assert.equal(second.message.text, text);
});

test('#506 an agent’s mention exactly as long as a summary gives whole comes as a pointer: the summary gave all of it', async () => {
  const f = setup();
  const head = '@alpha from beta: the totals, column by column. ';
  const text = `${head}${'x'.repeat(READING.mention - head.length)}`;
  assert.equal(text.length, READING.mention);
  const it = arrange.post(f.rt, f.t.id, { kind: 'agent', sessionId: f.beta.id, personaId: f.beta.personaId, handle: 'beta', text, status: 'done' });
  f.rt.deliver(f.alpha.id, { kind: 'user', text: 'Check the build.' });
  await settle(f.rt);
  f.rt.deliver(f.alpha.id, { kind: 'agent', from: '@beta', text, itemId: it.id });
  await settle(f.rt);
  const [first, second] = toAlpha(f);
  assert.equal(copies(first, text), 1, 'the summary gave it whole');
  assert.match(second.message.text, /^@beta’s message above, which your last summary gave you in full: /);
});

test('#506 your message sent again, word for word, comes in full: it’s a new message, not the one a summary gave', async () => {
  const f = setup();
  const root = arrange.post(f.rt, f.t.id, {
    kind: 'agent',
    sessionId: f.beta.id,
    personaId: f.beta.personaId,
    handle: 'beta',
    text: 'The tally is ready.',
    status: 'done',
  });
  const topic = f.rt.startTopic(f.t.id, root.id).threadId;
  const b = await busyAlpha(f);
  const { queued } = f.rt.sendMessage(topic, { text: '@alpha Which column is off?' });
  f.rt.sendQueuedNow(topic, queued[0].id);
  f.rt.sendMessage(f.t.id, { text: MINE });
  b.release();
  await settle(f.rt);
  f.rt.sendMessage(f.t.id, { text: MINE });
  await settle(f.rt);
  const [, , first, again] = toAlpha(f);
  assert.equal(first.message.text, MINE);
  assert.equal(again.message.text, MINE);
});
