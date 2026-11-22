// #954: the person presses Download on the “download Chromium?” card, and the card says the download runs. The agent
// asked them, so it showed “needs you: download Chromium?”; once they’ve answered, it no longer needs them, though it
// waits for the download. Before, the need stayed until the download ended, so the agent read as waiting on the person.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { ViewApp, viewApp } from '../server/view-app/view-app.mjs';
import { attachViewApp } from '../server/view-app/view-of.mjs';
import * as arrange from './arrange.mjs';

/** A browser whose download runs until the test ends it. */
function slowBrowser() {
  let finish = () => {};
  const done = new Promise((r) => {
    finish = () => r({ ok: true });
  });
  return { status: () => 'missing', install: () => done, capture: async () => Buffer.alloc(0), close: async () => {}, finish: () => finish() };
}

test('#954 pressing Download clears the agent’s “needs you” while the download runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-view-ask-'));
  try {
    const store = new Store(null);
    const rt = new Runtime({
      store,
      adapters: new AdapterRegistry().register({ name: 'mock', async deliver() {} }),
      config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
    });
    store.emit('project', { id: 'p1', name: 'P', folder: dir });
    const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [rt.createPersona({ handle: 'researcher' }).id] });
    const se = arrange.sessionsIn(rt, t.id)[0];
    const { appId } = rt.toolsFor(se.id).show_app({ title: 'Prices', code: '<p>Prices</p>' });
    const browser = slowBrowser();
    attachViewApp(rt, new ViewApp({ dataDir: dir, origin: () => 'http://127.0.0.1:1', browser: /** @type {any} */ (browser) }));
    await viewApp(rt, se.id, { appId }, { threadId: () => t.id, endSegment() {}, images: true });
    const card = store.items(t.id).find((x) => x.kind === 'viewask');
    // The agent’s turn ended waiting on the card, as the UAT’s events show (session.patch, state needs).
    rt.sessions.update(se.id, { needs: { kind: 'viewask', itemId: card.id, text: '@researcher asks to see its app: download Chromium?' }, state: 'needs' });
    rt.act(t.id, card.id, 'download');
    assert.equal(store.item(t.id, card.id).status, 'downloading', 'the download is still running');
    const now = rt.s.sessions[se.id];
    assert.equal(now.needs, null, 'the agent no longer needs the person');
    assert.notEqual(now.state, 'needs');
    browser.finish();
    for (let i = 0; i < 50 && store.item(t.id, card.id).status === 'downloading'; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(store.item(t.id, card.id).status, 'ready');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
