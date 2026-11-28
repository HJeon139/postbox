// #1927: a view request is one card at a time, wherever the agent’s turn runs, since the answer and the download are
// Postbox’s. A second agent whose view_app call found another agent’s open card was told to end its turn and wait for the
// answer, but only the agent that asked heard it. Now every agent the card was offered to carries on without the
// picture, and each hears how the card ends (#1975: no agent waits behind another).

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

/** view_app’s reply while the answer is pending: the agent carries on without the picture, and isn’t told to stop. */
function carriesOn(r) {
  assert.equal(r.waiting, true);
  assert.match(r.message, /Carry on without the picture for now/);
  assert.doesNotMatch(r.message, /end your turn/i, 'nothing needs the agent to stop (#1975)');
}

/** Both agents call view_app before the person answers, then the person answers the one card. */
async function bothAsk(s, action) {
  carriesOn(await viewApp(s.rt, s.first.id, { appId: s.apps.first }, ctx(s.t)));
  carriesOn(await viewApp(s.rt, s.second.id, { appId: s.apps.second }, ctx(s.t)));
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
    carriesOn(r);
    assert.match(r.message, /still downloading\. Carry on without the picture for now; you’ll hear when it’s ready/);
    // Asked again during the download, it’s noted once; the agent that asked isn’t noted, since it hears anyway.
    await viewApp(s.rt, s.second.id, { appId: s.apps.second }, ctx(s.t));
    await viewApp(s.rt, s.first.id, { appId: s.apps.first }, ctx(s.t));
    assert.deepEqual(card(s).waiting, [s.second.id]);
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

/** A topic thread of the conversation, started from a message there, for an agent’s turn to run in. */
const topicOf = (s) => ({ id: s.rt.startTopic(s.t.id, arrange.post(s.rt, s.t.id, { kind: 'user', text: 'Look at this.' }).id).threadId });

test('#1927 an agent in a topic thread finds the open card in the conversation, gets none of its own, and hears the answer', async () => {
  const s = twoAgents(missingBrowser());
  try {
    carriesOn(await viewApp(s.rt, s.first.id, { appId: s.apps.first }, ctx(s.t)));
    const topic = topicOf(s);
    carriesOn(await viewApp(s.rt, s.second.id, { appId: s.apps.second }, ctx(topic)));
    assert.equal(s.rt.store.items(topic.id).filter((x) => x.kind === 'viewask').length, 0, 'no second card in the topic thread');
    assert.deepEqual(card(s).waiting, [s.second.id]);
    s.rt.act(s.t.id, card(s).id, 'decline');
    for (let i = 0; i < 50 && told(s, s.second).length === 0; i++) await sleep(5);
    assert.equal(told(s, s.second).filter((x) => /chose not to download/.test(x)).length, 1, told(s, s.second).join(' | '));
  } finally {
    s.done();
  }
});

test('#1927 with the download allowed in another thread, an agent is noted on it and hears when it’s ready', async () => {
  const browser = heldBrowser();
  const s = twoAgents(browser);
  try {
    await viewApp(s.rt, s.first.id, { appId: s.apps.first }, ctx(s.t));
    s.rt.act(s.t.id, card(s).id, 'download');
    const r = await viewApp(s.rt, s.second.id, { appId: s.apps.second }, ctx(topicOf(s)));
    carriesOn(r);
    assert.deepEqual(card(s).waiting, [s.second.id], 'the downloading card, in the main thread, notes it');
    browser.finish();
    for (let i = 0; i < 50 && told(s, s.second).length === 0; i++) await sleep(5);
    assert.ok(
      told(s, s.second).some((x) => /it finished\. Call view_app now/.test(x)),
      told(s, s.second).join(' | '),
    );
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

test('#1927 a card still open from before a restart is the one a call finds: no second card, and the agent is noted on it', async () => {
  const s = twoAgents(missingBrowser());
  try {
    // As a restart leaves it: open in the store, never shown by this run of Postbox.
    s.rt.threads.addItem(s.t.id, { kind: 'viewask', sessionId: s.first.id, handle: s.first.handle, turnId: null, status: 'open' });
    carriesOn(await viewApp(s.rt, s.second.id, { appId: s.apps.second }, ctx(topicOf(s))));
    const cards = Object.keys(s.rt.s.threads).flatMap((id) => s.rt.store.items(id).filter((x) => x.kind === 'viewask'));
    assert.equal(cards.length, 1, 'no second card');
    assert.deepEqual(card(s).waiting, [s.second.id]);
  } finally {
    s.done();
  }
});
