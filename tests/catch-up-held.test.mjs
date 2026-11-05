// #693: a message held for an agent on a card that waits for the person is named in that agent's catch-up, so the agent
// it's for knows it's coming, not only its sender. On 2 November an agent learned of two approvals held for hours only
// when another agent relayed them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catchUp } from '../server/catch-up.mjs';
import { HOP_LIMIT } from '../shared/limits.mjs';
import { settle, setup } from './side-threads-fixture.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

/** @alpha asks to add @gamma; @beta's wake of @alpha, which needs a card too, is held on that card. */
function heldForAlpha() {
  const f = setup();
  f.rt.createPersona({ handle: 'delta' });
  f.rt.toolsFor(f.alpha.id).wake_agent({ handle: 'gamma', message: 'Check the numbers.' });
  f.rt.toolsFor(f.beta.id).wake_agent({ handle: 'delta', message: 'Draw the chart.' });
  return f;
}

test('#693 a message held for an agent in the room is named in its catch-up while the card waits', async () => {
  const f = setup();
  f.rt.toolsFor(f.alpha.id).wake_agent({ handle: 'gamma', message: 'Check the numbers.' });
  const card = f.store.items(f.t.id).find((i) => i.kind === 'hop' && i.status === 'open');
  f.rt.patchItem(f.t.id, card.id, { held: [{ fromSessionId: f.beta.id, from: 'beta', to: 'alpha', text: 'Approved: #12 and #13.', at: Date.now() }] });
  const text = catchUp(f.rt, f.store.state.sessions[f.alpha.id]) ?? '';
  assert.match(
    text,
    /@beta’s message to you \(“Approved: #12 and #13\.”\) is held on @alpha’s request to add @gamma \(since \d\d:\d\d UTC\), waiting for the person/,
  );
  f.rt.resolveHop(f.t.id, card.id, false);
  await settle(f.rt);
  assert.doesNotMatch(catchUp(f.rt, f.store.state.sessions[f.alpha.id]) ?? '', /is held on/, 'gone once the card is answered');
});

test('#693 a message held for another agent isn’t named in this one’s catch-up', () => {
  const f = heldForAlpha();
  assert.doesNotMatch(catchUp(f.rt, f.store.state.sessions[f.alpha.id]) ?? '', /is held on/);
});

/** A card from @beta's wake of @alpha past the chain limit, left open, with `n` more wakes of @alpha held on it. */
function wakeLimitCard(n) {
  const f = setup();
  for (let i = 0; i < HOP_LIMIT; i++) f.rt.agentWake(...(i % 2 ? [f.alpha.id, 'beta'] : [f.beta.id, 'alpha']), `hand-off ${i + 1}`);
  f.rt.agentWake(f.beta.id, 'alpha', 'The card’s own wake.');
  for (let i = 0; i < n; i++) f.rt.agentWake(f.beta.id, 'alpha', `Held ${i + 1}.`);
  return f;
}

test('#693 a wake-limit card’s own wake for this agent is named too, with what’s held on it', () => {
  const f = wakeLimitCard(1);
  const text = catchUp(f.rt, f.store.state.sessions[f.alpha.id]) ?? '';
  assert.match(text, /@beta’s message to you \(“The card’s own wake\.”\) is held on @beta’s request to wake @alpha/);
  assert.match(text, /@beta’s message to you \(“Held 1\.”\) is held on/);
});

test('#693 the catch-up names at most three held messages, and says how many more', () => {
  const f = wakeLimitCard(5);
  const text = catchUp(f.rt, f.store.state.sessions[f.alpha.id]) ?? '';
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
  // A wake-limit card for @alpha, as askToWake makes it, held behind the commit.
  f.rt.addItem(f.t.id, {
    kind: 'hop',
    fromSessionId: f.beta.id,
    from: 'beta',
    to: 'alpha',
    text: 'Approved.',
    reason: 'Approved.',
    status: 'open',
    n: HOP_LIMIT + 1,
  });
  const hops = (items) => items.filter((x) => x.kind === 'hop').length;
  assert.deepEqual([hops(h.store.items(f.t.id)), hops(h.store.pending.items(f.t.id))], [0, 1], 'the card is held');
  assert.doesNotMatch(catchUp(f.rt, f.store.state.sessions[f.alpha.id]) ?? '', /is held on/);
  h.release();
  await commit;
  await h.store.flush();
  assert.match(catchUp(f.rt, f.store.state.sessions[f.alpha.id]) ?? '', /@beta’s message to you \(“Approved\.”\) is held on @beta’s request to wake @alpha/);
  await h.store.close();
});
