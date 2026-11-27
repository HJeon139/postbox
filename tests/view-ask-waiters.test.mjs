// #1927: a view request is one card per conversation. A second agent whose view_app call finds another agent’s open
// card was told to end its turn and wait for the answer, but only the agent that asked heard it. Each agent that was
// told to wait now hears how the card ends.

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ScriptedAdapter {
  name = 'mock';
  calls = [];
  async deliver(session, message, ctx) {
    this.calls.push({ sessionId: session.id, message });
    await ctx.text('ok');
  }
}

/** A browser not yet downloaded, whose download does what the test says. @param {{ ok: boolean, message?: string }} install */
const missingBrowser = (install = { ok: true }) => {
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
function twoAgents(browser, handles = ['researcher', 'critic']) {
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
const ctx = (t) => ({ threadId: () => t.id, endSegment() {}, images: true });
const card = (s) => s.rt.store.items(s.t.id).find((x) => x.kind === 'viewask');
const told = (s, se) => s.adapter.calls.filter((c) => c.sessionId === se.id && c.message.kind === 'notice').map((c) => c.message.text);

/** Both agents call view_app before the person answers, then the person answers the one card. */
async function bothAsk(s, action) {
  const r1 = await viewApp(s.rt, s.first.id, { appId: s.apps.first }, ctx(s.t));
  const r2 = await viewApp(s.rt, s.second.id, { appId: s.apps.second }, ctx(s.t));
  assert.equal(r1.waiting, true);
  assert.equal(r2.waiting, true, 'the second agent is told to wait for the answer too');
  // Asked again before the answer, it’s noted once.
  await viewApp(s.rt, s.second.id, { appId: s.apps.second }, ctx(s.t));
  assert.deepEqual(card(s).waiting, [s.second.id], 'the card notes the second agent, once');
  assert.equal(s.rt.store.items(s.t.id).filter((x) => x.kind === 'viewask').length, 1, 'one card');
  s.rt.act(s.t.id, card(s).id, action);
  for (let i = 0; i < 50 && card(s).status === 'downloading'; i++) await sleep(5);
  await s.rt.idle?.();
}

test('#1927 two agents ask before the person answers; the person allows; both are told to look now', async () => {
  const s = twoAgents(missingBrowser());
  try {
    await bothAsk(s, 'download');
    assert.equal(card(s).status, 'ready');
    for (const se of [s.first, s.second])
      assert.ok(
        told(s, se).some((x) => /it finished\. Call view_app now/.test(x)),
        `${se.handle}: ${told(s, se).join(' | ')}`,
      );
  } finally {
    s.done();
  }
});

test('#1927 the person declines, or the download fails: both agents hear it, once each', async () => {
  for (const [action, install, said] of [
    ['decline', { ok: true }, /chose not to download/],
    ['download', { ok: false, message: 'No network.' }, /it failed: No network\./],
  ]) {
    const s = twoAgents(missingBrowser(install));
    try {
      await bothAsk(s, action);
      for (const se of [s.first, s.second])
        assert.equal(told(s, se).filter((x) => said.test(x)).length, 1, `${action}, ${se.handle}: ${told(s, se).join(' | ')}`);
    } finally {
      s.done();
    }
  }
});

test('#1927 declining with another agent waiting still releases the asking agent’s need', async () => {
  const s = twoAgents(missingBrowser());
  try {
    await viewApp(s.rt, s.first.id, { appId: s.apps.first }, ctx(s.t));
    await viewApp(s.rt, s.second.id, { appId: s.apps.second }, ctx(s.t));
    // The asking agent’s turn ended waiting on the card (session.patch, state needs).
    s.rt.sessions.update(s.first.id, { needs: { kind: 'viewask', itemId: card(s).id, text: '@researcher asks to see its app' }, state: 'needs' });
    s.rt.act(s.t.id, card(s).id, 'decline');
    assert.equal(s.rt.s.sessions[s.first.id].needs, null, 'the asking agent no longer needs the person');
  } finally {
    s.done();
  }
});

/** A browser whose download runs until the test finishes it, saying it’s under way meanwhile, as AppBrowser does. */
function heldBrowser() {
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

test('#1927 an agent that calls view_app while the allowed download runs hears when it’s ready', async () => {
  const browser = heldBrowser();
  const s = twoAgents(browser);
  try {
    await viewApp(s.rt, s.first.id, { appId: s.apps.first }, ctx(s.t));
    s.rt.act(s.t.id, card(s).id, 'download');
    assert.equal(card(s).status, 'downloading');
    const r = await viewApp(s.rt, s.second.id, { appId: s.apps.second }, ctx(s.t));
    assert.equal(r.waiting, true);
    assert.match(r.message, /still downloading\. End your turn; you’ll hear when it’s ready/);
    browser.finish();
    for (let i = 0; i < 50 && card(s).status === 'downloading'; i++) await sleep(5);
    assert.equal(card(s).status, 'ready');
    for (const se of [s.first, s.second])
      assert.ok(
        told(s, se).some((x) => /it finished\. Call view_app now/.test(x)),
        `${se.handle}: ${told(s, se).join(' | ')}`,
      );
  } finally {
    s.done();
  }
});

test('#1927 with the download allowed in another conversation, an agent is told to call again, not to wait', async () => {
  const browser = heldBrowser();
  const s = twoAgents(browser);
  try {
    await viewApp(s.rt, s.first.id, { appId: s.apps.first }, ctx(s.t));
    s.rt.act(s.t.id, card(s).id, 'download');
    // Another conversation, with no card of its own.
    const other = s.rt.createThread({ projectId: 'p1', title: 'Elsewhere', personaIds: [s.second.personaId] });
    const there = arrange.sessionsIn(s.rt, other.id)[0];
    const appId = s.rt.toolsFor(there.id).show_app({ title: 'Elsewhere', code: '<p>x</p>' }).appId;
    const r = await viewApp(s.rt, there.id, { appId }, ctx(other));
    assert.equal(r.waiting, false, 'no card here would tell it');
    assert.match(r.message, /call view_app again in a minute or two/);
    browser.finish();
  } finally {
    s.done();
  }
});

test('#1927 a waiting agent retired or deleted before the answer is skipped, and the agents after it are still told', async () => {
  for (const gone of ['retired', 'deleted']) {
    const s = twoAgents(missingBrowser(), ['researcher', 'critic', 'editor']);
    try {
      const [asker, middle, last] = s.all;
      await viewApp(s.rt, asker.id, { appId: s.apps.first }, ctx(s.t));
      await viewApp(s.rt, middle.id, { appId: s.apps.second }, ctx(s.t));
      await viewApp(s.rt, last.id, { appId: s.appOf(last) }, ctx(s.t));
      if (gone === 'retired') arrange.setSession(s.rt, middle.id, { retiredFork: true });
      else s.rt.deleteSession(middle.id);
      s.rt.act(s.t.id, card(s).id, 'decline');
      // The notices go through delivery, which runs each agent’s turn after this one.
      for (let i = 0; i < 50 && told(s, last).length === 0; i++) await sleep(5);
      for (const se of [asker, last]) assert.equal(told(s, se).filter((x) => /chose not to download/.test(x)).length, 1, `${gone}: ${se.handle}`);
    } finally {
      s.done();
    }
  }
});
