// The fixture for #1927’s view-card tests (tests/view-ask-waiters.test.mjs): agents in a conversation, each with an app
// of its own, a browser that isn’t downloaded yet, and what each agent was told. Moved out of that file, which had
// reached its length limit.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { ViewApp } from '../server/view-app/view-app.mjs';
import { attachViewApp } from '../server/view-app/view-of.mjs';
import * as arrange from './arrange.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ScriptedAdapter {
  name = 'mock';
  calls = [];
  async deliver(session, message, ctx) {
    this.calls.push({ sessionId: session.id, message });
    await ctx.text('ok');
  }
}

/** A browser not yet downloaded, whose download does what the test says. @param {{ ok: boolean, message?: string }} install */
export const missingBrowser = (install = { ok: true }) => {
  const b = {
    state: 'missing',
    status: () => b.state,
    install: async () => {
      if (install.ok) b.state = 'ready';
      return install;
    },
    capture: async () => Buffer.alloc(0),
    close: async () => {},
  };
  return b;
};

/** Agents in one conversation, each with an app of its own: the first two, or as many as handles names. @param {any} browser */
export function twoAgents(browser, handles = ['researcher', 'critic']) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-view-ask-'));
  const store = new Store(null);
  const adapter = new ScriptedAdapter();
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: dir });
  const personas = handles.map((handle) => rt.createPersona({ handle }));
  const t = rt.createThread({ projectId: 'p1', title: 'Prices', personaIds: personas.map((x) => x.id) });
  const all = arrange.sessionsIn(rt, t.id);
  const [first, second] = all;
  const appOf = (se) => rt.toolsFor(se.id).show_app({ title: `${se.handle}’s chart`, code: '<p>Orders fall as price rises.</p>' }).appId;
  const apps = { first: appOf(first), second: appOf(second) };
  attachViewApp(rt, new ViewApp({ dataDir: dir, origin: () => 'http://127.0.0.1:1', browser }));
  return { rt, adapter, t, first, second, all, apps, appOf, done: () => rmSync(dir, { recursive: true, force: true }) };
}
export const ctx = (t) => ({ threadId: () => t.id, endSegment() {}, images: true });
export const card = (s) => s.rt.store.items(s.t.id).find((x) => x.kind === 'viewask');
export const told = (s, se) => s.adapter.calls.filter((c) => c.sessionId === se.id && c.message.kind === 'notice').map((c) => c.message.text);

/** view_app’s reply while the answer is pending: the agent carries on without the picture, and isn’t told to stop. */
export function carriesOn(r) {
  assert.equal(r.waiting, true);
  assert.match(r.message, /Carry on without the picture for now/);
  assert.doesNotMatch(r.message, /end your turn/i, 'nothing needs the agent to stop (#1975)');
}

/** A browser whose download runs until the test finishes it, saying it’s under way meanwhile, as AppBrowser does. */
export function heldBrowser() {
  let finish = () => {};
  const b = {
    state: 'missing',
    installing: /** @type {Promise<any> | null} */ (null),
    status: () => b.state,
    install: () => {
      b.installing = new Promise((r) => {
        finish = () => {
          b.state = 'ready';
          b.installing = null;
          r({ ok: true });
        };
      });
      return b.installing;
    },
    capture: async () => Buffer.alloc(0),
    close: async () => {},
    finish: () => finish(),
  };
  return b;
}

/** A topic thread of the conversation, started from a message there, for an agent’s turn to run in. */
export const topicOf = (s) => ({ id: s.rt.startTopic(s.t.id, arrange.post(s.rt, s.t.id, { kind: 'user', text: 'Look at this.' }).id).threadId });
