// #1480: the server opens a link from an app in the default browser, for the Claude desktop app’s pane: http and https
// only, as an argument array, only for an app that exists, a few a minute per app, and only while Postbox listens on
// this computer alone and the request came from it. These tests never open a browser: run and openUrl are stand-ins.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OPEN_LIMIT, opener, openLink } from '../server/app-links.mjs';
import * as arrange from './arrange.mjs';
import { fakeRequest, NAVIGATION } from './fake-http.mjs';

const runtime = () => ({ s: { apps: { a1: { id: 'a1' }, a2: { id: 'a2' } } } });

test('#1480 a link is opened with an argument array, by each system’s own opener', async () => {
  const ran = [];
  const res = await openLink(runtime(), 'a1', 'https://example.com/a b?q=1;rm -rf', { run: async (c) => ran.push(c), platform: 'darwin' });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(ran, [['open', ['https://example.com/a%20b?q=1;rm%20-rf']]], 'the URL is one argument, normalized, never a shell string');
  assert.deepEqual(opener('https://x.test/', 'linux'), ['xdg-open', ['https://x.test/']]);
  assert.deepEqual(opener('https://x.test/', 'win32'), ['rundll32', ['url.dll,FileProtocolHandler', 'https://x.test/']]);
  assert.equal(opener('https://x.test/', 'aix'), null);
});

test('#1480 anything but an http or https URL, or an app that doesn’t exist, is refused and opens nothing', async () => {
  const rt = runtime();
  const ran = [];
  const run = async (c) => ran.push(c);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'mailto:a@b.c', 'not a url', ''])
    await assert.rejects(openLink(rt, 'a1', url, { run, platform: 'darwin' }), (e) => e.status === 400, url);
  await assert.rejects(openLink(rt, 'nope', 'https://example.com/', { run, platform: 'darwin' }), (e) => e.status === 404);
  await assert.rejects(openLink(rt, 'a1', 'https://example.com/', { run, platform: 'aix' }), (e) => e.status === 501);
  assert.deepEqual(ran, []);
});

test('#1480 an app opens at most OPEN_LIMIT links a minute, counted per app, and a refusal says when to try again', async () => {
  const rt = runtime();
  const ran = [];
  const at = (now) => ({ run: async (c) => ran.push(c[1][0]), platform: 'darwin', now });
  for (let i = 0; i < OPEN_LIMIT; i++) await openLink(rt, 'a1', `https://example.com/${i}`, at(1000 + i));
  await assert.rejects(openLink(rt, 'a1', 'https://example.com/over', at(2000)), (e) => e.status === 429 && /a minute/.test(e.message));
  assert.equal(ran.length, OPEN_LIMIT, 'the one over the limit opened nothing');
  await openLink(rt, 'a2', 'https://example.com/other-app', at(2000));
  await openLink(rt, 'a1', 'https://example.com/later', at(1000 + 60_000));
  assert.deepEqual(ran.slice(-2), ['https://example.com/other-app', 'https://example.com/later']);
});

test('#1480 an opener that fails to start says so, rather than answering that the link opened', async () => {
  const run = async () => {
    throw Object.assign(new Error('spawn open ENOENT'), { code: 'ENOENT' });
  };
  await assert.rejects(
    openLink(runtime(), 'a1', 'https://example.com/', { run, platform: 'darwin' }),
    (e) => e.status === 502 && /couldn’t open the link/.test(e.message),
  );
});

test('#1480 the open route needs the page’s token, Postbox listening on 127.0.0.1, and a request from this computer', async (t) => {
  process.env.POSTBOX_BACKENDS = 'mock';
  const { start } = await import('../server/index.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'pb-open-'));
  t.after(() => rm(dir, { recursive: true, force: true })); // a failing assertion leaves nothing either (#797)
  const ran = [];
  const openUrl = async (cmd) => ran.push(cmd);
  for (const host of ['127.0.0.1', '0.0.0.0']) {
    const app = await start({ port: 4439, dataDir: dir, fresh: true, demo: true, quiet: true, claudeHome: dir, listen: false, host, openUrl });
    try {
      const call = (r) => fakeRequest(app.handle, { host: '127.0.0.1:4439', ...r });
      const cookie = (await call({ path: '/', headers: NAVIGATION })).headers['set-cookie'].split(';')[0];
      const thread = Object.values(app.store.state.threads).find((x) => x.title === 'Asset explorer');
      const appId = `links-${host}`;
      app.rt.toolsFor(arrange.agentIn(app.rt, thread.id).id).show_app({ id: appId, title: 'Links', code: '<p>Links</p>', permissions: [] });
      const open = (r) => call({ method: 'POST', path: `/api/apps/${appId}/open`, body: { url: 'https://example.com/' }, cookie, ...r });
      const r = await open();
      if (host === '127.0.0.1') {
        assert.equal(r.status, 200, r.text);
        assert.equal(ran.length, 1);
        const away = await open({ remoteAddress: '192.168.1.5' });
        assert.equal(away.status, 403);
        assert.match(away.json.error, /only from this computer/);
      } else {
        assert.equal(r.status, 403);
        assert.match(r.json.error, /only while Postbox listens on this computer alone/);
      }
      assert.equal((await open({ cookie: undefined })).status, 403, 'without the page’s token, never');
      assert.equal(ran.length, 1, 'nothing else opened');
    } finally {
      await app.close();
    }
  }
});
