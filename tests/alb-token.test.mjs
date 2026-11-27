// The sign-in check of a hosted Postbox (designs/architecture/hosted.md, “Who is asking”, “The check, whole”): the
// token an AWS Application Load Balancer forwards is a person’s only when every part of the check holds. Each part has
// a test that fails without it. Keys are made here, and no test reaches the network.

import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { checkAlbToken } from '../server/identity/alb-token.mjs';

const KID = '12345678-1234-1234-1234-123456789012';
const DEPLOYMENT = {
  signer: 'arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/postbox/50dc6c495c0c9188',
  client: 'postbox-client',
  issuer: 'https://idp.example',
};
const NOW = Date.parse('2026-11-27T12:00:00Z');
const p256 = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = (/** @type {import('node:crypto').KeyObject} */ key) => /** @type {string} */ (key.export({ type: 'spki', format: 'pem' }));

/** Base64url with its padding kept, as the load balancer writes a token’s parts. */
const part = (/** @type {unknown} */ value) => Buffer.from(JSON.stringify(value)).toString('base64').replaceAll('+', '-').replaceAll('/', '_');

/**
 * A token as the load balancer makes one: its header says who signed it, for whom and until when, and its payload is
 * the person’s claims. `header` and `payload` change or drop a field (undefined drops it).
 */
function token({ header = {}, payload = {}, key = p256.privateKey, hash = 'SHA256' } = {}) {
  const h = { alg: 'ES256', kid: KID, signer: DEPLOYMENT.signer, iss: DEPLOYMENT.issuer, client: DEPLOYMENT.client, exp: NOW / 1000 + 120, ...header };
  const p = { sub: 'u-1', name: 'Robin Example', email: 'robin@example.com', ...payload };
  const signed = `${part(h)}.${part(p)}`;
  const signature = createSign(hash).update(signed).sign({ key, dsaEncoding: 'ieee-p1363' });
  return `${signed}.${signature.toString('base64').replaceAll('+', '-').replaceAll('/', '_')}`;
}

/** The check, with this deployment’s settings and a key source that knows the one key. */
const check = (/** @type {string | undefined} */ sent, /** @type {Record<string, any>} */ over = {}) =>
  checkAlbToken(sent, { ...DEPLOYMENT, now: () => NOW, keyOf: async () => pem(p256.publicKey), ...over });

/** Refused, for the reason named, and with nothing in what a person is shown but “sign in”. */
const refused = (/** @type {Promise<unknown>} */ run, /** @type {string} */ why) =>
  assert.rejects(run, (/** @type {any} */ e) => {
    assert.equal(e.code, why);
    assert.deepEqual([e.status, e.userMessage], [401, 'Sign in to use this Postbox.']);
    return true;
  });

test('a token the load balancer signed for this Postbox is its person: the issuer and subject, and the claims as given', async () => {
  assert.deepEqual(await check(token()), {
    issuer: 'https://idp.example',
    subject: 'u-1',
    claims: { sub: 'u-1', name: 'Robin Example', email: 'robin@example.com' },
  });
  // The parts keep their padding, which a strict base64url decoder refuses: this token’s header and payload end in “=”.
  assert.match(token().split('.')[0] + token().split('.')[1], /=/);
});

test('no token, or one that isn’t three parts of JSON, is no one', async () => {
  for (const sent of [undefined, '', 'abc', 'a.b', 'a.b.c.d', `${part({ alg: 'ES256' })}.not-json!.sig`, `${part('a string')}.${part({})}.sig`])
    await refused(check(sent), 'malformed');
  // A header that came twice reaches Node as one string joined by a comma: not a token.
  await refused(check(`${token()}, ${token()}`), 'malformed');
  // An array is JSON but not a header, and a part outside base64url’s alphabet isn’t a part.
  for (const sent of [`${part([1])}.${part({})}.sig`, ` ${token()}`]) await refused(check(sent), 'malformed');
});

test('the algorithm is ES256 whatever the token says: none, a symmetric one and another curve’s are refused before any key is fetched', async () => {
  let fetched = 0;
  const keyOf = async () => {
    fetched++;
    return pem(p256.publicKey);
  };
  for (const alg of ['none', 'HS256', 'ES384', 'RS256', undefined]) await refused(check(token({ header: { alg } }), { keyOf }), 'algorithm');
  assert.equal(fetched, 0);
});

test('the key is a P-256 key: a token signed with another curve’s key, though it says ES256, is refused', async () => {
  const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' });
  await refused(check(token({ key: p384.privateKey }), { keyOf: async () => pem(p384.publicKey) }), 'key-form');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await refused(check(token(), { keyOf: async () => pem(rsa.publicKey) }), 'key-form');
  // Text that isn’t a key at all reads as the key’s form, not its absence: how a surprise at the endpoint would show.
  await refused(check(token(), { keyOf: async () => 'not a key' }), 'key-form');
});

test('a key id is checked for its shape before it is looked up, so nothing of the token’s choosing goes into a URL', async () => {
  const asked = [];
  const keyOf = async (/** @type {string} */ kid) => {
    asked.push(kid);
    return pem(p256.publicKey);
  };
  for (const kid of ['../../etc/passwd', 'a/b', `${KID}?x=1`, `${KID}/..`, '', undefined, 42, 'x'.repeat(36)])
    await refused(check(token({ header: { kid } }), { keyOf }), 'key-id');
  assert.deepEqual(asked, []);
  await check(token(), { keyOf });
  assert.deepEqual(asked, [KID]);
});

test('a key that can’t be had refuses the request', async () => {
  await refused(check(token(), { keyOf: async () => null }), 'key');
  await refused(
    check(token(), {
      keyOf: async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      },
    }),
    'key',
  );
  // A lookup that throws as it is called, or answers at once and not later, is handled the same.
  await refused(
    check(token(), {
      keyOf: () => {
        throw new Error('thrown as it was called');
      },
    }),
    'key',
  );
  assert.equal((await check(token(), { keyOf: () => pem(p256.publicKey) })).subject, 'u-1');
});

test('a token that doesn’t name this deployment’s load balancer, client and issuer is refused before any key is looked up', async () => {
  let fetched = 0;
  const keyOf = async () => {
    fetched++;
    return pem(p256.publicKey);
  };
  for (const header of [{ signer: 'arn:other' }, { client: 'another-app' }, { iss: 'https://other-idp.example' }])
    await assert.rejects(check(token({ header }), { keyOf }), (/** @type {any} */ e) => e.status === 401);
  assert.equal(fetched, 0, 'a made-up token makes no lookup');
});

test('the signature is checked before any claim is believed: a changed payload, a changed header and another key’s signature are refused', async () => {
  const [h, p, sig] = token().split('.');
  await refused(check(`${h}.${part({ sub: 'u-admin' })}.${sig}`), 'signature');
  // A header changed to last longer, with the old signature: refused as a bad signature, so its new exp is never read.
  await refused(
    check(
      `${part({ alg: 'ES256', kid: KID, signer: DEPLOYMENT.signer, iss: DEPLOYMENT.issuer, client: DEPLOYMENT.client, exp: NOW / 1000 + 99999 })}.${p}.${sig}`,
    ),
    'signature',
  );
  // And an expired token whose signature is bad is refused for its signature: nothing under it is believed first.
  await refused(
    check(`${part({ alg: 'ES256', kid: KID, signer: DEPLOYMENT.signer, iss: DEPLOYMENT.issuer, client: DEPLOYMENT.client, exp: 1 })}.${p}.${sig}`),
    'signature',
  );
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  await refused(check(token({ key: other.privateKey })), 'signature');
  await refused(check(`${h}.${p}.`), 'signature');
  // Signed over another hash: not ES256’s signature.
  await refused(check(token({ hash: 'SHA384' })), 'signature');
});

test('the signer is this deployment’s load balancer, and no other one’s', async () => {
  await refused(check(token({ header: { signer: `${DEPLOYMENT.signer}-other` } })), 'signer');
  await refused(check(token({ header: { signer: undefined } })), 'signer');
});

test('the client and the issuer are this deployment’s: a token for another application behind the same load balancer is refused', async () => {
  await refused(check(token({ header: { client: 'another-app' } })), 'client');
  await refused(check(token({ header: { client: undefined } })), 'client');
  await refused(check(token({ header: { iss: 'https://other-idp.example' } })), 'issuer');
  await refused(check(token({ header: { iss: undefined } })), 'issuer');
});

test('a token is good until its exp and no longer, and one without an exp is refused', async () => {
  await check(token({ header: { exp: NOW / 1000 + 1 } }));
  // As a string of digits too, which is how the load balancer’s page shows it.
  await check(token({ header: { exp: String(NOW / 1000 + 1) } }));
  for (const exp of [NOW / 1000, NOW / 1000 - 1, 0]) await refused(check(token({ header: { exp } })), 'expired');
  for (const exp of [undefined, null, 'soon', '', -5, Number.NaN, {}]) await refused(check(token({ header: { exp } })), 'no-expiry');
});

test('a token with no subject names no one', async () => {
  for (const sub of [undefined, '', 42, null]) await refused(check(token({ payload: { sub } })), 'subject');
});

test('the deployment’s own settings are all needed: a check made without one refuses to be made', async () => {
  for (const missing of ['signer', 'client', 'issuer'])
    await assert.rejects(check(token(), { [missing]: '' }), new RegExp(`needs the deployment’s ${missing}`));
});
