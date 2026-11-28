// A Postbox given sign-in settings (designs/architecture/hosted.md, “Who is asking”; #1733): every request is whoever
// an AWS Application Load Balancer signed in, or it is refused, reads included, and without settings a run on this
// computer asks nothing. Through the router with fake requests, as tests/profile.test.mjs calls it. Nothing listens.

import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
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
  // The page is told it is hosted, so it asks for no folder on the server; a local one is told it isn’t.
  assert.equal(state.json.config.hosted, true);
  assert.equal((await ask(local, PORT + 1, { path: '/api/state' })).json.config.hosted, false);
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

/** A request the router can be handed and watched: fakeRequest’s answers end, and a stream’s doesn’t. */
function watched(/** @type {string} */ path, /** @type {Record<string, string>} */ headers) {
  const req = Object.assign(Readable.from([]), {
    method: 'GET',
    url: path,
    headers: { host: `127.0.0.1:${PORT}`, ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  });
  const res = {
    headersSent: false,
    writeHead() {},
    setHeader() {},
    flushHeaders() {},
    write: () => true,
    end() {},
    on() {},
    once() {},
    off() {},
    destroy() {},
  };
  const closed = new Promise((ok) => req.once('close', () => ok('closed')));
  const within = (/** @type {number} */ ms) => Promise.race([closed, new Promise((ok) => setTimeout(() => ok('open'), ms))]);
  return { req, res, within };
}

test('a stream is ended when the sign-in it opened with ends, and no other request is', async () => {
  // Good for 20 ms more, by the clock the sign-in check reads.
  const soon = signed({ header: { exp: NOW / 1000 + 0.02 } });
  const stream = watched('/api/stream', soon);
  await hosted.handle(stream.req, stream.res);
  assert.equal(stream.req.destroyed, false, 'open while its sign-in is good');
  assert.equal(await stream.within(2000), 'closed');
  const state = watched('/api/state', soon);
  await hosted.handle(state.req, state.res);
  assert.equal(await state.within(120), 'open', 'a request that isn’t the stream is never cut off');
  state.req.destroy();
});

test('a refused sign-in is written to the server’s log by its reason’s name', async (t) => {
  const said = t.mock.method(console, 'log', () => {});
  const answer = await ask(hosted, PORT, { path: '/api/state', headers: signed({ header: { client: 'another-app' } }) });
  assert.equal(answer.status, 401);
  assert.deepEqual(
    said.mock.calls.map((c) => c.arguments[0]),
    ['Postbox refused a sign-in: client.'],
  );
});

test('a public address is never answered without sign-in settings: such a start is refused before anything opens', async () => {
  const dir = tempDir('pb-hosted-no-sign-in-');
  await assert.rejects(
    // A start that went ahead is closed again, so a missing refusal fails here and leaves nothing running.
    start({ port: PORT + 3, dataDir: dir, fresh: true, quiet: true, claudeHome: dir, listen: false, publicOrigin: 'https://postbox.example.com' }).then((app) =>
      app.close(),
    ),
    /A hosted Postbox needs its sign-in settings\./,
  );
  assert.deepEqual(readdirSync(dir), [], 'nothing was opened');
});

test('hosted, no one names a folder on the server for an agent or a conversation, and the answer never says whether one is there', async () => {
  const cookie = (await ask(hosted, PORT, { path: '/', headers: { ...NAVIGATION, ...signed() } })).headers['set-cookie'].split(';')[0];
  const headers = { cookie, ...signed() };
  const refusal = 'This Postbox runs on a server, so nothing is given a folder here. Put the agent on a host under Runs on, and name a folder there.';
  const persona = Object.values(hosted.rt.s.personas)[0];
  const session = Object.values(hosted.rt.s.sessions)[0];
  // A folder that exists, one that doesn’t, and one that isn’t a path at all are answered alike.
  for (const folder of [tempDir('pb-hosted-there-'), '/no/such/folder/anywhere', 'relative']) {
    const agent = await ask(hosted, PORT, { method: 'PATCH', path: `/api/personas/${persona.id}`, body: { folder }, headers });
    assert.deepEqual([agent.status, agent.json.error], [422, refusal], `an agent’s folder ${folder}`);
    const added = await ask(hosted, PORT, { method: 'POST', path: '/api/permissions/folders', body: { sessionId: session.id, path: folder }, headers });
    assert.deepEqual([added.status, added.json.error], [422, refusal], `a conversation’s folder ${folder}`);
    const made = await ask(hosted, PORT, { method: 'POST', path: '/api/personas', body: { handle: 'newcomer', folder }, headers });
    assert.deepEqual([made.status, made.json.error], [422, refusal], `a new agent’s folder ${folder}`);
  }
  assert.equal(hosted.rt.s.personas[persona.id].folder ?? '', persona.folder ?? '', 'nothing was kept for the agent');
  assert.deepEqual(hosted.rt.s.sessions[session.id].addDirs ?? [], [], 'nor for the conversation');
  // An agent with no folder still saves, as the sheet sends an empty Folder with every save, and null is none too.
  for (const folder of ['', null])
    assert.equal((await ask(hosted, PORT, { method: 'PATCH', path: `/api/personas/${persona.id}`, body: { folder }, headers })).status, 200, String(folder));
});

test('on your own computer an agent and a conversation are still given an existing folder, and told when one isn’t there', async () => {
  const cookie = (await ask(local, PORT + 1, { path: '/', headers: NAVIGATION })).headers['set-cookie'].split(';')[0];
  const there = tempDir('pb-local-there-');
  const persona = Object.values(local.rt.s.personas)[0];
  const session = Object.values(local.rt.s.sessions)[0];
  const patch = (/** @type {string} */ folder) =>
    ask(local, PORT + 1, { method: 'PATCH', path: `/api/personas/${persona.id}`, body: { folder }, headers: { cookie } });
  const add = (/** @type {string} */ path) =>
    ask(local, PORT + 1, { method: 'POST', path: '/api/permissions/folders', body: { sessionId: session.id, path }, headers: { cookie } });
  assert.equal((await patch(there)).status, 200);
  assert.equal((await add(there)).status, 200);
  const missing = await add('/no/such/folder/anywhere');
  assert.deepEqual([missing.status, missing.json.error], [422, '/no/such/folder/anywhere isn’t a folder on this computer.']);
});

test('hosted, an agent on a host keeps its folder there, and a conversation’s added folder can still be removed', async () => {
  const cookie = (await ask(hosted, PORT, { path: '/', headers: { ...NAVIGATION, ...signed() } })).headers['set-cookie'].split(';')[0];
  const headers = { cookie, ...signed() };
  hosted.store.emit('host', { id: 'h-far', name: 'agents', settings: {}, createdAt: 1 });
  hosted.store.emit('persona', { ...Object.values(hosted.rt.s.personas)[0], id: 'pe-far', handle: 'far', remote: { hostId: 'h-far' }, folder: '' });
  const kept = await ask(hosted, PORT, { method: 'PATCH', path: '/api/personas/pe-far', body: { folder: '/srv/on-the-host' }, headers });
  assert.deepEqual([kept.status, kept.json.folder], [200, '/srv/on-the-host']);
  const session = Object.values(hosted.rt.s.sessions)[0];
  hosted.rt.sessions.update(session.id, { addDirs: ['/added/before'] });
  const removed = await ask(hosted, PORT, {
    method: 'POST',
    path: '/api/permissions/folders',
    body: { sessionId: session.id, path: '/added/before', remove: true },
    headers,
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(hosted.rt.s.sessions[session.id].addDirs, []);
});

// #1977: the models answer reaches everyone signed in to a hosted Postbox, not only a room’s members, and a
// provider’s error can name the account’s resources (server/model-runs.mjs). Hosted, a failure is answered without it.
test('hosted, the models answer says a model failed and when, and never the harness’s words; on your own computer it says them', async () => {
  const why = 'arn:aws:bedrock:us-west-2:123456789012:inference-profile/m-1 is not available for this account';
  for (const [port, signIn, headers, expected] of /** @type {const} */ ([
    [PORT + 2, { settings: SETTINGS, get: async () => publicPem, now: () => NOW }, signed(), { ended: 'failed', at: 1 }],
    [PORT + 3, undefined, {}, { ended: 'failed', at: 1, why }],
  ])) {
    const dir = tempDir('pb-hosted-models-');
    const app = await start({ port, dataDir: dir, fresh: true, demo: true, quiet: true, claudeHome: dir, listen: false, signIn });
    try {
      // Read once, at the first answer, so it is written before one.
      writeFileSync(join(dir, 'model-runs.json'), JSON.stringify({ mock: { 'm-1': { ended: 'failed', at: 1, why } } }));
      const cookie = (await ask(app, port, { path: '/', headers: { ...NAVIGATION, ...headers } })).headers['set-cookie'].split(';')[0];
      const answer = await ask(app, port, { method: 'POST', path: '/api/backends/mock/models', body: {}, headers: { cookie, ...headers } });
      assert.deepEqual([answer.status, answer.json.ran?.['m-1']], [200, expected], `signed in: ${!!signIn}`);
    } finally {
      await app.close();
    }
  }
});
