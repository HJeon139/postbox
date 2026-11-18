// #1488 removed the card that held an app’s sends for the person to allow. A data folder from before it can still hold
// one, open, and the agent’s need for it: it loads, the card closes with a plain line, and it never makes anyone need
// the person again, at a restart or at its agent’s next turn’s end (server/old-app-sends.mjs).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { settleInterrupted } from '../server/restart-sweep.mjs';
import { Runtime } from '../server/runtime.mjs';
import { needsYouNow } from '../shared/needs.mjs';
import * as arrange from './arrange.mjs';
import { room } from './card-needs-fixture.mjs';
import { settle } from './side-threads-fixture.mjs';

/** An open card as Postbox stored it before #1488, from @alpha’s app. @param {any} r */
const oldCard = (r) =>
  arrange.post(r.rt, r.t.id, {
    kind: 'appsend',
    sessionId: r.alpha.id,
    appId: 'app1',
    title: 'Spam',
    events: [
      { action: 'x', values: {}, voice: 'Sent from Spam: x' },
      { action: 'y', values: {}, voice: 'Sent from Spam: y' },
    ],
    status: 'open',
    notifiedAt: 1,
  });

/** A second runtime on the same store, as a restart makes one, with the restart’s sweep run. @param {any} r */
function restart(r) {
  const rt = new Runtime({
    store: r.store,
    adapters: new AdapterRegistry().register(r.adapter),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  settleInterrupted(rt);
  return rt;
}

test('#1488 an old open app-send card, and the need saved for it, load closed after a restart: nobody needs you', () => {
  const r = room();
  const card = oldCard(r);
  arrange.setSession(r.rt, r.alpha.id, { needs: { kind: 'appsend', itemId: card.id, text: 'Spam wants to send 2 messages for you' }, state: 'needs' });
  const rt = restart(r);
  const se = rt.s.sessions[r.alpha.id];
  assert.equal(se.needs ?? null, null, 'the need saved for it is gone');
  assert.equal(se.state, 'idle');
  assert.equal(needsYouNow(se), false);
  const after = r.store.item(r.t.id, card.id);
  assert.notEqual(after.status, 'open', 'the card no longer waits');
  assert.equal(after.text, 'Spam asked to send 2 messages for you, in an older Postbox. Nothing waits on it.', 'a plain line to show');
});

test('#1488 an old open app-send card makes nobody need you when its agent’s turn ends', async () => {
  const r = room();
  oldCard(r);
  r.rt.sendMessage(r.t.id, { text: '@alpha go on' });
  await settle(r.rt);
  assert.equal(r.needs() ?? null, null);
  assert.equal(r.rt.s.sessions[r.alpha.id].state, 'idle');
});

test('#1488 an old answered app-send card loads with its plain line, and stays answered', () => {
  const r = room();
  const card = arrange.post(r.rt, r.t.id, {
    kind: 'appsend',
    sessionId: r.alpha.id,
    appId: 'app1',
    title: 'Spam',
    events: [{ action: 'x' }],
    status: 'allowed',
  });
  restart(r);
  const after = r.store.item(r.t.id, card.id);
  assert.equal(after.status, 'allowed');
  assert.equal(after.text, 'Spam asked to send 1 message for you, in an older Postbox. Nothing waits on it.');
});

test('#1488 a second start changes nothing: the old cards were already closed and given their lines', () => {
  const r = room();
  oldCard(r);
  restart(r);
  const seq = r.store.state.seq;
  restart(r);
  assert.equal(r.store.state.seq, seq, 'no write');
});
