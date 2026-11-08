// view_app’s browser (#95; designs/architecture.md, “Agents see their app”) can’t hold a tool call or Postbox’s stop
// for good: a capture past its limit fails and closes the browser, so the next call starts a new one, and stopping
// Postbox ends a download that’s running and says so. These use a fake playwright-core and a fake installer;
// tests/browser/view-app.spec.mjs renders in the real headless shell.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AppBrowser, STOPPED } from '../server/view-app/browser.mjs';
import { tempDir } from './temp-dirs.mjs';

/** A package folder naming revision 1, and a browsers folder holding its headless shell. */
function folders() {
  const root = tempDir('pb-app-browser-');
  const pkg = join(root, 'pkg');
  const dir = join(root, 'browsers');
  mkdirSync(pkg);
  writeFileSync(join(pkg, 'browsers.json'), JSON.stringify({ browsers: [{ name: 'chromium-headless-shell', revision: '1' }] }));
  mkdirSync(join(dir, 'chromium_headless_shell-1', 'mac'), { recursive: true });
  writeFileSync(join(dir, 'chromium_headless_shell-1', 'mac', 'chrome-headless-shell'), '');
  return { pkg, dir };
}

const AT = { origin: 'http://127.0.0.1:1', threadId: 't', itemId: 'i', width: 1000, height: 680, theme: /** @type {'light'} */ ('light') };

test('a capture that hangs fails at its limit and closes the browser, so the next call starts a new one', async () => {
  const f = folders();
  let launches = 0;
  let closes = 0;
  const hung = {
    on() {},
    newContext: () => new Promise(() => {}),
    close: async () => {
      closes++;
    },
  };
  const launch = async () => {
    launches++;
    return hung;
  };
  const b = new AppBrowser({ dir: f.dir, pkg: f.pkg, captureMs: 50, load: async () => ({ chromium: { launch } }) });
  try {
    await assert.rejects(b.capture(AT), /Rendering the app took longer than 0\.05 s\./);
    assert.equal(closes, 1, 'the hung browser was closed');
    await assert.rejects(b.capture(AT), /took longer/);
    assert.equal(launches, 2, 'the next call started a new browser');
  } finally {
    await b.close();
  }
});

test('a browser whose close hangs doesn’t hold Postbox’s stop', async () => {
  const f = folders();
  const stuck = { on() {}, close: () => new Promise(() => {}) };
  const b = new AppBrowser({ dir: f.dir, pkg: f.pkg, load: async () => ({ chromium: { launch: async () => stuck } }) });
  await b.browser();
  const t0 = Date.now();
  await b.close();
  assert.ok(Date.now() - t0 < 6000, 'given up on after the close limit');
});

test('stopping Postbox ends a download that’s running, and the download says Postbox stopped', async () => {
  const f = folders();
  /** @type {any} */
  let child = null;
  const spawnImpl = /** @type {any} */ (
    () => {
      child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killed = false;
      child.kill = (signal) => {
        child.killed = true;
        setImmediate(() => child.emit('close', null, signal));
      };
      return child;
    }
  );
  const b = new AppBrowser({ dir: f.dir, pkg: f.pkg, spawnImpl });
  const install = b.install();
  await b.close();
  assert.equal(child.killed, true, 'the installer was killed');
  assert.deepEqual(await install, { ok: false, message: STOPPED });
  assert.equal(b.installing, null);
});
