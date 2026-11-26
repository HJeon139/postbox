// A mention of a person is a “needs you” for them (#1742): the last reply of an agent’s turn that names a person by
// user name, or says @you to the person it answers, makes the agent need that person, until they read it. A reply to
// another agent that says @you stops at that agent, and one that names a person reaches them from anywhere.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { RANK, TURN_TIED } from '../server/card-needs.mjs';
import { start } from '../server/index.mjs';
import { People } from '../server/people.mjs';
import { needsYouNow } from '../shared/needs.mjs';
import * as arrange from './arrange.mjs';
import { fakeRequest, NAVIGATION } from './fake-http.mjs';
import { settle, setup } from './side-threads-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

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
  const asked = (se = f.alpha) => (f.store.state.sessions[se.id].asked ?? []).map((/** @type {any} */ a) => a.for);
  return { ...f, people, robin, sam, say, need, asked };
}
const replies = (/** @type {any} */ f, /** @type {string[]} */ ...texts) =>
  f.adapter.next.push(async (/** @type {any} */ c) => {
    for (const text of texts) await c.text(text);
  });
const lastReply = (/** @type {any} */ f) => f.store.items(f.t.id).findLast((/** @type {any} */ i) => i.kind === 'agent');

test('a mention is a kind of need, ranked last, and only reading ends it: it isn’t tied to the person moving on', () => {
  assert.equal(RANK.mention, Math.max(...Object.values(RANK)));
  assert.equal(TURN_TIED.has('mention'), false);
});

test('@you in a reply to a person asks that person, by the sender on their message, and their writing there reads it', async () => {
  const f = room();
  replies(f, 'Done. @you should look at the totals.');
  await f.say('@alpha check the totals');
  assert.deepEqual(f.need(), ['mention', [f.robin.id], 'needs']);
  const se = f.store.state.sessions[f.alpha.id];
  assert.deepEqual([needsYouNow(se, f.robin.id), needsYouNow(se, f.sam.id)], [true, false]);
  assert.deepEqual([lastReply(f).asks, f.asked()], [[f.robin.id], [[f.robin.id]]]);
  replies(f, 'You’re welcome.');
  await f.say('@alpha thanks');
  assert.deepEqual([f.need(), f.asked()], [[null, null, 'idle'], []]);
});

test('@you is the person the turn answers, not whoever wrote last in the room, and another person having it open doesn’t read it', async () => {
  const f = room();
  // Robin asks alpha. While it works, Sam writes in the room and has it open; alpha ends with @you.
  f.adapter.next.push(async (/** @type {any} */ c) => {
    arrange.post(f.rt, f.t.id, { kind: 'user', text: 'A note from Sam', personId: f.sam.id, to: [] });
    f.rt.threads.patch(f.t.id, { lastPerson: f.sam.id });
    f.rt.view(f.t.id, f.sam.id);
    await c.text('Done, @you can look.');
  });
  await f.say('@alpha go');
  assert.deepEqual(f.need(), ['mention', [f.robin.id], 'needs']);
  assert.equal(lastReply(f).asksSeen, undefined);
  // And it names both when it says both.
  replies(f, 'Thanks @you! And @robin should see this too.');
  await f.say('@alpha one more', f.sam);
  assert.deepEqual(new Set(lastReply(f).asks), new Set([f.robin.id, f.sam.id]));
  // Sam has the room open, so Sam has read it; it still waits for Robin, who hasn’t.
  assert.deepEqual([f.need(), lastReply(f).asksRead, lastReply(f).asksSeen], [['mention', [f.robin.id], 'needs'], [f.sam.id], undefined]);
  f.rt.view(f.t.id, f.robin.id);
  assert.deepEqual([f.need(), lastReply(f).asksSeen], [[null, null, 'idle'], true]);
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

test('only a turn’s last reply asks: a mention before more work is narration', () => {
  const f = room();
  // A turn whose reply is in parts, as it is when a step and another agent’s message come between its words.
  const turn = { id: 'tu_parts', summarizeTo: null };
  const real = f.rt.running.turnFor.bind(f.rt.running);
  f.rt.running.turnFor = () => /** @type {any} */ (turn);
  const part = (/** @type {string} */ text) =>
    arrange.post(f.rt, f.t.id, { kind: 'agent', sessionId: f.alpha.id, handle: 'alpha', text, status: 'done', turnId: turn.id }).id;
  const marks = (/** @type {string[]} */ ids) => ids.map((id) => f.store.item(f.t.id, id).asks ?? null);
  try {
    const narrated = [part('I will tell @sam when done.'), part('All done.')];
    assert.deepEqual([marks(narrated), f.asked()], [[null, null], []], 'the mark came off the earlier part');
    const asked = [part('Working on it.'), part('Done, @sam can look.')];
    assert.deepEqual([marks(asked), f.asked()], [[null, [f.sam.id]], [[f.sam.id]]]);
  } finally {
    f.rt.running.turnFor = real;
  }
});

test('what names no person asks no one: a quote, a copied line, an unknown name, the agent’s own handle, a person named you', async () => {
  const f = room();
  replies(f, '> @sam said so\n\nNoted, and @nobody agrees. I am @alpha.');
  const sent = await f.say('@alpha note it');
  assert.deepEqual(f.need(), [null, null, 'idle']);
  // A line copied from the conversation, as read_conversation gives it, names no one anew.
  assert.ok(sent.id);
  const noted = arrange.post(f.rt, f.t.id, { kind: 'agent', sessionId: f.beta.id, handle: 'beta', text: 'Ask @sam about it.', status: 'done' });
  replies(f, `The room says:\n[${noted.id}] @beta: Ask @sam about it.`);
  await f.say('@alpha what does the room say');
  assert.deepEqual(f.need(), [null, null, 'idle']);
  // Someone whose user name is “you” isn’t whom @you means in a reply to an agent.
  f.people.seen(f.people.of({ ...ROBIN, subject: 'u-9', username: 'you', name: 'Yu' }));
  replies(f, '@beta please check this.');
  replies(f, 'Checked, @you can go on.');
  await f.say('@alpha hand it on');
  assert.deepEqual(f.need(f.beta), [null, null, 'idle']);
});

test('an agent’s handle wins over a person’s user name that matches it: a mention of it wakes the agent and asks no person', async () => {
  const f = room();
  const named = f.people.seen(f.people.of({ ...ROBIN, subject: 'u-7', username: 'beta', name: 'Beta Tester' }));
  replies(f, 'Over to @beta now.');
  replies(f, 'Taken.');
  await f.say('@alpha hand it on');
  assert.deepEqual(f.need(), [null, null, 'idle']);
  assert.equal(lastReply(f).handle, 'beta', 'the agent was woken, as before');
  for (const s of Object.values(f.store.state.sessions)) assert.notDeepEqual(/** @type {any} */ (s).needsFor, [named.id]);
});

test('a stopped reply, one mirrored from a terminal, and a summary’s turn ask no one', async () => {
  const f = room();
  const turn = { id: 'tu_x', summarizeTo: null };
  const live = f.rt.running;
  const real = live.turnFor.bind(live);
  live.turnFor = () => turn;
  const post = (/** @type {object} */ more) =>
    arrange.post(f.rt, f.t.id, { kind: 'agent', sessionId: f.alpha.id, handle: 'alpha', text: 'Over to @sam.', status: 'done', turnId: 'tu_x', ...more });
  try {
    assert.equal(post({ status: 'stopped' }).asks, undefined);
    assert.equal(f.store.items(f.t.id).at(-1).asks, undefined);
    post({ via: 'terminal' });
    assert.equal(f.store.items(f.t.id).at(-1).asks, undefined);
    turn.summarizeTo = /** @type {any} */ ('th_x');
    post({});
    assert.equal(f.store.items(f.t.id).at(-1).asks, undefined);
    // The same reply from a turn of its own asks.
    turn.summarizeTo = null;
    post({});
    assert.deepEqual(f.store.items(f.t.id).at(-1).asks, [f.sam.id]);
  } finally {
    live.turnFor = real;
  }
});

test('reading it clears it: the person it is for, in the room it is in, and not another person or another room', async () => {
  const f = room();
  const other = f.rt.createThread({ projectId: 'p1', title: 'Elsewhere', personaIds: [f.c.id] });
  replies(f, 'A question for @sam: which region?');
  await f.say('@alpha ask Sam');
  assert.deepEqual(f.need(), ['mention', [f.sam.id], 'needs']);
  f.rt.view(f.t.id, f.robin.id);
  assert.deepEqual(f.need(), ['mention', [f.sam.id], 'needs'], 'Robin reading it isn’t Sam reading it');
  f.rt.view(other.id, f.sam.id);
  assert.deepEqual(f.need(), ['mention', [f.sam.id], 'needs'], 'Sam in another room hasn’t read it');
  f.rt.view(f.t.id);
  assert.deepEqual(f.need(), ['mention', [f.sam.id], 'needs'], 'a view Postbox can’t name isn’t Sam’s');
  f.rt.view(f.t.id, f.sam.id);
  assert.deepEqual([f.need(), f.asked(), lastReply(f).asksSeen], [[null, null, 'idle'], [], true]);
});

test('another person’s next message doesn’t drop an ask its person hasn’t read', async () => {
  const f = room();
  replies(f, 'A question for @sam: which region?');
  await f.say('@alpha ask Sam');
  replies(f, 'On it.');
  await f.say('@alpha thanks, meanwhile do the totals');
  // Robin moved on and alpha ran another turn, which asks no one: Sam’s ask is still unread, and alpha still needs Sam.
  assert.deepEqual([f.need(), f.asked()], [['mention', [f.sam.id], 'needs'], [[f.sam.id]]]);
  assert.equal(f.store.items(f.t.id).find((/** @type {any} */ i) => i.asks?.length).asksSeen, undefined);
});

test('an ask behind a block is read with it: answering the block leaves nothing to ring in the room you have open', async () => {
  const f = room();
  replies(f, 'Pick one, @you.');
  await f.say('@alpha go');
  const ask = lastReply(f);
  // A block of the same turn comes first as the need, and the room is open.
  const block = arrange.post(f.rt, f.t.id, {
    kind: 'block',
    sessionId: f.alpha.id,
    handle: 'alpha',
    turnId: ask.turnId,
    valid: true,
    block: { id: 'b1', type: 'confirm', statement: 'Go on?' },
  });
  f.rt.sessions.update(f.alpha.id, { needs: { kind: 'block', itemId: block.id, text: 'Go on?' }, state: 'needs' });
  f.rt.view(f.t.id, f.robin.id);
  assert.equal(f.store.item(f.t.id, ask.id).asksSeen, true, 'read though it isn’t the need');
  arrange.setItem(f.rt, f.t.id, block.id, { answered: true });
  f.rt.turnService.asks.releaseNeed(f.store.state.sessions[f.alpha.id], block.id);
  assert.deepEqual(f.need(), [null, null, 'idle']);
});

test('a mention that lands while its person has the room open is read already, and asks nothing', async () => {
  const f = room();
  f.rt.view(f.t.id, f.robin.id);
  replies(f, 'Done, @you can look.');
  await f.say('@alpha go');
  assert.deepEqual([f.need(), f.asked()], [[null, null, 'idle'], []]);
  // Open by someone else, it still waits for the one it names.
  f.rt.view(f.t.id, f.robin.id);
  replies(f, 'And @sam should see this.');
  await f.say('@alpha go on');
  assert.deepEqual(f.need(), ['mention', [f.sam.id], 'needs']);
});

test('with no person known, @you in a reply to the person still asks, for whoever looks, and any view reads it', async () => {
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

// The route, called with fake requests (start({ listen: false })), with a fixture person as the computer’s account.
const PORT = 4477;
/** @type {any} */
let app;
before(async () => {
  const dir = tempDir('pb-mentions-');
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: true, quiet: true, claudeHome: dir, listen: false, account: ROBIN });
});
after(async () => {
  await app.close();
});

test('POST a view: who has the room open is who is asking, so their view reads what was asked of them and no one else’s', async () => {
  const call = (/** @type {any} */ r) => fakeRequest(app.handle, { host: `127.0.0.1:${PORT}`, ...r });
  const cookie = (await call({ path: '/', headers: NAVIGATION })).headers['set-cookie'].split(';')[0];
  const me = (await call({ path: '/api/state' })).json.config.me;
  const { rt } = app;
  const [threadId] = Object.keys(rt.s.threads);
  const [se] = arrange.sessionsIn(rt, threadId);
  const ask = (/** @type {string} */ who) =>
    arrange.post(rt, threadId, { kind: 'agent', sessionId: se.id, handle: se.handle, text: 'A question.', status: 'done', asks: [who] });
  const [forMe, forSam] = [ask(me.id), ask('pn_sam')];
  rt.sessions.update(se.id, { asked: [forMe, forSam].map((it) => ({ itemId: it.id, threadId, for: it.asks })) });
  const viewed = await call({ method: 'POST', path: `/api/threads/${threadId}/view`, body: { personId: 'pn_sam' }, headers: { cookie } });
  assert.equal(viewed.status, 200);
  const seen = (/** @type {any} */ it) => rt.store.item(threadId, it.id).asksSeen ?? false;
  assert.deepEqual([seen(forMe), seen(forSam)], [true, false]);
});

test('one rule for “it asked a person”: the notice follows the need, so a reply to an agent or a quote raises none', async () => {
  const f = room();
  /** @type {any[]} */
  const heard = [];
  f.rt.store.subscribe((/** @type {any} */ ev) => ev.type === 'notify' && heard.push([ev.data.level, ev.data.title, ev.data.for ?? null]));
  replies(f, 'Done, @you can look.');
  await f.say('@alpha go');
  assert.deepEqual(heard, [['info', '@alpha mentioned you', [f.robin.id]]]);
  heard.length = 0;
  replies(f, '> as @you said\n\nNoted.');
  await f.say('@alpha note it');
  assert.equal(heard.filter(([, title]) => /mentioned you/.test(title)).length, 0);
});
