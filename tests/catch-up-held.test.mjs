// #693: a message held for an agent on a card that waits for the person is named in that agent's catch-up, so the agent
// it's for knows it's coming, not only its sender. On 2 November an agent learned of two approvals held for hours only
// when another agent relayed them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { settle, setup } from './side-threads-fixture.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

/** @alpha asks to add @gamma; @beta's wake of @alpha, which needs a card too, is held on that card. */
function heldForAlpha() {
  const f = setup();
  f.rt.createPersona({ handle: 'delta' });
  f.rt.agentWake(f.alpha.id, 'gamma', 'Check the numbers.');
  f.rt.agentWake(f.beta.id, 'delta', 'Draw the chart.');
  return f;
}

test('#693 a message held for an agent in the room is named in its catch-up while the card waits', async () => {
  const f = setup();
  f.rt.agentWake(f.alpha.id, 'gamma', 'Check the numbers.');
  const card = f.store.items(f.t.id).find((i) => i.kind === 'hop' && i.status === 'open');
  arrange.setItem(f.rt, f.t.id, card.id, { held: [{ fromSessionId: f.beta.id, from: 'beta', to: 'alpha', text: 'Approved: #12 and #13.', at: Date.now() }] });
  const text = arrange.catchUp(f.rt, f.store.state.sessions[f.alpha.id]) ?? '';
  assert.match(
    text,
    /@beta’s message to you \(“Approved: #12 and #13\.”\) is held on @alpha’s request to add @gamma \(since \d\d:\d\d UTC\), waiting for the person/,
  );
  f.rt.resolveHop(f.t.id, card.id, false);
  await settle(f.rt);
  assert.doesNotMatch(arrange.catchUp(f.rt, f.store.state.sessions[f.alpha.id]) ?? '', /is held on/, 'gone once the card is answered');
});

test('#693 a message held for another agent isn’t named in this one’s catch-up', () => {
  const f = heldForAlpha();
  assert.doesNotMatch(arrange.catchUp(f.rt, f.store.state.sessions[f.alpha.id]) ?? '', /is held on/);
});

/** @beta asks to add @gamma, and `n` messages for @alpha are held on the card. */
function heldOnAdd(n) {
  const f = setup();
  f.rt.agentWake(f.beta.id, 'gamma', 'Check the numbers.');
  const card = f.store.items(f.t.id).find((i) => i.kind === 'hop' && i.status === 'open');
  const held = Array.from({ length: n }, (_, i) => ({ fromSessionId: f.beta.id, from: 'beta', to: 'alpha', text: `Held ${i + 1}.`, at: Date.now() }));
  arrange.setItem(f.rt, f.t.id, card.id, { held });
  return f;
}

test('#693 the catch-up names at most three held messages, and says how many more', () => {
  const f = heldOnAdd(6);
  const text = arrange.catchUp(f.rt, f.store.state.sessions[f.alpha.id]) ?? '';
  assert.equal(text.match(/is held on/g)?.length, 3);
  assert.match(text, /And 3 more messages for you are held on it/);
});

test('#693 a card held behind a commit isn’t named in the catch-up until it’s published: the catch-up reads what the person sees', async () => {
  const h = await heldStore();
  const f = setup(h.store);
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  // An add card with a message for @alpha held on it, held behind the commit.
  arrange.post(f.rt, f.t.id, {
    kind: 'hop',
    join: true,
    fromSessionId: f.beta.id,
    from: 'beta',
    to: 'gamma',
    text: 'Check the numbers.',
    reason: 'Check the numbers.',
    status: 'open',
    held: [{ fromSessionId: f.beta.id, from: 'beta', to: 'alpha', text: 'Approved.', at: Date.now() }],
  });
  const hops = (items) => items.filter((x) => x.kind === 'hop').length;
  assert.deepEqual([hops(h.store.items(f.t.id)), hops(h.store.pending.items(f.t.id))], [0, 1], 'the card is held');
  assert.doesNotMatch(arrange.catchUp(f.rt, f.store.state.sessions[f.alpha.id]) ?? '', /is held on/);
  h.release();
  await commit;
  await h.store.flush();
  assert.match(
    arrange.catchUp(f.rt, f.store.state.sessions[f.alpha.id]) ?? '',
    /@beta’s message to you \(“Approved\.”\) is held on @beta’s request to add @gamma/,
  );
  await h.store.close();
});
