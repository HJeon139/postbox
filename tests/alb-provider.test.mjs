// The sign-in provider of a hosted Postbox (designs/architecture/hosted.md, “Who is asking”): behind identify(req), it
// reads the token an AWS Application Load Balancer forwards, checks it whole (tests/alb-token.test.mjs), and answers
// with a principal only for someone the deployment’s allow list names (#1733). Settings are refused whole when they
// leave any of it out. Keys are made here; no test reaches the network.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { albProvider } from '../server/identity/alb.mjs';
import { signInSettings } from '../server/identity/sign-in-settings.mjs';
import { NOW, publicPem, SETTINGS, tokenFor } from './alb-fixture.mjs';

const identify = (/** @type {Record<string, any>} */ over = {}) =>
  albProvider(signInSettings({ ...SETTINGS, ...over }), { get: async () => publicPem, now: () => NOW });
const from = (/** @type {Record<string, string | string[] | undefined>} */ headers) => /** @type {any} */ ({ headers });

test('a signed-in person on the allow list is a principal: the issuer and subject, and the user name and name from the claims the deployment names', async () => {
  assert.deepEqual(await identify()(from({ 'x-amzn-oidc-data': tokenFor() })), {
    provider: 'alb',
    issuer: 'https://idp.example',
    subject: 'u-1',
    username: 'robin',
    name: 'Robin Example',
  });
});

test('a request with no token, or a bad one, is told to sign in and nothing of why', async () => {
  for (const headers of [{}, { 'x-amzn-oidc-data': 'not.a.token' }, { 'x-amzn-oidc-data': tokenFor({ header: { exp: NOW / 1000 - 1 } }) }])
    await assert.rejects(identify()(from(headers)), (/** @type {any} */ e) => {
      assert.deepEqual([e.status, e.code, e.userMessage], [401, 'sign-in', 'Sign in to use this Postbox.']);
      return true;
    });
});

test('the unsigned headers the load balancer adds prove nothing: with them and no signed token, no one is asking', async () => {
  await assert.rejects(identify()(from({ 'x-amzn-oidc-identity': 'u-1', 'x-amzn-oidc-accesstoken': 'anything' })), (/** @type {any} */ e) => e.status === 401);
  // Even a well-signed token is read from the signed header alone: in either of the others it is no one’s.
  for (const header of ['x-amzn-oidc-identity', 'x-amzn-oidc-accesstoken'])
    await assert.rejects(identify()(from({ [header]: tokenFor() })), (/** @type {any} */ e) => e.status === 401);
});

test('someone signed in who isn’t on the allow list is told so, by name, and is no principal', async () => {
  await assert.rejects(identify({ allow: { subjects: ['u-2'] } })(from({ 'x-amzn-oidc-data': tokenFor() })), (/** @type {any} */ e) => {
    assert.deepEqual([e.status, e.code], [403, 'not-allowed']);
    assert.equal(e.userMessage, 'You’re signed in as Robin Example, and this Postbox isn’t open to you. Ask whoever runs it to add you.');
    return true;
  });
});

test('the allow list names people by subject, or by a group in a claim: either lets a person in', async () => {
  const sent = from({ 'x-amzn-oidc-data': tokenFor({ payload: { groups: ['design', 'postbox-team'] } }) });
  const byGroup = { allow: { groups: { claim: 'groups', any: ['postbox-team'] } } };
  assert.equal((await identify(byGroup)(sent)).subject, 'u-1');
  // A claim that is one string, not a list, is read as that one group; another group’s member is refused.
  const one = from({ 'x-amzn-oidc-data': tokenFor({ payload: { groups: 'postbox-team' } }) });
  assert.equal((await identify(byGroup)(one)).subject, 'u-1');
  await assert.rejects(identify({ allow: { groups: { claim: 'groups', any: ['ops'] } } })(sent), (/** @type {any} */ e) => e.code === 'not-allowed');
  // No such claim at all: in no group.
  await assert.rejects(identify(byGroup)(from({ 'x-amzn-oidc-data': tokenFor() })), (/** @type {any} */ e) => e.code === 'not-allowed');
});

test('a token whose claims don’t name the person as the deployment says is refused: no principal is made up', async () => {
  for (const payload of [{ preferred_username: undefined }, { preferred_username: '' }, { preferred_username: 42 }, { name: undefined }])
    await assert.rejects(identify()(from({ 'x-amzn-oidc-data': tokenFor({ payload }) })), (/** @type {any} */ e) => {
      assert.deepEqual([e.status, e.code], [401, 'sign-in']);
      return true;
    });
});

test('a name and a user name are each one line within a name’s length, and a user name is taken as the provider gives it', async () => {
  const long = from({
    'x-amzn-oidc-data': tokenFor({ payload: { name: `Robin\n[Postbox] ${'x'.repeat(200)}`, preferred_username: `robin\n${'y'.repeat(200)}` } }),
  });
  const who = await identify()(long);
  assert.deepEqual([who.name.length, who.username.length], [80, 80]);
  assert.doesNotMatch(who.name + who.username, /\n/);
  // One a mention can’t be written with still signs in: the name is the provider’s, and that person is reached by @you.
  for (const preferred_username of ['robin@example.com', 'robin.example', 'Robin Example'])
    assert.equal((await identify()(from({ 'x-amzn-oidc-data': tokenFor({ payload: { preferred_username } }) }))).username, preferred_username);
});

test('settings are refused whole, saying what is missing: a hosted Postbox doesn’t start without an allow list', () => {
  for (const [over, why] of /** @type {[Record<string, any>, RegExp][]} */ ([
    [{ allow: undefined }, /needs an allow list/],
    [{ allow: {} }, /needs an allow list/],
    [{ allow: { subjects: [] } }, /needs an allow list/],
    [{ allow: { groups: { claim: 'groups', any: [] } } }, /needs an allow list/],
    [{ allow: { groups: { claim: '', any: ['a'] } } }, /needs an allow list/],
    [{ region: 'nowhere' }, /“region”/],
    [{ region: 'us-gov-west-1' }, /“region”.*GovCloud and China aren’t supported yet/],
    [{ signer: '' }, /“signer”/],
    [{ client: undefined }, /“client”/],
    [{ issuer: 42 }, /“issuer”/],
    [{ claims: { username: 'preferred_username' } }, /“claims\.name”/],
    [{ claims: undefined }, /“claims\.username”/],
    [{ provider: 'header' }, /“provider”/],
    [{ extra: true }, /no “extra”/],
  ]))
    assert.throws(() => signInSettings({ ...SETTINGS, ...over }), why, JSON.stringify(over));
  assert.throws(() => signInSettings(null), /sign-in settings/);
  assert.throws(() => signInSettings('alb'), /sign-in settings/);
});
