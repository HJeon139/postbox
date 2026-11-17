// #1480: the server opens a link from an app in the default browser, for the Claude desktop app’s pane: http and https
// only, as an argument array, and only for an app that exists. These tests never open a browser: run is a stand-in.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { opener, openLink } from '../server/app-links.mjs';

const rt = { s: { apps: { a1: { id: 'a1' } } } };

test('#1480 a link is opened with an argument array, by each system’s own opener', () => {
  const ran = [];
  assert.deepEqual(openLink(rt, 'a1', 'https://example.com/a b?q=1;rm -rf', { run: (c) => ran.push(c), platform: 'darwin' }), { ok: true });
  assert.deepEqual(ran, [['open', ['https://example.com/a%20b?q=1;rm%20-rf']]], 'the URL is one argument, normalized, never a shell string');
  assert.deepEqual(opener('https://x.test/', 'linux'), ['xdg-open', ['https://x.test/']]);
  assert.deepEqual(opener('https://x.test/', 'win32'), ['rundll32', ['url.dll,FileProtocolHandler', 'https://x.test/']]);
  assert.equal(opener('https://x.test/', 'aix'), null);
});

test('#1480 anything but an http or https URL, or an app that doesn’t exist, is refused and opens nothing', () => {
  const ran = [];
  const run = (c) => ran.push(c);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'mailto:a@b.c', 'not a url', ''])
    assert.throws(
      () => openLink(rt, 'a1', url, { run, platform: 'darwin' }),
      (e) => e.status === 400,
      url,
    );
  assert.throws(
    () => openLink(rt, 'nope', 'https://example.com/', { run, platform: 'darwin' }),
    (e) => e.status === 404,
  );
  assert.throws(
    () => openLink(rt, 'a1', 'https://example.com/', { run, platform: 'aix' }),
    (e) => e.status === 501,
  );
  assert.deepEqual(ran, []);
});
