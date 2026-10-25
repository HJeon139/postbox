// Who needs you and in what order (#285): shared/needs.mjs, which the page’s ⌃J and rings read, and the UAT’s check
// and triggers of where going to an ask landed (server/room-checks-needs.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runChecks } from '../server/room-checks.mjs';
import { NEEDS_CHECKS, NEEDS_TRIGGERS, needsAt } from '../server/room-checks-needs.mjs';
import { conversationOf, NEEDS_KINDS, needsOrder, needsYouNow, whereNeeds } from '../shared/needs.mjs';
import { TRIGGERS } from '../tools/uat/triggers.mjs';

// Two conversations: a room with a side thread and a topic thread, and a direct message. Each agent's ask was posted
// at the time in its item, which is the order they waited in, whatever their sessions' updatedAt says.
const session = (id, handle, threadId, needs, updatedAt = 0) => ({ id, handle, threadId, needs, updatedAt, state: needs ? 'needs' : 'idle' });
const state = {
  threads: {
    room: { id: 'room', kind: 'thread' },
    side: { id: 'side', kind: 'side', parentId: 'room' },
    topic: { id: 'topic', kind: 'topic', parentId: 'room' },
    dm: { id: 'dm', kind: 'thread' },
  },
  sessions: {
    a: session('a', 'alpha', 'dm', { kind: 'block', itemId: 'ask-a' }, 900),
    b: session('b', 'beta', 'room', { kind: 'block', itemId: 'ask-b', threadId: 'side' }, 100),
    c: session('c', 'gamma', 'room', { kind: 'denial', itemId: 'ask-c' }, 50),
    d: session('d', 'delta', 'room', { kind: 'toolask', itemId: 'ask-d', threadId: 'topic' }, 20),
    e: session('e', 'eps', 'room', null),
  },
  items: {
    dm: [{ id: 'ask-a', at: 1 }],
    side: [{ id: 'ask-b', at: 4 }],
    room: [{ id: 'ask-c', at: 2 }],
    topic: [{ id: 'ask-d', at: 3 }],
  },
};
const all = Object.values(state.sessions);

test('every kind an agent can need you for counts, a refused step and a tool request too', () => {
  assert.deepEqual(NEEDS_KINDS, ['block', 'failed', 'hop', 'permission', 'appsend', 'denial', 'toolask']);
  assert.equal(needsYouNow(state.sessions.c), true);
  assert.equal(needsYouNow(state.sessions.d), true);
  assert.equal(needsYouNow(state.sessions.e), false);
  assert.equal(needsYouNow({ needs: { kind: 'mystery' } }), false);
});

test('an ask is where it was posted, and a side or topic thread belongs to its conversation', () => {
  assert.equal(whereNeeds(state, state.sessions.b), 'side');
  assert.equal(whereNeeds(state, state.sessions.c), 'room');
  assert.equal(conversationOf(state, 'side'), 'room');
  assert.equal(conversationOf(state, 'topic'), 'room');
  assert.equal(conversationOf(state, 'dm'), 'dm');
});

test('the agents that need you come oldest first by their ask, and the open conversation’s first', () => {
  assert.deepEqual(
    needsOrder(state, all).map((se) => se.handle),
    ['alpha', 'gamma', 'delta', 'beta'],
  );
  assert.deepEqual(
    needsOrder(state, all, 'room').map((se) => se.handle),
    ['gamma', 'delta', 'beta', 'alpha'],
  );
  assert.deepEqual(
    needsOrder(state, all, 'dm').map((se) => se.handle),
    ['alpha', 'gamma', 'delta', 'beta'],
  );
});

test('needsAt says who needed you from the page the runner was on, in ⌃J’s order', () => {
  const at = needsAt(state, '#/t/room/side/side');
  assert.equal(at.here, 'room');
  assert.deepEqual(
    at.needing.map((n) => [n.handle, n.itemId, n.side, n.here]),
    [
      ['gamma', 'ask-c', false, true],
      ['delta', 'ask-d', true, true],
      ['beta', 'ask-b', true, true],
      ['alpha', 'ask-a', false, false],
    ],
  );
  assert.equal(needsAt(state, '#/').here, null);
});

const landed = (key, { onScreen = true, outlined = true } = {}) => ({ key, onScreen, outlined });
const jump = (from, handle, hash, l, step = 1) => ({ step, from, handle, before: hash, expect: needsAt(state, hash), landed: l });
const findings = (jumps) => runChecks({ probes: { jumps } }, { checks: NEEDS_CHECKS });

test('needs-jump-missed: a ring that lands on its own agent’s ask, on screen and outlined, is right', () => {
  assert.deepEqual(findings([jump('agents', 'beta', '#/t/room', landed('ask-b'))]), []);
  assert.deepEqual(findings([jump('next', '', '#/t/room', landed('ask-c'))]), []);
});

test('needs-jump-missed: another agent’s ask, nothing, off screen or no outline is a finding for #285', () => {
  const [wrong] = findings([jump('agents', 'beta', '#/t/room', landed('ask-c'))]);
  assert.equal(wrong.issue, 285);
  assert.equal(wrong.title, 'Going to what @beta needs from its ring in the Agents section didn’t land on its ask');
  assert.match(wrong.evidence, /focus landed on @gamma’s ask, not @beta’s ask/);
  assert.match(findings([jump('rail', 'beta', '#/t/room', null)])[0].evidence, /focus landed on nothing/);
  assert.match(findings([jump('message', 'beta', '#/t/room', landed('ask-b', { onScreen: false }))])[0].evidence, /\(off screen\)/);
  assert.match(findings([jump('rail', 'beta', '#/t/room', landed('ask-b', { outlined: false }))])[0].evidence, /\(not outlined\)/);
  // From a conversation whose agent needs you, ⌃J goes there first: not to the oldest elsewhere.
  assert.equal(findings([jump('next', '', '#/t/room', landed('ask-a'))]).length, 1);
});

test('needs-jump-missed: ⌃J pressed again may land on any agent that needs you, and an idle agent’s ring is not judged', () => {
  assert.deepEqual(findings([jump('next', '', '#/t/room', landed('ask-c'), 1), jump('next', '', '#/t/room', landed('ask-a'), 2)]), []);
  assert.deepEqual(findings([jump('agents', 'eps', '#/t/room', null)]), []);
  assert.deepEqual(findings([{ step: 1, from: 'next', expect: { here: null, needing: [] }, landed: null }]), []);
});

test('the #285 triggers fire on two agents waiting, a side-thread ask, and a ring click', () => {
  for (const id of ['two-need-you', 'side-thread-need', 'ring-jump']) assert.ok(TRIGGERS[id], `${id} is registered`);
  const jumps = [jump('next', '', '#/', landed('ask-a')), jump('agents', 'beta', '#/', landed('ask-b'))];
  const f = { probes: { jumps } };
  assert.equal(NEEDS_TRIGGERS['two-need-you'].run(f).length, 2);
  assert.equal(NEEDS_TRIGGERS['side-thread-need'].run(f).length, 2);
  assert.equal(NEEDS_TRIGGERS['ring-jump'].run(f).length, 1);
  assert.equal(NEEDS_TRIGGERS['ring-jump'].recorded({ probes: {} }), false);
});
