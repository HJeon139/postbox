// A tool or view request through another agent’s wake (#1868): the wake keeps it as the need, as card-needs-kept-turn
// shows, but rings no second “needs you” for it, and another agent’s view_app call leaves it the asking agent’s.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askToSee } from '../server/view-app/consent.mjs';
import * as arrange from './arrange.mjs';
import { room } from './card-needs-fixture.mjs';
import { held, settle, sleep } from './side-threads-fixture.mjs';
import { until } from './stop-reply-fixture.mjs';

/** An open view request from @alpha’s turn before. @param {any} r */
const viewAsk = (r) => arrange.post(r.rt, r.t.id, { kind: 'viewask', sessionId: r.alpha.id, handle: 'alpha', turnId: 'turn_last', status: 'open' });

// A request rang when the turn that raised it ended. Another agent’s wake that keeps it isn’t that request raised again,
// so the wake’s end rings no second “needs you” for it, as a kept block rings none (#69).
for (const kind of ['toolask', 'viewask']) {
  test(`#1868 a ${kind} kept through another agent’s wake rings no second “needs you” at the wake’s end`, async () => {
    const r = room();
    const card = kind === 'toolask' ? r.toolAsk('turn_last', 'ls') : viewAsk(r);
    r.setNeed(kind, card.id);
    /** @type {string[]} */
    const heard = [];
    r.rt.store.subscribe((/** @type {any} */ ev) => ev.type === 'notify' && heard.push(ev.data.level));
    r.adapter.next.push(async (c) => c.text('Thanks, noted.'));
    r.rt.turnService.run(r.alpha.id, { kind: 'agent', from: '@beta', text: 'Here are the numbers.' }); // not you moving on
    await settle(r.rt);
    assert.equal(r.needs()?.itemId, card.id, 'still the need');
    assert.ok(!heard.includes('blocking'), `no second “needs you”, heard ${heard}`);
  });
}

// A view request belongs to its conversation and is offered again only to the agent that asked (askToSee).
test('#1868 another agent’s view_app call leaves the open view request the asking agent’s need', async () => {
  const r = room();
  const card = viewAsk(r);
  r.setNeed('viewask', card.id);
  const work = held();
  r.adapter.next.push(async (c) => {
    askToSee(r.rt, r.beta.id, r.t.id, () => {});
    await work.step(c);
  });
  r.rt.turnService.run(r.beta.id, { kind: 'user', text: '@beta how does the app look?' });
  await until(() => r.rt.turns.has(r.beta.id), 'beta’s turn');
  await sleep(5);
  assert.equal(r.store.pending.item(r.t.id, card.id).turnId, 'turn_last', 'the card stays alpha’s turn’s');
  work.release();
  await settle(r.rt);
  assert.equal(r.needs()?.itemId, card.id, 'and alpha still needs you for it');
});
