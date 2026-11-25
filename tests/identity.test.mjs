// The identity seam (#558, prototype): what the load balancer’s signed header must hold before Postbox believes it,
// and how a principal becomes a person.

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { albIdentity } from '../server/identity/alb.mjs';
import { unixPrincipal } from '../server/identity/unix.mjs';
import { People } from '../server/people.mjs';
import { byline, handleFor, peopleFacts, profileEdit } from '../shared/people.mjs';
import { tempDir } from './temp-dirs.mjs';

const SIGNER = 'arn:aws:elasticloadbalancing:us-west-2:111122223333:loadbalancer/app/postbox/50dc6c495c0c9188';
const KID = '0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9';
const pair = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });
const key = pair();
const pem = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
// As the balancer encodes: base64url with its padding kept.
const b64 = (/** @type {object} */ o) => Buffer.from(JSON.stringify(o)).toString('base64').replaceAll('+', '-').replaceAll('/', '_');
function jwt({ header = {}, claims = {}, by = key.privateKey } = {}) {
  const h = b64({ alg: 'ES256', kid: KID, signer: SIGNER, iss: 'https://idp.example', ...header });
  const p = b64({ sub: 'u-1', name: 'Dana Ito', email: 'dana@example.com', exp: Math.floor(Date.now() / 1000) + 120, ...claims });
  return `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), { key: by, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
const identify = albIdentity({ signer: SIGNER, fetchKey: async () => pem });
const req = (/** @type {string | undefined} */ data) => /** @type {any} */ ({ headers: data === undefined ? {} : { 'x-amzn-oidc-data': data } });
const refused = (/** @type {string | undefined} */ data, /** @type {RegExp} */ why) =>
  assert.rejects(identify(req(data)), (e) => e.status === 401 && why.test(e.message));

test('a header the balancer signed is a principal keyed by issuer and subject', async () => {
  const p = await identify(req(jwt()));
  assert.deepEqual(p, {
    provider: 'alb',
    issuer: 'https://idp.example',
    subject: 'u-1',
    username: 'dana@example.com',
    name: 'Dana Ito',
    email: 'dana@example.com',
  });
});

test('a request without the header, or with one that fails any check, is refused', async () => {
  await refused(undefined, /didn’t come through the load balancer/);
  await refused(jwt({ by: pair().privateKey }), /signature doesn’t match/);
  await refused(jwt({ header: { signer: `${SIGNER}x` } }), /different load balancer/);
  await refused(jwt({ header: { alg: 'none' } }), /ES256/);
  await refused(jwt({ header: { alg: 'HS256' } }), /ES256/);
  await refused(jwt({ header: { kid: '../../latest/meta-data' } }), /no valid id/);
  await refused(jwt({ claims: { exp: Math.floor(Date.now() / 1000) - 600 } }), /expired/);
  await refused(jwt({ claims: { sub: '' } }), /no issuer or subject/);
  // Claims swapped under a real signature: the signature covers the payload.
  const [h, , s] = jwt().split('.');
  await refused(`${h}.${b64({ sub: 'admin', exp: 9e9 })}.${s}`, /signature doesn’t match/);
});

test('the unsigned identity header is never believed', async () => {
  await assert.rejects(identify(/** @type {any} */ ({ headers: { 'x-amzn-oidc-identity': 'u-1' } })), /didn’t come through/);
});

test('the local principal is the unix user Postbox runs as', () => {
  const p = unixPrincipal();
  assert.equal(p.provider, 'unix');
  assert.ok(p.username && p.name && p.subject);
});

test('a principal is one person however often it’s seen, and two people never share a handle', () => {
  const people = new People({ dataDir: tempDir('pb-people-'), taken: (h) => h === 'dana', mode: 'alb' });
  const a = people.of({ provider: 'alb', issuer: 'i', subject: '1', username: 'dana@example.com', name: 'Dana', email: 'dana@example.com' });
  const b = people.of({ provider: 'alb', issuer: 'i', subject: '2', username: 'dana', name: 'Other Dana' });
  assert.equal(people.of({ provider: 'alb', issuer: 'i', subject: '1', username: 'renamed', name: 'Renamed' }), a);
  assert.deepEqual([a.handle, b.handle, a.role, b.role], ['dana-2', 'dana-3', 'owner', 'member']); // an agent holds @dana
  // The same subject from another issuer is another person.
  assert.notEqual(people.of({ provider: 'alb', issuer: 'j', subject: '1', username: 'x', name: 'X' }), a);
  assert.equal(new People({ dataDir: join(people.file, '..'), taken: () => false, mode: 'alb' }).list.length, 3);
});

test('a handle is never the reserved one', () => {
  assert.equal(
    handleFor('You', () => false),
    'you-2',
  );
  assert.equal(
    handleFor('Ünï côdé!', () => false),
    'n-c-d',
  );
});

test('with one person who wrote nothing, agents are told nothing new', () => {
  const one = { id: 'pe_1', handle: 'hal', name: 'hal', edited: false };
  assert.equal(byline(one, 1).label, undefined);
  assert.deepEqual(peopleFacts([one]), []);
  assert.equal(byline(one, 2).label, 'hal (@hal)');
  const edited = { ...one, ...profileEdit({ name: 'Hal', pronouns: 'they/them', aliases: [{ kind: 'github', value: 'HJeon139' }] }), edited: true };
  assert.deepEqual(peopleFacts([edited]), ['- Hal (@hal); pronouns: they/them; also written as HJeon139 (github)']);
});

test('a profile takes only its own fields', () => {
  assert.throws(() => profileEdit({ role: 'owner' }), /no “role”/);
  assert.throws(() => profileEdit({ name: ' ' }), /needs a name/);
  assert.equal(/** @type {string} */ (profileEdit({ preferences: 'x'.repeat(5000) }).preferences).length, 2000);
});

test('an agent reads who sent a message when the room names them, and “The person” when it doesn’t', async () => {
  const { entryLine } = await import('../server/turn-input.mjs');
  const e = { id: 'en_1', itemId: 'it_1', source: 'person', from: 'you', at: 0 };
  assert.match(
    entryLine(/** @type {any} */ ({ ...e, fromName: 'Sam Okafor (@sam)' }), () => 'hi'),
    /^\[it_1\] Sam Okafor \(@sam\), 00:00 UTC: hi$/,
  );
  assert.match(
    entryLine(/** @type {any} */ (e), () => 'hi'),
    /^\[it_1\] The person, 00:00 UTC: hi$/,
  );
});

test('seats: an @-mention of a person, from an agent or a person, is an entry in their queue, and a script can fill a seat', async () => {
  const { Seats } = await import('../server/seats.mjs');
  const { ScriptedPerson } = await import('../server/adapters/mock-person.mjs');
  const { Bus } = await import('../server/bus.mjs');
  const people = new People({ dataDir: tempDir('pb-seats-'), taken: () => false, mode: 'alb' });
  const dana = people.of({ provider: 'alb', issuer: 'i', subject: '1', username: 'dana', name: 'Dana' });
  const sam = people.of({ provider: 'alb', issuer: 'i', subject: '2', username: 'sam', name: 'Sam' });
  const riley = people.scripted('Riley Chen');
  /** @type {any[]} */
  const patched = [];
  /** @type {any[]} */
  const sent = [];
  /** @type {(() => void)[]} */
  const later = [];
  const rt = { bus: new Bus(), threads: { patchItem: (...a) => patched.push(a) }, sendMessage: (...a) => sent.push(a) };
  process.env.POSTBOX_MOCK_SPEED = '0';
  new Seats({ rt, people, drivers: { mock: new ScriptedPerson() }, defer: (fn) => later.push(fn) }).listen();
  const say = (/** @type {any} */ item) => {
    rt.bus.emit('item.final', { threadId: 'th_1', item });
    for (const fn of later.splice(0)) fn();
  };

  // An agent asks a person: an entry for her alone, marked on the item for the page.
  say({ id: 'it_1', kind: 'agent', handle: 'indexer', text: '@sam which edition? Not `@dana`, and not mail@dana.example.' });
  assert.deepEqual(
    people.page(sam).queue.map((e) => [e.itemId, e.from, e.source, e.state]),
    [['it_1', '@indexer', 'mention', 'waiting']],
  );
  assert.equal(people.page(dana).queue.length, 0);
  assert.deepEqual(patched[0], ['th_1', 'it_1', { forPeople: [{ id: sam.id, handle: 'sam', name: 'Sam' }] }]);

  // She reads or dismisses only her own; writing in the conversation answers what waited there.
  assert.throws(() => people.settle(dana, people.page(sam).queue[0].id, 'read'), /isn’t in your queue/);
  assert.throws(() => people.settle(sam, people.page(sam).queue[0].id, 'done'), /read or dismissed/);
  people.settle(sam, people.page(sam).queue[0].id, 'dismissed');
  assert.equal(people.page(sam).queue.length, 0);
  say({ id: 'it_2', kind: 'user', by: people.byline(dana), text: '@sam and @dana, see above' }); // her own mention of herself is no entry
  assert.equal(people.page(dana).queue.length, 0);
  assert.equal(people.page(sam).queue[0].from, 'Dana (@dana)');
  people.answered(sam, 'th_1');
  assert.equal(people.page(sam).queue.length, 0);

  // A scripted person’s seat is filled through the adapter’s deliver, and its words go out as a person’s message does.
  say({ id: 'it_3', kind: 'agent', handle: 'indexer', text: '@riley which edition do we keep?' });
  await new Promise((ok) => setTimeout(ok, 20));
  assert.deepEqual(sent, [['th_1', { text: '@indexer keep the 1874 one-volume text, and treat “Introduction” as a preface.', by: people.byline(riley) }]]);
  // And it stops: a script answers a conversation three times at most.
  for (const id of ['it_4', 'it_5', 'it_6', 'it_7']) say({ id, kind: 'agent', handle: 'indexer', text: '@riley and now?' });
  await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(sent.length, 3);
});

test('hosted: the public address is answered only with sign-in, over https', async () => {
  const { frontDoor } = await import('../server/identity/front.mjs');
  assert.deepEqual(frontDoor({}, 4173, 'local'), {
    hosts: ['127.0.0.1:4173', 'localhost:4173'],
    origins: ['http://127.0.0.1:4173', 'http://localhost:4173'],
    secure: false,
  });
  const hosted = frontDoor({ POSTBOX_PUBLIC_ORIGIN: 'https://postbox.example.com', POSTBOX_LISTEN: '0.0.0.0' }, 4173, 'alb');
  assert.deepEqual(
    [hosted.hosts.at(-1), hosted.origins.at(-1), hosted.listen, hosted.secure],
    ['postbox.example.com', 'https://postbox.example.com', '0.0.0.0', true],
  );
  assert.throws(() => frontDoor({ POSTBOX_LISTEN: '0.0.0.0' }, 4173, 'local'), /needs sign-in/);
  assert.throws(() => frontDoor({ POSTBOX_LISTEN: '0.0.0.0' }, 4173, 'alb'), /needs POSTBOX_PUBLIC_ORIGIN/);
  assert.throws(() => frontDoor({ POSTBOX_PUBLIC_ORIGIN: 'http://postbox.example.com' }, 4173, 'alb'), /https origin/);
});

test('the request gate answers the health check, its own addresses and no other, and keeps /mcp and ! on the machine', async () => {
  const { requestGate } = await import('../server/request-gate.mjs');
  const { frontDoor } = await import('../server/identity/front.mjs');
  const req = (/** @type {any} */ o) =>
    /** @type {any} */ ({ method: 'GET', headers: { host: '127.0.0.1:4173' }, socket: { remoteAddress: '127.0.0.1' }, ...o });
  const refused = (/** @type {() => unknown} */ fn, /** @type {number} */ status) => assert.throws(fn, (e) => e.status === status);
  // On this computer, as before: only its own address, and no write from another site.
  const here = requestGate({ port: 4173, host: () => '127.0.0.1' });
  assert.equal(here.admit(req({}), '/api/state'), 'route');
  refused(() => here.admit(req({ headers: { host: 'postbox.example.com' } }), '/'), 421);
  refused(() => here.admit(req({ method: 'POST', headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:9' } }), '/api/threads'), 403);
  here.hereAlone(req({}), '! commands run');
  // Hosted: the public address too, the pod’s health check whatever it’s addressed to, and nothing that runs as the unix user.
  const front = frontDoor({ POSTBOX_PUBLIC_ORIGIN: 'https://postbox.example.com', POSTBOX_LISTEN: '0.0.0.0' }, 4173, 'alb');
  const hosted = requestGate({ port: 4173, host: () => '0.0.0.0', front, local: () => false });
  assert.equal(hosted.admit(req({ headers: { host: '10.0.3.7:4173' } }), '/healthz'), 'health');
  assert.equal(hosted.admit(req({ method: 'POST', headers: { host: 'postbox.example.com', origin: 'https://postbox.example.com' } }), '/api/threads'), 'route');
  refused(() => hosted.admit(req({ headers: { host: 'evil.example.com' } }), '/'), 421);
  refused(() => hosted.admit(req({ method: 'POST', headers: { host: 'postbox.example.com' }, socket: { remoteAddress: '10.0.3.9' } }), '/mcp'), 403);
  refused(() => hosted.hereAlone(req({}), '! commands run'), 403);
  // And on this computer, behind sign-in: still nothing that runs as the unix user for whoever signed in.
  refused(() => requestGate({ port: 4173, host: () => '127.0.0.1', local: () => false }).hereAlone(req({}), '! commands run'), 403);
});
