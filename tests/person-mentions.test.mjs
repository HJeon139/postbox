// A mention of a person is a “needs you” for them (#1742): an agent’s reply that names a person by user name, or
// says @you to the person it answers, makes the agent need that person, until they read it or move on. A reply to
// another agent that says @you stops at that agent, and one that names a person reaches them from anywhere.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RANK, TURN_TIED } from '../server/card-needs.mjs';
import { People } from '../server/people.mjs';
import { needsYouNow } from '../shared/needs.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

const ROBIN = { provider: 'oidc', issuer: 'https://idp.example', subject: 'u-1', username: 'robin', name: 'Robin Example' };
const SAM = { ...ROBIN, subject: 'u-2', username: 'sam', name: 'Sam Okafor' };

/** A room that knows Robin and Sam, and a way to send as either. */
function room() {
  const f = setup();
  const people = new People({ store: f.rt.store });
  const [robin, sam] = [people.seen(people.of(ROBIN)), people.seen(people.of(SAM))];
  const say = async (/** @type {string} */ text, /** @type {any} */ by = robin) => {
    const sent = f.rt.sendMessage(f.t.id, { text }, { id: by.id });
    await settle(f.rt);
    return sent.item;
  };
  const need = (se = f.alpha) => {
    const s = f.store.state.sessions[se.id];
    return [s.needs?.kind ?? null, s.needsFor ?? null, s.state];
  };
  return { ...f, people, robin, sam, say, need };
}
const replies = (/** @type {any} */ f, /** @type {string} */ text) => f.adapter.next.push(async (/** @type {any} */ c) => c.text(text));

test('a mention is a kind of need: ranked last, and cleared when the person moves on', () => {
  assert.equal(RANK.mention, Math.max(...Object.values(RANK)));
  assert.ok(TURN_TIED.has('mention'));
});

test('@you in a reply to a person makes the agent need that person, and their next message to it clears it', async () => {
  const f = room();
  replies(f, 'Done. @you should look at the totals.');
  await f.say('@alpha check the totals');
  assert.deepEqual(f.need(), ['mention', [f.robin.id], 'needs']);
  const se = f.store.state.sessions[f.alpha.id];
  assert.deepEqual([needsYouNow(se, f.robin.id), needsYouNow(se, f.sam.id)], [true, false]);
  const reply = f.store.items(f.t.id).find((i) => i.id === se.needs.itemId);
  assert.deepEqual([reply.kind, reply.asks], ['agent', []]);
  await f.say('@alpha thanks');
  assert.deepEqual(f.need(), [null, null, 'idle']);
});

test('a reply that names a person by user name is for them, whoever the turn answers; a plain reply needs no one', async () => {
  const f = room();
  replies(f, 'All counted.');
  await f.say('@alpha count them');
  assert.deepEqual(f.need(), [null, null, 'idle']);
  // Robin asks alpha, which hands to beta; beta, answering an agent, names Sam.
  replies(f, '@beta please check this.');
  replies(f, 'It needs a decision from @Sam before I go on.');
  await f.say('@alpha hand it on');
  assert.deepEqual(f.need(f.beta), ['mention', [f.sam.id], 'needs']);
  assert.deepEqual(f.need(), [null, null, 'idle']);
});

test('@you in a reply to another agent stops at that agent: no person is rung', async () => {
  const f = room();
  replies(f, '@beta please check this.');
  replies(f, 'Checked, @you can go on.');
  await f.say('@alpha hand it on');
  assert.deepEqual(f.need(f.beta), [null, null, 'idle']);
});

test('a mention in a quote, a name no one has, and an agent’s own handle ask no person', async () => {
  const f = room();
  replies(f, '> @sam said so\n\nNoted, and @nobody agrees. I am @alpha.');
  await f.say('@alpha note it');
  assert.deepEqual(f.need(), [null, null, 'idle']);
});

test('reading it clears it: the person it is for opening the room, not another person', async () => {
  const f = room();
  replies(f, 'A question for @sam: which region?');
  await f.say('@alpha ask Sam');
  assert.deepEqual(f.need(), ['mention', [f.sam.id], 'needs']);
  f.rt.view(f.t.id, f.robin.id);
  assert.deepEqual(f.need(), ['mention', [f.sam.id], 'needs'], 'Robin reading it isn’t Sam reading it');
  f.rt.view(f.t.id, f.sam.id);
  assert.deepEqual(f.need(), [null, null, 'idle']);
  const reply = f.store.items(f.t.id).findLast((i) => i.kind === 'agent');
  assert.equal(reply.asksSeen, true);
});

test('a mention that lands while its person has the room open is read already, and asks nothing', async () => {
  const f = room();
  f.rt.view(f.t.id, f.robin.id);
  replies(f, 'Done, @you can look.');
  await f.say('@alpha go');
  assert.deepEqual(f.need(), [null, null, 'idle']);
  // Open by someone else, it still waits for the one it names.
  f.rt.view(f.t.id, f.robin.id);
  replies(f, 'And @sam should see this.');
  await f.say('@alpha go on');
  assert.deepEqual(f.need(), ['mention', [f.sam.id], 'needs']);
});

test('with no person known, @you in a reply to the person still asks, for whoever looks', async () => {
  const f = setup();
  f.adapter.next.push(async (/** @type {any} */ c) => c.text('Over to @you.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha go' });
  await settle(f.rt);
  const se = f.store.state.sessions[f.alpha.id];
  assert.deepEqual([se.needs?.kind, se.needsFor ?? null], ['mention', null]);
  assert.equal(needsYouNow(se, 'pn_anyone'), true);
  f.rt.view(f.t.id);
  assert.equal(f.store.state.sessions[f.alpha.id].needs, null);
});
