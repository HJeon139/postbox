// #693: a message held for an agent on a card that waits for the person is named in that agent's catch-up, so the agent
// it's for knows it's coming, not only its sender. On 2 November an agent learned of two approvals held for hours only
// when another agent relayed them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catchUp } from '../server/catch-up.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

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
