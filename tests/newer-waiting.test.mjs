// #694: an agent answering a message is told, on its next Postbox tool result, that a newer message from the same
// sender already waits for it in the turn’s thread, so it can read that one first. Each waiting message is named once
// per turn, and only the turn’s own sender counts, the person included.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleMcp } from '../server/mcp.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

const call = (rt, se, name, args) =>
  handleMcp(rt, se.id, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, rt.turns.get(se.id)?.token ?? null);
const PERSON = '[Postbox] A newer message from the person is waiting for you; it reaches you when this turn ends, unless it’s removed.';
const count = (text, re) => (text.match(re) ?? []).length;
const define = async (rt, se, term) => (await call(rt, se, 'define_term', { term, definition: 'A word.' })).result.content[0].text;

/** @beta busy with @alpha’s wake, held until release(). */
async function busyWithAlpha() {
  const ctx = setup();
  const busy = held();
  ctx.adapter.next.push(busy.step);
  ctx.rt.agentWake(ctx.alpha.id, 'beta', 'Review head aaa111.');
  await sleep(5);
  return { ...ctx, release: busy.release };
}

test('#694: a newer wake from the turn’s sender is named on the next Postbox tool result, once', async () => {
  const { rt, t, alpha, beta, release } = await busyWithAlpha();
  rt.agentWake(alpha.id, 'beta', 'New head bbb222, review that instead.');
  const wake = rt.s.threads[t.id].queue.at(-1);
  const text = await define(rt, beta, 'X');
  assert.ok(text.startsWith(`[Postbox] A newer message from @alpha is waiting for you; read_message { id: "${wake.itemId}" } has it.\n\n`), text);
  assert.match(text, /Defined “X”\.$/);
  assert.doesNotMatch(await define(rt, beta, 'Y'), /newer message/, 'it’s named once in the turn');
  release();
  await settle(rt);
});

test('#694: a waiting message from another sender isn’t named', async () => {
  const { rt, t, beta, c, release } = await busyWithAlpha();
  const gamma = rt.ensureSession(t.id, c.id);
  rt.agentWake(gamma.id, 'beta', 'Something else.');
  assert.doesNotMatch(await define(rt, beta, 'X'), /newer message/);
  release();
  await settle(rt);
});

test('#694: the person counts as a sender: their queued message is named to a turn they started', async () => {
  const { rt, adapter, t, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta review head aaa111' });
  await sleep(5);
  rt.sendMessage(t.id, { text: '@beta no, review bbb222' });
  const text = await define(rt, beta, 'X');
  assert.ok(text.startsWith(`${PERSON}\n\n`), text);
  assert.doesNotMatch(await define(rt, beta, 'Y'), /newer message/, 'it’s named once in the turn');
  busy.release();
  await settle(rt);
});

test('#694: a newer message from the sender in another thread isn’t named: that waits on A3 (#734)', async () => {
  const { rt, t, alpha, beta, release } = await busyWithAlpha();
  const root = rt.addItem(t.id, { kind: 'agent', sessionId: alpha.id, handle: 'alpha', text: 'A topic.', status: 'done' });
  const topic = rt.startTopic(t.id, root.id).threadId;
  rt.agentWake(alpha.id, 'beta', 'In the topic.', { replyIn: topic });
  assert.doesNotMatch(await define(rt, beta, 'X'), /newer message/);
  release();
  await settle(rt);
});

test('#694: a message from the sender waiting on the turn itself is named only if it’s for the turn’s thread', async () => {
  const { rt, t, alpha, beta, release } = await busyWithAlpha();
  const root = rt.addItem(t.id, { kind: 'agent', sessionId: alpha.id, handle: 'alpha', text: 'A topic.', status: 'done' });
  const topic = rt.startTopic(t.id, root.id).threadId;
  rt.deliver(beta.id, { kind: 'agent', from: '@alpha', text: 'Pending in the topic.' }, { threadId: topic });
  assert.doesNotMatch(await define(rt, beta, 'X'), /newer message/, 'not one for another thread');
  rt.deliver(beta.id, { kind: 'agent', from: '@alpha', text: 'Pending here.' });
  assert.match(
    await define(rt, beta, 'Y'),
    /^\[Postbox\] A newer message from @alpha is waiting for you; it reaches you when this turn ends, unless it’s removed\.\n\n/,
  );
  release();
  await settle(rt);
});

test('#694: a message queued for another agent isn’t named, even from the same sender', async () => {
  const { rt, adapter, t, beta } = setup();
  const first = held();
  const second = held();
  adapter.next.push(first.step, second.step);
  rt.sendMessage(t.id, { text: '@alpha @beta start' });
  await sleep(5);
  rt.sendMessage(t.id, { text: '@alpha only you' });
  assert.doesNotMatch(await define(rt, beta, 'X'), /newer message/);
  first.release();
  second.release();
  await settle(rt);
});

test('#694: a message queued before the one the turn answers isn’t called newer (Send now from the queue)', async () => {
  const { rt, adapter, t, beta } = setup();
  const first = held();
  const second = held();
  adapter.next.push(first.step, second.step);
  rt.sendMessage(t.id, { text: '@beta first job' });
  await sleep(5);
  rt.sendMessage(t.id, { text: '@beta q1, older' });
  await sleep(2);
  rt.sendMessage(t.id, { text: '@beta q2, sent now' });
  rt.sendQueuedNow(t.id, rt.s.threads[t.id].queue.at(-1).id);
  first.release();
  for (let i = 0; i < 100 && adapter.calls.filter((c) => c.sessionId === beta.id).length < 2; i++) await sleep(5);
  assert.match(adapter.calls.at(-1).message.text, /q2, sent now/, 'the turn answers q2');
  assert.doesNotMatch(await define(rt, beta, 'X'), /newer message/, 'q1 was sent before q2');
  second.release();
  await settle(rt);
});

test('#694: the note never quotes the message, so one the person removes after it was named stays retracted', async () => {
  const { rt, adapter, t, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta review aaa111' });
  await sleep(5);
  rt.sendMessage(t.id, { text: '@beta review bbb222' });
  const text = await define(rt, beta, 'X');
  assert.ok(text.startsWith(`${PERSON}\n\n`), text);
  assert.doesNotMatch(text, /bbb222/, 'its words aren’t in the note');
  rt.cancelQueued(t.id, rt.s.threads[t.id].queue.at(-1).id);
  assert.doesNotMatch(await define(rt, beta, 'Y'), /newer message|bbb222/);
  busy.release();
  await settle(rt);
});

test('#694: in a batch of two agents’ wakes, a newer wake from either sender is named', async () => {
  const { rt, adapter, t, alpha, beta, c } = setup();
  const gamma = rt.ensureSession(t.id, c.id);
  const first = held();
  const second = held();
  adapter.next.push(first.step, second.step);
  rt.agentWake(alpha.id, 'beta', 'First job.');
  await sleep(5);
  rt.agentWake(alpha.id, 'beta', 'From alpha, batched.');
  rt.agentWake(gamma.id, 'beta', 'From gamma, batched.');
  first.release();
  for (let i = 0; i < 100 && adapter.calls.filter((x) => x.sessionId === beta.id).length < 2; i++) await sleep(5);
  assert.equal(adapter.calls.at(-1).message.messages?.length, 2, 'the two wakes are one batch');
  rt.agentWake(alpha.id, 'beta', 'Newer from alpha.');
  const wake = rt.s.threads[t.id].queue.at(-1);
  assert.ok((await define(rt, beta, 'X')).includes(`from @alpha is waiting for you; read_message { id: "${wake.itemId}" } has it.`));
  second.release();
  await settle(rt);
});

test('#694: a slow tool call of a turn Send now replaced names nothing; the turn now running hears it', async () => {
  const { rt, adapter, t, beta } = setup();
  const first = held();
  const second = held();
  adapter.next.push(first.step, second.step);
  rt.sendMessage(t.id, { text: '@beta first job' });
  await sleep(5);
  const before = rt.turns.get(beta.id);
  let open = () => {};
  const gate = new Promise((r) => {
    open = r;
  });
  const appFiles = rt.appFiles.bind(rt);
  rt.appFiles = async (...a) => {
    await gate;
    return appFiles(...a);
  };
  const slow = handleMcp(
    rt,
    beta.id,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'show_app', arguments: { title: 'A', code: '<p>x</p>' } } },
    before.token,
  );
  await sleep(2);
  rt.sendMessage(t.id, { text: '@beta change of course', sendNow: true });
  first.release();
  for (let i = 0; i < 100 && (!rt.turns.get(beta.id) || rt.turns.get(beta.id) === before); i++) await sleep(5);
  rt.sendMessage(t.id, { text: '@beta and also this' });
  open();
  assert.doesNotMatch((await slow).result.content[0].text, /newer message/, 'the stopped turn’s result names nothing');
  assert.ok((await define(rt, beta, 'X')).startsWith(PERSON), 'the running turn hears it');
  second.release();
  await settle(rt);
});

test('#694: an urgent note comes first, then the newer message, then the result', async () => {
  const { rt, alpha, beta, release } = await busyWithAlpha();
  rt.agentWake(alpha.id, 'beta', 'New head bbb222.');
  rt.updateSession(beta.id, { context: ['[Postbox] URGENT: stop the subagent.'] });
  const lines = (await define(rt, beta, 'X')).split('\n');
  assert.equal(lines[0], '[Postbox] URGENT: stop the subagent.');
  assert.match(lines[1], /^\[Postbox\] A newer message from @alpha/);
  assert.equal(lines.at(-1), 'Defined “X”.');
  release();
  await settle(rt);
});

test('#694: each part of a batch waiting on the turn is named, with its own time', async () => {
  const { rt, beta, release } = await busyWithAlpha();
  const later = Date.now() + 1000;
  const part = (text, at) => ({ kind: 'agent', from: '@alpha', text, at });
  rt.deliver(beta.id, { kind: 'agent', from: '@alpha', text: 'A\n\nB', messages: [part('Batched A.', later), part('Batched B.', later + 1)] });
  const text = await define(rt, beta, 'X');
  assert.equal(count(text, /A newer message from @alpha is waiting for you; it reaches you when this turn ends, unless it’s removed\./g), 2, 'both parts');
  release();
  await settle(rt);
});

test('#694: a person’s message waiting on the turn itself is named, as one in the queue is', async () => {
  const { rt, adapter, t, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@beta review aaa111' });
  await sleep(5);
  rt.deliver(beta.id, { kind: 'user', text: 'Waiting on the turn.' });
  assert.ok((await define(rt, beta, 'X')).startsWith(PERSON));
  busy.release();
  await settle(rt);
});

test('#694: at most three are named on one result; the rest are counted, then named on the next', async () => {
  const { rt, t, alpha, beta, release } = await busyWithAlpha();
  for (const n of [1, 2, 3, 4, 5]) rt.agentWake(alpha.id, 'beta', `Newer ${n}.`);
  const ids = rt.s.threads[t.id].queue.map((q) => q.itemId);
  const first = await define(rt, beta, 'X');
  assert.equal((first.match(/A newer message from @alpha/g) ?? []).length, 3);
  assert.match(first, /\[Postbox\] 2 more newer messages are waiting for you; the next result names them\./);
  const second = await define(rt, beta, 'Y');
  assert.ok(second.includes(ids[3]) && second.includes(ids[4]), 'the fourth and fifth');
  assert.ok(!second.includes(ids[0]), 'not the first again');
  assert.doesNotMatch(second, /more newer/);
  release();
  await settle(rt);
});

test('#694: a wake queued in the same millisecond the turn started is newer', async () => {
  const { rt, adapter, t, alpha, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  const now = Date.now;
  const frozen = now();
  Date.now = () => frozen;
  try {
    rt.agentWake(alpha.id, 'beta', 'Review head aaa111.');
    rt.agentWake(alpha.id, 'beta', 'New head bbb222.');
  } finally {
    Date.now = now;
  }
  const wake = rt.s.threads[t.id].queue.at(-1);
  assert.equal(wake.at, rt.turns.get(beta.id).startedAt, 'the same millisecond');
  assert.ok((await define(rt, beta, 'X')).includes(wake.itemId));
  busy.release();
  await settle(rt);
});

test('#694: two messages from one sender waiting on the turn, sent in the same millisecond, are each named', async () => {
  const { rt, beta, release } = await busyWithAlpha();
  const at = Date.now() + 1000;
  rt.deliver(beta.id, { kind: 'agent', from: '@alpha', text: 'A.', at });
  assert.equal(count(await define(rt, beta, 'X'), /A newer message from @alpha/g), 1);
  rt.deliver(beta.id, { kind: 'agent', from: '@alpha', text: 'B.', at });
  assert.equal(count(await define(rt, beta, 'Y'), /A newer message from @alpha/g), 1, 'the second has a key of its own');
  release();
  await settle(rt);
});
