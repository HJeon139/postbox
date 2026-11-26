// Who a “needs you” is for (#1742): what only a person can act on rings one person, the one who last wrote in that
// room, or who made it when no one has written; the page’s rings, counts and ⌃J read the viewer’s own; and with one
// person, or with no one named, everyone who looks is rung, as before.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsOrder, needsYouNow } from '../shared/needs.mjs';
import * as arrange from './arrange.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

const fail = async () => {
  throw new Error('API 500');
};
const needs = (/** @type {any} */ room, se = room.alpha) => {
  const s = room.store.state.sessions[se.id];
  return [s.needs?.kind ?? null, s.needsFor ?? null];
};

test('a need names no one while no person is known to have written or made the room, so everyone is rung as before', async () => {
  const room = setup();
  room.adapter.next.push(fail);
  room.rt.sendMessage(room.t.id, { text: '@alpha hello' });
  await settle(room.rt);
  assert.deepEqual(needs(room), ['failed', null]);
  const se = room.store.state.sessions[room.alpha.id];
  assert.equal(needsYouNow(se), true, 'a reader that names no viewer');
  assert.equal(needsYouNow(se, 'pn_anyone'), true);
});

test('a need is for the person who last wrote in the room, and moves when another person writes', async () => {
  const room = setup();
  room.adapter.next.push(fail);
  room.rt.sendMessage(room.t.id, { text: '@alpha from Robin' }, { id: 'pn_robin' });
  await settle(room.rt);
  assert.deepEqual(needs(room), ['failed', ['pn_robin']]);
  const se = () => room.store.state.sessions[room.alpha.id];
  assert.deepEqual([needsYouNow(se(), 'pn_robin'), needsYouNow(se(), 'pn_sam'), needsYouNow(se())], [true, false, true]);
  // Sam writes to beta, which fails: beta’s need is Sam’s, and alpha’s stays Robin’s, whose message its turn answered.
  room.adapter.next.push(fail);
  room.rt.sendMessage(room.t.id, { text: '@beta from Sam' }, { id: 'pn_sam' });
  await settle(room.rt);
  assert.deepEqual(needs(room, room.beta), ['failed', ['pn_sam']]);
  assert.deepEqual(needs(room), ['failed', ['pn_robin']]);
  // Each person’s queue is their own, in ⌃J’s order.
  const all = Object.values(room.store.state.sessions);
  const queue = (/** @type {string | undefined} */ me) => needsOrder(room.store.state, all, null, me).map((s) => s.handle);
  assert.deepEqual([queue('pn_robin'), queue('pn_sam'), queue(undefined)], [['alpha'], ['beta'], ['alpha', 'beta']]);
});

test('a turn another agent’s mention started rings the last person to write in the room, with no tracking of who began the chain', async () => {
  const room = setup();
  // Robin asks alpha, which hands to beta. Sam writes meanwhile, to gamma’s nothing: beta’s turn then fails.
  room.adapter.next.push(async (c) => c.text('@beta please check this.'));
  room.rt.sendMessage(room.t.id, { text: '@alpha from Robin' }, { id: 'pn_robin' });
  arrange.post(room.rt, room.t.id, { kind: 'user', text: 'A note from Sam', personId: 'pn_sam', to: [] });
  room.rt.threads.patch(room.t.id, { lastPerson: 'pn_sam' });
  room.adapter.next.push(fail);
  await settle(room.rt);
  assert.deepEqual(needs(room, room.beta), ['failed', ['pn_sam']]);
});

test('with no message yet, a need is for the person who made the room; a cleared need names no one', async () => {
  const room = setup();
  const t = room.rt.createThread({ projectId: 'p1', title: 'Made by Robin', personaIds: [room.a.id] }, 'pn_robin');
  assert.equal(room.store.state.threads[t.id].lastPerson, 'pn_robin');
  const [alpha] = arrange.sessionsIn(room.rt, t.id);
  room.rt.sessions.update(alpha.id, { needs: { kind: 'failed', itemId: 'it_x', text: 'It failed.' } });
  assert.deepEqual(room.store.state.sessions[alpha.id].needsFor, ['pn_robin']);
  room.rt.sessions.update(alpha.id, { needs: null });
  assert.equal(room.store.state.sessions[alpha.id].needsFor, undefined);
  // Nothing in a body makes a room someone else’s: the route passes who is asking beside it.
  const forged = room.rt.createThread(
    /** @type {any} */ ({ projectId: 'p1', title: 'Forged', personaIds: [], lastPerson: 'pn_mallory', personId: 'pn_mallory' }),
  );
  assert.equal(room.store.state.threads[forged.id].lastPerson, undefined);
});

test('a need raised in a topic thread is for the room’s last person, and a message written in a topic thread makes the room theirs', async () => {
  const room = setup();
  room.rt.sendMessage(room.t.id, { text: '@alpha from Robin' }, { id: 'pn_robin' });
  await settle(room.rt);
  const reply = room.store.state.items[room.t.id].find((/** @type {any} */ it) => it.kind === 'agent');
  const topic = room.rt.startTopic(room.t.id, reply.id);
  room.adapter.next.push(fail);
  room.rt.sendMessage(topic.threadId, { text: 'From Sam, in the thread' }, { id: 'pn_sam' });
  await settle(room.rt);
  // The room keeps who last wrote, wherever in it they wrote; a topic thread keeps no one of its own.
  assert.equal(room.store.state.threads[room.t.id].lastPerson, 'pn_sam');
  assert.equal(room.store.state.threads[topic.threadId].lastPerson, undefined);
  assert.equal(room.store.state.sessions[room.alpha.id].needs.threadId, topic.threadId);
  assert.deepEqual(needs(room), ['failed', ['pn_sam']]);
});
