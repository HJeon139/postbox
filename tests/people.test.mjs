// The local person (#558): the account Postbox runs as, made a person once, with its name as a default that is kept
// and shown to them, and never told to an agent until they save a profile.

import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { test } from 'node:test';
import { createIdentity } from '../server/identity/index.mjs';
import { unixAccount } from '../server/identity/unix.mjs';
import { People } from '../server/people.mjs';
import { needsYouNow } from '../shared/needs.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

/** A fixture account: nothing here reads the computer’s own. */
const ROBIN = { provider: 'unix', issuer: 'unix:fixture', subject: 'robin', username: 'robin', name: 'Robin Example' };

async function turn({ rt, t, adapter }, text = '@alpha hello') {
  rt.sendMessage(t.id, { text });
  await settle(rt);
  return adapter.calls.at(-1).message.text;
}

test('who is asking is the provider’s answer: the computer’s account by default, a fixture’s when one is given', async () => {
  const real = await createIdentity().identify(/** @type {any} */ ({ headers: {} }));
  assert.ok(real.provider === 'unix' && real.username && real.name && real.subject && real.issuer.startsWith('unix:'));
  // The same person whatever the computer is called today, and on an account the system has no entry for.
  assert.equal(real.issuer.includes(hostname()), false, 'the issuer names no computer');
  const bare = unixAccount({
    info: () => {
      throw new Error('uv_os_get_passwd returned ENOENT');
    },
  });
  assert.ok(bare.username && bare.name && bare.subject && bare.issuer === real.issuer);
  // Nothing a request carries changes the answer: no header, and no body, names a person.
  const fixture = createIdentity({ account: ROBIN });
  assert.deepEqual(await fixture.identify(/** @type {any} */ ({ headers: { 'x-person': 'mallory', 'x-amzn-oidc-identity': 'mallory' } })), ROBIN);
  assert.throws(() => createIdentity({ provider: 'header' }), /no way to tell who is asking called “header”/);
});

test('a principal is one person on every request, and asking writes nothing: the record is kept from their first save', () => {
  const { rt } = setup();
  const people = new People({ store: rt.store });
  const seq = rt.store.state.seq;
  const seen = people.of(ROBIN);
  assert.deepEqual(seen, {
    id: seen.id,
    identity: { provider: 'unix', issuer: 'unix:fixture', subject: 'robin' },
    username: 'robin',
    name: 'Robin Example',
    profile: {},
  });
  assert.match(seen.id, /^pn_[\w-]{16}$/);
  // A read stays a read: no event, and nothing in the state, however often they’re seen.
  assert.equal(people.of(ROBIN).id, seen.id);
  assert.deepEqual([rt.store.state.seq, people.known(ROBIN), Object.keys(rt.store.state.people)], [seq, null, []]);
  // Their first save keeps the record, under the same id, with the provider’s name as it was then.
  const saved = people.saveProfile(seen, { pronouns: 'they/them' });
  assert.deepEqual([saved.id, saved.name, saved.profile, rt.store.state.seq], [seen.id, 'Robin Example', { pronouns: 'they/them' }, seq + 1]);
  assert.ok(saved.createdAt > 0);
  // Once kept it is theirs: the provider renaming them changes nothing.
  assert.equal(people.of({ ...ROBIN, name: 'Renamed' }).name, 'Robin Example');
  // Another subject, or the same subject from another issuer, is another person.
  assert.notEqual(people.of({ ...ROBIN, subject: 'sam' }).id, seen.id);
  assert.notEqual(people.of({ ...ROBIN, issuer: 'unix:elsewhere' }).id, seen.id);
});

test('a fresh install tells agents nothing of the person: the provider’s name is kept for them, not told', async () => {
  const room = setup();
  const bare = await turn(room);
  const named = setup();
  const who = new People({ store: named.rt.store });
  // Seen, and kept with nothing saved: neither tells an agent anything.
  who.saveProfile(who.of(ROBIN), {});
  const shape = (/** @type {string} */ s) => s.replace(/\[it_[\w-]+\]/g, '[it]').replace(/\d\d:\d\d UTC/g, 'hh:mm UTC');
  const text = await turn(named);
  assert.equal(shape(text), shape(bare));
  assert.doesNotMatch(text, /Robin|About the pe/);
});

test('what a person saves is what agents are told, the sender still reads “The person”, and a bad profile changes nothing', async () => {
  const room = setup();
  const people = new People({ store: room.rt.store });
  const person = people.of(ROBIN);
  const saved = people.saveProfile(person, { name: 'Robin', pronouns: 'they/them' });
  assert.deepEqual([saved.id, saved.name, saved.profile], [person.id, 'Robin Example', { name: 'Robin', pronouns: 'they/them' }]);
  const text = await turn(room, '@alpha after a profile');
  assert.ok(
    text.includes('[Postbox] About the person, from the profile they saved in Settings (not said in this conversation):\n- Name: Robin\n- Pronouns: they/them'),
    text,
  );
  assert.match(text, /\] The person, \d\d:\d\d UTC: @alpha after a profile/);
  assert.doesNotMatch(text, /Robin Example/, 'the provider’s name isn’t told');
  // Refused whole: the profile kept is the one before.
  assert.throws(
    () => people.saveProfile(person, { name: 'Robin', admin: true }),
    (e) => e.status === 422,
  );
  assert.deepEqual(people.known(ROBIN).profile, { name: 'Robin', pronouns: 'they/them' });
  // Cleared, agents are told nothing again, and the default is still theirs to see.
  people.saveProfile(person, {});
  assert.doesNotMatch(await turn(room, '@alpha again'), /About the pe/);
  assert.equal(people.known(ROBIN).name, 'Robin Example');
});

test('the same tooling holds more than one person: each saves their own profile, and a turn says who each is', async () => {
  const room = setup();
  const people = new People({ store: room.rt.store });
  const robin = people.of(ROBIN);
  const sam = people.of({ ...ROBIN, issuer: 'https://idp.example', subject: 'u-2', username: 'sam', name: 'Sam Okafor' });
  people.saveProfile(robin, { name: 'Robin' });
  people.saveProfile(sam, { name: 'Sam', pronouns: 'he/him' });
  assert.deepEqual([people.known(ROBIN).profile, room.rt.store.state.people[sam.id].profile], [{ name: 'Robin' }, { name: 'Sam', pronouns: 'he/him' }]);
  const text = await turn(room);
  assert.ok(
    text.includes(
      '[Postbox] About the people here, each from the profile they saved in Settings (not said in this conversation):\n- Name: Robin\n\n- Name: Sam\n- Pronouns: he/him',
    ),
    text,
  );
});

test('#1742 on this computer the data folder’s one person is the same under any account, and a record kept under an old uid is still theirs', () => {
  const account = (/** @type {number} */ uid, /** @type {string} */ username) => unixAccount({ info: /** @type {any} */ (() => ({ uid, username })) });
  const [first, second] = [account(501, 'robin'), account(1000, 'svc-postbox')];
  assert.deepEqual([first.subject, first.issuer, first.sole], [second.subject, second.issuer, true]);
  assert.equal(first.subject.includes('501'), false, 'nothing of the account is who they are');
  const { rt } = setup();
  const people = new People({ store: rt.store });
  assert.equal(people.of(first).id, people.of(second).id, 'one person before anything is kept');
  // A record as #1737 kept it, under the account’s uid: found from any account, with its id, its profile and its needs.
  const old = { ...first, subject: '501', sole: undefined };
  const kept = people.saveProfile(people.of(old), { name: 'Robin' });
  assert.notEqual(kept.id, people.of({ ...first, subject: 'the-person', sole: undefined }).id, 'its id is the old one');
  for (const who of [first, second]) assert.deepEqual([people.of(who).id, people.of(who).profile], [kept.id, { name: 'Robin' }]);
  // What was stamped for them before still rings them, from the other account.
  assert.equal(needsYouNow({ needs: { kind: 'failed' }, needsFor: [kept.id] }, people.of(second).id), true);
  // Saving and sending from the other account write the same record, never a second person.
  people.saveProfile(people.of(second), { name: 'Robin E.' });
  people.seen(people.of(second));
  assert.deepEqual(Object.keys(rt.store.state.people), [kept.id]);
  // A provider that answers with many people still tells them apart by subject.
  assert.notEqual(people.of({ ...ROBIN, subject: 'sam' }).id, people.of(ROBIN).id);
});

test('#1742 two records already kept under two accounts: the first kept is the local person, and no other issuer’s record is', () => {
  const local = unixAccount({ info: /** @type {any} */ (() => ({ uid: 2000, username: 'robin' })) });
  const { rt } = setup();
  const people = new People({ store: rt.store });
  const keep = (/** @type {any} */ principal, /** @type {number} */ createdAt) => {
    const record = { ...people.of({ ...principal, sole: undefined }), createdAt };
    rt.store.emit('person', record);
    return record;
  };
  // Kept out of order, and beside an older record of another issuer: the oldest of the local issuer’s own is theirs.
  const newer = keep({ ...local, subject: '1000' }, 2000);
  const older = keep({ ...local, subject: '501' }, 1000);
  const elsewhere = keep({ ...ROBIN, issuer: 'https://idp.example' }, 500);
  assert.equal(people.of(local).id, older.id);
  assert.notEqual(newer.id, older.id);
  assert.notEqual(people.of(local).id, elsewhere.id);
});
