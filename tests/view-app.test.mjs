// view_app (#95; designs/architecture.md, “Agents see their app”): an agent sees its app as the person first sees it.
// Postbox asks the person once before downloading the browser it renders with, keeps their answer across a restart,
// sends the picture to a backend that sees images, and saves it in the agent’s folder either way. These tests use a
// fake browser; tests/browser/view-app.spec.mjs renders a real app in the pinned headless shell.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { answerIn, keepAnswer } from '../server/view-app/consent.mjs';
import { ViewApp, viewApp } from '../server/view-app/view-app.mjs';
import { attachViewApp, viewOf } from '../server/view-app/view-of.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

class ScriptedAdapter {
  name = 'mock';
  calls = [];
  async deliver(session, message, ctx) {
    this.calls.push({ sessionId: session.id, message });
    await ctx.text('ok');
  }
}

/** A browser that does what each test says, and records what it was asked. */
function fakeBrowser({ status = 'ready', install = { ok: true }, capture = async () => PNG } = {}) {
  const b = {
    state: status,
    installs: 0,
    captures: [],
    installing: null,
    status: () => b.state,
    install: async () => {
      b.installs++;
      if (install.ok) b.state = 'ready';
      return install;
    },
    capture: async (at) => {
      b.captures.push(at);
      return capture(at);
    },
    close: async () => {},
  };
  return b;
}

function setup(browser = fakeBrowser()) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-view-app-'));
  const store = new Store(null);
  const adapter = new ScriptedAdapter();
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: dir });
  const a = rt.createPersona({ handle: 'researcher' });
  const t = rt.createThread({ projectId: 'p1', title: 'Prices', personaIds: [a.id] });
  const se = rt.sessionsIn(t.id)[0];
  const shown = rt.toolsFor(se.id).show_app({ title: 'Price and orders', code: '<p>Orders fall as price rises.</p>' });
  attachViewApp(rt, new ViewApp({ dataDir: dir, origin: () => 'http://127.0.0.1:1', browser: /** @type {any} */ (browser) }));
  return { dir, rt, adapter, t, se, appId: shown.appId, browser, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const ctx = (t, images = true) => ({ threadId: () => t.id, endSegment() {}, images });
const cards = (rt, t) => rt.store.items(t.id).filter((x) => x.kind === 'viewask');
const notices = (adapter, se) => adapter.calls.filter((c) => c.sessionId === se.id && c.message.kind === 'notice');

test('view_app refuses an app that isn’t in the agent’s conversation, without echoing more than the id', async () => {
  const s = setup();
  try {
    const other = s.rt.createThread({ projectId: 'p1', title: 'Elsewhere', personaIds: [s.se.personaId] });
    const elsewhere = s.rt.sessionsIn(other.id)[0];
    const r = await viewApp(s.rt, elsewhere.id, { appId: s.appId }, ctx(other));
    assert.equal(r.ok, false);
    assert.match(r.message, /There’s no app “app_[\w-]+” in your conversation/);
    assert.equal(s.browser.captures.length, 0, 'nothing was rendered');
  } finally {
    s.done();
  }
});

test('the first call asks the person once, on a card, and the agent waits; a second call adds no second card', async () => {
  const s = setup(fakeBrowser({ status: 'missing' }));
  try {
    const r = await viewApp(s.rt, s.se.id, { appId: s.appId }, ctx(s.t));
    assert.equal(r.ok, true);
    assert.equal(r.waiting, true);
    assert.match(r.message, /asked the person whether to download the browser/);
    await viewApp(s.rt, s.se.id, { appId: s.appId }, ctx(s.t));
    assert.equal(cards(s.rt, s.t).length, 1, 'one card while it’s open');
    assert.equal(cards(s.rt, s.t)[0].status, 'open');
    assert.equal(s.browser.installs, 0, 'nothing downloads before the person answers');
  } finally {
    s.done();
  }
});

test('Download on the card keeps the answer, downloads, and tells the agent it can look now', async () => {
  const s = setup(fakeBrowser({ status: 'missing' }));
  try {
    await viewApp(s.rt, s.se.id, { appId: s.appId }, ctx(s.t));
    const card = cards(s.rt, s.t)[0];
    s.rt.act(s.t.id, card.id, 'download');
    assert.equal(answerIn(viewOf(s.rt).dir), 'allowed', 'the answer is kept in the data folder');
    for (let i = 0; i < 50 && cards(s.rt, s.t)[0].status === 'downloading'; i++) await sleep(5);
    assert.equal(cards(s.rt, s.t)[0].status, 'ready');
    assert.equal(s.browser.installs, 1);
    const said = notices(s.adapter, s.se).map((c) => c.message.text);
    assert.ok(
      said.some((x) => /it finished\. Call view_app now/.test(x)),
      said.join(' | '),
    );
    assert.throws(() => s.rt.act(s.t.id, card.id, 'download'), /already answered/);
  } finally {
    s.done();
  }
});

test('a failed download says why on the card and to the agent', async () => {
  const s = setup(fakeBrowser({ status: 'missing', install: { ok: false, message: 'The download stopped (exit 1).' } }));
  try {
    await viewApp(s.rt, s.se.id, { appId: s.appId }, ctx(s.t));
    s.rt.act(s.t.id, cards(s.rt, s.t)[0].id, 'download');
    for (let i = 0; i < 50 && cards(s.rt, s.t)[0].status === 'downloading'; i++) await sleep(5);
    const card = cards(s.rt, s.t)[0];
    assert.equal(card.status, 'failed');
    assert.equal(card.reason, 'The download stopped (exit 1).');
    assert.ok(notices(s.adapter, s.se).some((c) => /it failed: The download stopped \(exit 1\)\. Carry on without view_app/.test(c.message.text)));
  } finally {
    s.done();
  }
});

test('Not now is kept across a restart, and view_app says the person declined instead of asking again', async () => {
  const s = setup(fakeBrowser({ status: 'missing' }));
  try {
    await viewApp(s.rt, s.se.id, { appId: s.appId }, ctx(s.t));
    s.rt.act(s.t.id, cards(s.rt, s.t)[0].id, 'decline');
    assert.equal(cards(s.rt, s.t)[0].status, 'declined');
    assert.equal(answerIn(viewOf(s.rt).dir), 'declined', 'kept in the data folder, which a restart reads');
    const r = await viewApp(s.rt, s.se.id, { appId: s.appId }, ctx(s.t));
    assert.equal(r.ok, false);
    assert.match(r.message, /chose not to download the browser/);
    assert.equal(cards(s.rt, s.t).length, 1, 'no second card');
    assert.equal(s.browser.installs, 0);
  } finally {
    s.done();
  }
});

test('with the browser ready, the picture goes to a backend that sees images and is saved in the agent’s folder either way', async () => {
  const s = setup();
  try {
    keepAnswer(viewOf(s.rt).dir, 'allowed');
    const r = await viewApp(s.rt, s.se.id, { appId: s.appId }, ctx(s.t, true));
    assert.equal(r.ok, true);
    assert.deepEqual(r.image, { data: PNG.toString('base64'), mimeType: 'image/png' });
    assert.match(r.message, /v1 as the person first sees it, inline in the conversation, in a 1000 × 680 window, light theme/);
    const saved = join(s.dir, '.postbox', 'view', `${s.appId}-v1.png`);
    assert.ok(existsSync(saved), 'saved in the agent’s folder');
    assert.deepEqual(readFileSync(saved), PNG);
    const [at] = s.browser.captures;
    assert.equal(at.threadId, s.t.id);
    assert.equal(at.itemId, s.rt.store.items(s.t.id).find((x) => x.block?.id === s.appId).id);
    const plain = await viewApp(s.rt, s.se.id, { appId: s.appId }, ctx(s.t, false));
    assert.equal(plain.image, null, 'a backend that can’t see images gets the path');
    assert.match(plain.message, /Saved as .*\.postbox\/view\/app_[\w-]+-v1\.png/);
  } finally {
    s.done();
  }
});

test('a capture that fails says so, and that the pre-display check still stands', async () => {
  const s = setup(
    fakeBrowser({
      capture: async () => {
        throw new Error('The page couldn’t find that app to show.');
      },
    }),
  );
  try {
    keepAnswer(viewOf(s.rt).dir, 'allowed');
    const r = await viewApp(s.rt, s.se.id, { appId: s.appId }, ctx(s.t));
    assert.equal(r.ok, false);
    assert.match(r.message, /couldn’t render .*: The page couldn’t find that app to show\. The pre-display check still stands\./);
  } finally {
    s.done();
  }
});

test('the window and column come from the person’s tab when it reported them in the last half hour, bounded, else 1000 × 680', () => {
  const s = setup();
  try {
    const v = viewOf(s.rt);
    assert.deepEqual(v.windowNow(), { width: 1000, height: 680, column: null, theme: 'light' }, 'no column: the page lays it out beside the rail');
    v.noteWindow({ width: 1440.4, height: 900, column: 751.6, theme: 'dark' });
    assert.deepEqual({ ...v.windowNow(), at: 0 }, { width: 1440, height: 900, column: 752, theme: 'dark', at: 0 });
    v.noteWindow({ width: 1440, height: 900, column: 5000 });
    assert.equal(v.windowNow().column, null, 'a column wider than the window is left to the page');
    v.noteWindow({ width: 99999, height: 900, theme: 'dark' });
    v.noteWindow({ width: '<svg>', height: 900 });
    v.noteWindow(null);
    assert.equal(v.windowNow().width, 1440, 'a report that isn’t a window is ignored');
    v.window.at -= 31 * 60 * 1000;
    assert.equal(v.windowNow().width, 1000, 'an old report gives way to the default');
  } finally {
    s.done();
  }
});
