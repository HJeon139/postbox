// A handle the person chooses (#558, #1742): what follows @ when someone mentions them. An account’s login can hold
// characters a mention can’t (a dot, a space) and isn’t theirs to pick, so the profile has one. With none saved it is
// the login, as before. Agents are told nothing new by it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { People } from '../server/people.mjs';
import { aboutPeople, mentionOf, namesOf, peopleByName, profileOf, senderName } from '../shared/profile.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

const ROBIN = { provider: 'oidc', issuer: 'https://idp.example', subject: 'u-1', username: 'robin.example', name: 'Robin Example' };
const SAM = { ...ROBIN, subject: 'u-2', username: 'sam', name: 'Sam Okafor' };

test('a handle is kept as a mention reads it: without its @, shaped as an agent’s is, and never “you”', () => {
  assert.deepEqual(profileOf({ handle: ' @Robin ' }), { handle: 'Robin' });
  assert.deepEqual(profileOf({ handle: '' }), {}, 'cleared, it is the login again');
  for (const bad of ['robin example', 'r', '9lives', 'robin.example', 'a'.repeat(25)])
    assert.throws(
      () => profileOf({ handle: bad }),
      (/** @type {any} */ e) => e.status === 422 && /A handle is 2–24 letters, digits, - or _, and starts with a letter/.test(e.message),
      bad,
    );
  assert.throws(() => profileOf({ handle: 'You' }), /@you already means whoever a reply answers/);
  // Only text is a handle: a list or a flag isn’t read as its words.
  for (const bad of [['ab'], true, 42]) assert.throws(() => profileOf({ handle: bad }), /A handle is text/);
});

test('what a person is mentioned by: the handle they saved, else their login', () => {
  assert.equal(mentionOf({ username: 'robin.example', profile: {} }), 'robin.example');
  assert.equal(mentionOf({ username: 'robin.example', profile: { handle: 'robin' } }), 'robin');
  // And it names them as a sender when they saved no name.
  const two = { a: { username: 'robin.example', profile: { handle: 'robin' } }, b: { username: 'sam', profile: { name: 'Sam', handle: 'sammy' } } };
  assert.deepEqual([senderName(two, 'a'), senderName(two, 'b')], ['The person robin', 'The person Sam']);
});

test('a saved handle is how a reply reaches its person, where a login with a dot never could', async () => {
  const f = setup();
  const people = new People({ store: f.rt.store });
  const robin = people.seen(people.of(ROBIN));
  const sam = people.seen(people.of(SAM));
  const reply = async (/** @type {string} */ text) => {
    f.adapter.next.push(async (/** @type {any} */ c) => c.text(text));
    f.rt.sendMessage(f.t.id, { text: '@alpha go' }, { id: sam.id });
    await settle(f.rt);
    const se = f.store.state.sessions[f.alpha.id];
    // Read, so the next reply starts from nothing; then Sam is the one with the room open, not Robin.
    f.rt.view(f.t.id, robin.id);
    f.rt.view(f.t.id, sam.id);
    return [se.needs?.kind ?? null, se.needsFor ?? null];
  };
  // “@robin.example” reads as @robin, which is no one.
  assert.deepEqual(await reply('A question for @robin.example and @robin.'), [null, null]);
  people.saveProfile(robin, { handle: 'robin' });
  assert.deepEqual(await reply('A question for @Robin.'), ['mention', [robin.id]]);
  // Their login stays theirs once they have chosen: an agent that learned it earlier in the room still reaches them.
  // Robin has the room open as each lands, so a reply that asks Sam isn’t read at once by Sam’s own view.
  people.saveProfile(sam, { handle: 'sammy' });
  const asksSam = async (/** @type {string} */ text) => {
    f.adapter.next.push(async (/** @type {any} */ c) => c.text(text));
    f.rt.view(f.t.id, robin.id);
    f.rt.sendMessage(f.t.id, { text: '@alpha go' }, { id: robin.id });
    await settle(f.rt);
    const se = f.store.state.sessions[f.alpha.id];
    const got = [se.needs?.kind ?? null, se.needsFor ?? null];
    f.rt.view(f.t.id, sam.id);
    return got;
  };
  assert.deepEqual(await asksSam('A question for @sam.'), ['mention', [sam.id]]);
  assert.deepEqual(await asksSam('A question for @Sammy.'), ['mention', [sam.id]]);
});

test('a name two people have asks both: one who arrives with a login another chose as a handle loses no ask, and neither does the other', async () => {
  const f = setup();
  const people = new People({ store: f.rt.store });
  // Sam has signed in and not yet written, so Postbox doesn’t know them: Robin’s handle is accepted.
  const robin = people.saveProfile(people.of(ROBIN), { handle: 'sam' });
  const sam = people.seen(people.of(SAM));
  assert.deepEqual([namesOf(robin), namesOf(sam)], [['sam', 'robin.example'], ['sam']]);
  assert.deepEqual(peopleByName(f.store.state.people).get('sam'), [robin.id, sam.id]);
  f.adapter.next.push(async (/** @type {any} */ c) => c.text('A question for @sam.'));
  f.rt.sendMessage(f.t.id, { text: '@alpha go' });
  await settle(f.rt);
  const se = () => f.store.state.sessions[f.alpha.id];
  assert.deepEqual([se().needs?.kind, se().needsFor], ['mention', [robin.id, sam.id]]);
  // Each reads it for themselves, and it waits for the other.
  f.rt.view(f.t.id, sam.id);
  assert.deepEqual([se().needs?.kind, se().needsFor], ['mention', [robin.id]]);
  f.rt.view(f.t.id, robin.id);
  assert.equal(se().needs ?? null, null);
  // A name an agent has is the agent’s, whoever else has it.
  assert.equal(peopleByName(f.store.state.people, ['Sam']).has('sam'), false);
});

test('a handle that is an agent’s, or another person’s handle or login, is refused, and the profile kept is the one before', () => {
  const f = setup();
  const people = new People({ store: f.rt.store });
  const robin = people.seen(people.of(ROBIN));
  people.saveProfile(people.of(SAM), { handle: 'sammy' });
  const refused = (/** @type {string} */ handle, /** @type {RegExp} */ why) =>
    assert.throws(
      () => people.saveProfile(robin, { name: 'Robin', handle }),
      (/** @type {any} */ e) => e.status === 422 && why.test(e.message),
      handle,
    );
  refused('Alpha', /@Alpha is an agent’s name here/);
  refused('SAMMY', /@SAMMY is how someone else here is mentioned/);
  refused('sam', /@sam is how someone else here is mentioned/);
  assert.deepEqual(people.known(ROBIN).profile, {});
  // A retired agent’s name is free, to a person as to a new agent.
  f.store.emit('persona', { ...f.b, id: 'pe_retired', handle: 'oldbot', retired: true });
  assert.equal(people.saveProfile(robin, { handle: 'oldbot' }).profile.handle, 'oldbot');
  // Their own, saved again, is theirs.
  people.saveProfile(robin, { handle: 'robin' });
  assert.deepEqual(people.saveProfile(robin, { handle: 'Robin', name: 'Robin' }).profile, { handle: 'Robin', name: 'Robin' });
});

test('an agent can’t be made with a handle a person chose, and may share a login, which is then the agent’s', () => {
  const f = setup();
  const people = new People({ store: f.rt.store });
  people.saveProfile(people.of(ROBIN), { handle: 'robby' });
  people.seen(people.of(SAM));
  assert.throws(
    () => f.rt.createPersona({ handle: 'Robby' }),
    (/** @type {any} */ e) => e.status === 409 && e.message === '@Robby is the handle a person here chose. Pick another name.',
  );
  assert.equal(f.rt.createPersona({ handle: 'sam' }).handle, 'sam');
  assert.equal(peopleByName(f.store.state.people, f.rt.personas.handles()).has('sam'), false);
});

test('agents are told nothing new: a handle is in no turn’s note about the person', () => {
  assert.equal(aboutPeople([{ profile: { handle: 'robin' } }]), null);
  assert.doesNotMatch(String(aboutPeople([{ profile: { name: 'Robin', handle: 'robin' } }])), /handle|@robin/i);
});
