// #506: a message a turn's summary gives in full reaches the agent once. A combined batch (the person's queued message
// and an agent's wake, delivered as one) left every message but the last in the turn's summary too, so the agent read
// it twice in one prompt; and the person's message, already posted and waiting behind a turn in another thread, came in
// full after that turn's summary gave it, since the pointer #484 made was only for an agent's mention.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { READING } from '../shared/limits.mjs';
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

test('#506 your posted message that a turn in a topic thread gave in full comes after it as a pointer', async () => {
  const f = setup();
  const root = f.rt.addItem(f.t.id, {
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
  f.rt.sendQueuedNow(topic, queued.id);
  f.rt.sendMessage(f.t.id, { text: MINE });
  b.release();
  await settle(f.rt);
  const [, inTopic, after] = toAlpha(f);
  assert.equal(inTopic.thread, topic, 'the topic’s turn came first');
  assert.equal(copies(inTopic, MINE), 1, 'its summary gave your message in full');
  const mine = f.store.items(f.t.id).find((x) => x.kind === 'user' && x.text === MINE);
  assert.equal(copies(after, MINE), 0, 'the next turn doesn’t repeat it');
  assert.match(after.message.text, /The person’s message above, which your last summary gave you in full: “@alpha please recount/);
  assert.ok(after.message.text.includes(`read_message { id: "${mine.id}" }`), after.message.text);
});

test('#506 each of your posted messages that a topic thread’s turn gave comes after it as a pointer, in one batch', async () => {
  const f = setup();
  const root = f.rt.addItem(f.t.id, {
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
  f.rt.sendQueuedNow(topic, queued.id);
  f.rt.sendMessage(f.t.id, { text: MINE });
  f.rt.sendMessage(f.t.id, { text: THEIRS.replace('@alpha the review', '@alpha my review') });
  b.release();
  await settle(f.rt);
  const after = toAlpha(f).at(-1);
  assert.equal(after.message.messages?.length, 2, 'your two came as one batch');
  assert.deepEqual(
    after.message.messages.map((m) => /^The person’s message above/.test(m.text)),
    [true, true],
  );
  assert.equal(copies(after, MINE), 0, 'neither repeats in full');
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
  const it = f.rt.addItem(f.t.id, { kind: 'user', text: MINE, attachments });
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
  const first = f.rt.addItem(f.t.id, { kind: 'user', text: `@alpha the oldest: ${'check this first. '.repeat(55)}` });
  for (let i = 0; i < 40; i++) f.rt.addItem(f.t.id, { kind: 'user', text: `@alpha note ${i + 1}: ${'the tally needs another look. '.repeat(33)}` });
  f.rt.deliver(f.alpha.id, { kind: 'user', text: 'Check the build.' });
  await settle(f.rt);
  f.rt.deliver(f.alpha.id, { kind: 'user', text: first.text, itemId: first.id });
  await settle(f.rt);
  assert.equal(toAlpha(f).at(-1).message.text, first.text);
});

test('#506 your two queued messages in a topic thread, delivered as one batch, reach the agent once each', async () => {
  const f = setup();
  const root = f.rt.addItem(f.t.id, {
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
  const it = f.rt.addItem(f.t.id, { kind: 'user', text: line, attachments: [], command: { sessionId: f.alpha.id, handle: 'alpha' } });
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
  const root = f.rt.addItem(f.t.id, {
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
  f.rt.sendQueuedNow(topic, queued.id);
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
  const it = f.rt.addItem(f.t.id, { kind: 'agent', sessionId: f.beta.id, personaId: f.beta.personaId, handle: 'beta', text, status: 'done' });
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
  const it = f.rt.addItem(f.t.id, { kind: 'agent', sessionId: f.beta.id, personaId: f.beta.personaId, handle: 'beta', text, status: 'done' });
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
  const root = f.rt.addItem(f.t.id, {
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
  f.rt.sendQueuedNow(topic, queued.id);
  f.rt.sendMessage(f.t.id, { text: MINE });
  b.release();
  await settle(f.rt);
  f.rt.sendMessage(f.t.id, { text: MINE });
  await settle(f.rt);
  const [, , pointer, again] = toAlpha(f);
  assert.match(pointer.message.text, /^The person’s message above, which your last summary gave you in full: /);
  assert.equal(again.message.text, MINE);
});
