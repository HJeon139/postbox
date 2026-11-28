// #1927: the person’s answer about the browser is Postbox’s, not a conversation’s, so it settles each conversation’s
// card. Each conversation shows a card of its own, which the person sees there and whose need is its asker’s; an agent
// whose call comes during a download allowed elsewhere gets a downloading card in its own room, and hears through it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { viewApp } from '../server/view-app/view-app.mjs';
import * as arrange from './arrange.mjs';
import { card, carriesOn, ctx, heldBrowser, missingBrowser, sleep, told, twoAgents } from './view-ask-fixture.mjs';

/** A second conversation with an agent and an app of its own, beside the fixture’s. @param {any} s */
function otherRoom(s) {
  const persona = s.rt.createPersona({ handle: 'editor' });
  const room = s.rt.createThread({ projectId: 'p1', title: 'Elsewhere', personaIds: [persona.id] });
  const se = arrange.sessionsIn(s.rt, room.id)[0];
  const appId = s.rt.toolsFor(se.id).show_app({ title: 'Elsewhere', code: '<p>x</p>' }).appId;
  const cardThere = () => s.rt.store.items(room.id).find((x) => x.kind === 'viewask');
  return { room, se, appId, cardThere };
}

test('#1927 each conversation gets its own card, and the person’s one answer settles both, each telling its own agent', async () => {
  for (const [action, status, said] of [
    ['download', 'ready', /it finished\. Call view_app now/],
    ['decline', 'declined', /chose not to download/],
  ]) {
    const s = twoAgents(missingBrowser());
    try {
      const o = otherRoom(s);
      carriesOn(await viewApp(s.rt, s.first.id, { appId: s.apps.first }, ctx(s.t)));
      carriesOn(await viewApp(s.rt, o.se.id, { appId: o.appId }, ctx(o.room)));
      assert.equal(o.cardThere()?.status, 'open', 'the other conversation has a card of its own, which the person sees there');
      s.rt.act(s.t.id, card(s).id, action);
      for (let i = 0; i < 50 && (card(s).status !== status || o.cardThere().status !== status); i++) await sleep(5);
      assert.deepEqual([card(s).status, o.cardThere().status], [status, status], `${action}: one answer settles both`);
      for (let i = 0; i < 50 && told(s, o.se).length === 0; i++) await sleep(5);
      for (const se of [s.first, o.se]) assert.equal(told(s, se).filter((x) => said.test(x)).length, 1, `${action}, ${se.handle}: ${told(s, se).join(' | ')}`);
    } finally {
      s.done();
    }
  }
});

test('#1927 a call during a download allowed in another conversation shows a downloading card there, and hears when it’s ready', async () => {
  const browser = heldBrowser();
  const s = twoAgents(browser);
  try {
    const o = otherRoom(s);
    await viewApp(s.rt, s.first.id, { appId: s.apps.first }, ctx(s.t));
    s.rt.act(s.t.id, card(s).id, 'download');
    carriesOn(await viewApp(s.rt, o.se.id, { appId: o.appId }, ctx(o.room)));
    assert.equal(o.cardThere()?.status, 'downloading', 'its own room shows the download');
    browser.finish();
    for (let i = 0; i < 50 && told(s, o.se).length === 0; i++) await sleep(5);
    assert.equal(o.cardThere().status, 'ready');
    assert.ok(
      told(s, o.se).some((x) => /it finished\. Call view_app now/.test(x)),
      told(s, o.se).join(' | '),
    );
  } finally {
    s.done();
  }
});

test('#1927 after a failed download, the next call shows a new card, not the failed one', async () => {
  const s = twoAgents(missingBrowser({ ok: false, message: 'No network.' }));
  try {
    await viewApp(s.rt, s.first.id, { appId: s.apps.first }, ctx(s.t));
    s.rt.act(s.t.id, card(s).id, 'download');
    for (let i = 0; i < 50 && card(s).status === 'downloading'; i++) await sleep(5);
    assert.equal(card(s).status, 'failed');
    // The answer stays “allowed” and the browser still isn’t there, so the next call asks again, on a new card.
    await viewApp(s.rt, s.first.id, { appId: s.apps.first }, ctx(s.t));
    const cards = s.rt.store.items(s.t.id).filter((x) => x.kind === 'viewask');
    assert.deepEqual(
      cards.map((x) => x.status),
      ['failed', 'open'],
    );
  } finally {
    s.done();
  }
});

test('#1927 while the download allowed in one conversation runs, the other conversation’s card says so, and its agent no longer needs the person', async () => {
  const browser = heldBrowser();
  const s = twoAgents(browser);
  try {
    const o = otherRoom(s);
    await viewApp(s.rt, s.first.id, { appId: s.apps.first }, ctx(s.t));
    await viewApp(s.rt, o.se.id, { appId: o.appId }, ctx(o.room));
    // Its turn ended waiting on its card, as the UAT’s events show (session.patch, state needs).
    s.rt.sessions.update(o.se.id, { needs: { kind: 'viewask', itemId: o.cardThere().id, text: '@editor asks to see its app' }, state: 'needs' });
    s.rt.act(s.t.id, card(s).id, 'download');
    assert.equal(o.cardThere().status, 'downloading', 'the person answered once, for both');
    assert.equal(s.rt.s.sessions[o.se.id].needs, null, 'so the other agent no longer needs them');
    browser.finish();
    // Settled before the test’s folder goes.
    for (let i = 0; i < 50 && o.cardThere().status === 'downloading'; i++) await sleep(5);
  } finally {
    s.done();
  }
});
