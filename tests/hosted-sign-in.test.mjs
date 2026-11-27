// A Postbox given sign-in settings (designs/architecture/hosted.md, “Who is asking”; #1733): every request is whoever
// an AWS Application Load Balancer signed in, or it is refused, reads included, and without settings a run on this
// computer asks nothing. Through the router with fake requests, as tests/profile.test.mjs calls it. Nothing listens.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { start } from '../server/index.mjs';
import { NOW, publicPem, SETTINGS, tokenFor } from './alb-fixture.mjs';
import { fakeRequest, NAVIGATION } from './fake-http.mjs';
import { tempDir } from './temp-dirs.mjs';

const PORT = 4466;
/** @type {any} */
let hosted;
/** @type {any} */
let local;
before(async () => {
  const signIn = { settings: SETTINGS, get: async () => publicPem, now: () => NOW };
  const dir = tempDir('pb-hosted-');
  hosted = await start({ port: PORT, dataDir: dir, fresh: true, demo: true, quiet: true, claudeHome: dir, listen: false, signIn });
  const dir2 = tempDir('pb-hosted-local-');
  local = await start({ port: PORT + 1, dataDir: dir2, fresh: true, demo: true, quiet: true, claudeHome: dir2, listen: false });
});
after(async () => {
  await hosted.close();
  await local.close();
});

const ask = (/** @type {any} */ app, /** @type {number} */ port, /** @type {any} */ r) => fakeRequest(app.handle, { host: `127.0.0.1:${port}`, ...r });
const signed = (/** @type {Record<string, any>} */ how = {}) => ({ 'x-amzn-oidc-data': tokenFor(how) });

test('a signed-in person on the allow list gets the app, and the page is told who they are', async () => {
  const state = await ask(hosted, PORT, { path: '/api/state', headers: signed() });
  assert.equal(state.status, 200);
  assert.deepEqual([state.json.config.me.name, state.json.config.me.username], ['Robin Example', 'robin']);
  assert.equal((await ask(hosted, PORT, { path: '/', headers: { ...NAVIGATION, ...signed() } })).status, 200);
});

test('with no sign-in, no route answers: the page, the state, the stream, a room’s items, a stored file and the media, reads included', async () => {
  const room = Object.keys(hosted.rt.s.threads)[0];
  for (const path of [
    '/',
    '/api/state',
    '/api/stream',
    `/api/threads/${room}/items`,
    '/api/files/f_none',
    '/media/favicon.svg',
    '/favicon.svg',
    '/app/js/main.mjs',
    '/shared/limits.mjs',
    '/kit/kit.js',
    '/sandbox/mermaid',
  ]) {
    const answer = await ask(hosted, PORT, { path });
    assert.deepEqual([path, answer.status, answer.json], [path, 401, { error: 'Sign in to use this Postbox.', code: 'sign-in' }]);
    assert.equal((await ask(hosted, PORT, { method: 'HEAD', path })).status, 401, `HEAD ${path}`);
  }
  // Why a token was refused is never sent: an expired one reads as none at all.
  const expired = await ask(hosted, PORT, { path: '/api/state', headers: signed({ header: { exp: NOW / 1000 - 1 } }) });
  assert.deepEqual([expired.status, expired.json], [401, { error: 'Sign in to use this Postbox.', code: 'sign-in' }]);
});

test('someone signed in who isn’t on the allow list gets a refusal that says so, and nothing of the Postbox', async () => {
  const other = await ask(hosted, PORT, { path: '/api/state', headers: signed({ payload: { sub: 'u-9', name: 'Sam Okafor', preferred_username: 'sam' } }) });
  assert.equal(other.status, 403);
  assert.deepEqual(other.json, {
    error: 'You’re signed in as Sam Okafor, and this Postbox isn’t open to you. Ask whoever runs it to add you.',
    code: 'not-allowed',
  });
});

test('hosted, the agents’ tool address has no caller and isn’t there, signed in or not', async () => {
  for (const headers of [{}, signed()]) {
    const mcp = await ask(hosted, PORT, { method: 'POST', path: '/mcp', body: {}, headers });
    assert.equal(mcp.status, 404);
  }
});

test('a write needs both: the page’s token, and a signed-in person', async () => {
  const cookie = (await ask(hosted, PORT, { path: '/', headers: { ...NAVIGATION, ...signed() } })).headers['set-cookie'].split(';')[0];
  const save = (/** @type {Record<string, string>} */ headers) =>
    ask(hosted, PORT, { method: 'PUT', path: '/api/me', body: { profile: { pronouns: 'they/them' } }, headers });
  assert.equal((await save({ cookie })).status, 401, 'the page’s token alone');
  assert.equal((await save(signed())).status, 403, 'a sign-in alone');
  const saved = await save({ cookie, ...signed() });
  assert.deepEqual([saved.status, saved.json.profile], [200, { pronouns: 'they/them' }]);
  // The record is the signed-in person’s, by the issuer and subject the token carried.
  assert.deepEqual(saved.json.identity, { provider: 'alb', issuer: 'https://idp.example', subject: 'u-1' });
});

test('on your own computer nothing asks who you are: the same routes answer with no sign-in, and a token in a header is no one', async () => {
  for (const path of ['/', '/api/state', '/favicon.svg']) assert.equal((await ask(local, PORT + 1, { path })).status, 200, path);
  // A forged sign-in header changes nothing locally: the person is the computer’s account.
  const plain = (await ask(local, PORT + 1, { path: '/api/state' })).json.config.me;
  const forged = (await ask(local, PORT + 1, { path: '/api/state', headers: signed({ payload: { sub: 'u-9', name: 'Mallory' } }) })).json.config.me;
  assert.deepEqual(forged, plain);
  assert.notEqual(plain.name, 'Mallory');
});

test('a Postbox given sign-in settings with no allow list doesn’t start, and says what to set', async () => {
  const dir = tempDir('pb-hosted-none-');
  const signIn = { settings: { ...SETTINGS, allow: undefined }, get: async () => publicPem };
  // If it did start, it is stopped here, so the test fails on the assertion and never waits on a running Postbox.
  const outcome = await start({ port: PORT + 2, dataDir: dir, fresh: true, quiet: true, claudeHome: dir, listen: false, signIn }).then(
    (app) => app.close().then(() => 'it started'),
    (e) => e,
  );
  assert.match(String(outcome?.message ?? outcome), /needs an allow list/);
  // It stopped before it opened anything: the folder is as it was, with no store and no lock left in it.
  assert.deepEqual(readdirSync(dir), []);
});
