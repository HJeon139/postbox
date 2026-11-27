// A load balancer’s sign-in token for the tests of a hosted Postbox’s sign-in (tests/alb-provider.test.mjs,
// tests/hosted-sign-in.test.mjs): a key pair made here, the deployment’s settings, and a token signed as the load
// balancer signs one. The person is a fixture, never a real account.

import { createSign, generateKeyPairSync } from 'node:crypto';

export const NOW = Date.parse('2026-11-27T12:00:00Z');
export const KID = '12345678-1234-1234-1234-123456789012';
const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
export const publicPem = /** @type {string} */ (pair.publicKey.export({ type: 'spki', format: 'pem' }));

/** A deployment’s sign-in settings, as its settings file holds them. */
export const SETTINGS = {
  provider: 'alb',
  region: 'us-west-2',
  signer: 'arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/postbox/50dc6c495c0c9188',
  client: 'postbox-client',
  issuer: 'https://idp.example',
  claims: { username: 'preferred_username', name: 'name' },
  allow: { subjects: ['u-1'] },
};

const part = (/** @type {unknown} */ value) => Buffer.from(JSON.stringify(value)).toString('base64').replaceAll('+', '-').replaceAll('/', '_');

/** A token for the fixture person, good for two minutes from NOW; `header` and `payload` change or drop a field. */
export function tokenFor({ header = {}, payload = {} } = {}) {
  const h = { alg: 'ES256', kid: KID, signer: SETTINGS.signer, iss: SETTINGS.issuer, client: SETTINGS.client, exp: NOW / 1000 + 120, ...header };
  const p = { sub: 'u-1', name: 'Robin Example', preferred_username: 'robin', email: 'robin@example.com', ...payload };
  const signed = `${part(h)}.${part(p)}`;
  const signature = createSign('SHA256').update(signed).sign({ key: pair.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signed}.${signature.toString('base64').replaceAll('+', '-').replaceAll('/', '_')}`;
}
