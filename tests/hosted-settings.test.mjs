// A hosted Postbox’s settings file (server/hosted-settings.mjs): the one public origin and the sign-in settings, read
// whole and refused in words that say what to set, before anything starts.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { publicOriginOf, readHosted } from '../server/hosted-settings.mjs';
import { fetchKeyText } from '../server/identity/alb-key-fetch.mjs';
import { signInSettings } from '../server/identity/sign-in-settings.mjs';
import { SETTINGS } from './alb-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

const dir = tempDir('pb-hosted-settings-');
const fileOf = (/** @type {unknown} */ value, name = 'hosted.json') => {
  const path = join(dir, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
};

test('a settings file gives start() the public origin, every address to listen on, and the sign-in with the real key fetch', () => {
  assert.deepEqual(readHosted(fileOf({ origin: 'https://postbox.example.com', signIn: SETTINGS })), {
    host: '0.0.0.0',
    publicOrigin: 'https://postbox.example.com',
    signIn: { settings: SETTINGS, get: fetchKeyText },
  });
});

test('the origin is one HTTPS origin as a browser writes it: no path, no plain HTTP, no upper case, no default port', () => {
  assert.equal(publicOriginOf('https://postbox.example.com:8443'), 'https://postbox.example.com:8443');
  for (const origin of [
    undefined,
    '',
    'postbox.example.com',
    'http://postbox.example.com',
    'https://postbox.example.com/',
    'https://postbox.example.com/rooms',
    'https://Postbox.example.com',
    'https://postbox.example.com:443',
    'https://user@postbox.example.com',
    'https://postbox.example.com?x=1',
  ])
    assert.throws(() => publicOriginOf(origin), /Hosted settings need “origin”/, String(origin));
});

test('a file that can’t be read, isn’t JSON, has a field Postbox doesn’t know, or leaves out the allow list is refused', () => {
  assert.throws(() => readHosted(join(dir, 'missing.json')), /couldn’t read the hosted settings at .*missing\.json/);
  assert.throws(() => readHosted(fileOf('{ not json')), /couldn’t read the hosted settings/);
  assert.throws(() => readHosted(fileOf([1])), /an object with “origin” and “signIn”/);
  assert.throws(() => readHosted(fileOf({ origin: 'https://postbox.example.com', signIn: SETTINGS, user: 'robin' })), /have no “user”/);
  assert.throws(() => readHosted(fileOf({ origin: 'https://postbox.example.com', signIn: { ...SETTINGS, allow: undefined } })), /needs an allow list/);
  assert.throws(() => readHosted(fileOf({ origin: 'https://postbox.example.com' })), /sign-in settings are an object/);
});

test('a Cognito user pool can’t back an allow list of groups: its claims are attributes a person may be able to write', () => {
  const groups = { claim: 'custom:team', any: ['postbox'] };
  const cognito = 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_EXAMPLE';
  assert.throws(() => signInSettings({ ...SETTINGS, issuer: cognito, allow: { groups } }), /A Cognito user pool can’t back “allow.groups”/);
  assert.throws(() => signInSettings({ ...SETTINGS, issuer: cognito, allow: { subjects: ['u-1'], groups } }), /A Cognito user pool can’t back “allow.groups”/);
  // By subject it is fine, and another provider’s groups are its administrators’ to set.
  assert.deepEqual(signInSettings({ ...SETTINGS, issuer: cognito }).allow, { subjects: ['u-1'], groups: null });
  assert.deepEqual(signInSettings({ ...SETTINGS, allow: { groups } }).allow, { subjects: [], groups });
});
