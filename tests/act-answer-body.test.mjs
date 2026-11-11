// The act route sends what rt.act returns as its JSON body (server/index.mjs), so every answer returns one. A wake
// card's answer returned nothing when allowed, and the route threw “The first argument must be of type string …” on
// Buffer.from(undefined): the card was answered, but the page got a 500 and the CLI printed the stack.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settle, setup } from './side-threads-fixture.mjs';

/** A room where @alpha asked to bring in @gamma, as an agent's mention of one outside the room does. */
async function asked() {
  const f = setup();
  f.adapter.next.push(async (c) => c.text('Let’s ask @gamma to check the numbers.'));
  f.rt.sendMessage(f.t.id, { text: `@${f.alpha.handle} go on` });
  await settle(f.rt);
  const card = f.store.items(f.t.id).find((i) => i.kind === 'hop' && i.status === 'open');
  assert.ok(card, 'a wake card asks');
  return { f, card };
}

for (const action of ['confirm', 'decline']) {
  test(`answering a wake card (${action}) returns a body for the route to send`, async () => {
    const { f, card } = await asked();
    const r = await f.rt.act(f.t.id, card.id, action, {});
    assert.deepEqual(r, { ok: true });
    assert.equal(f.store.item(f.t.id, card.id).status, action === 'confirm' ? 'allowed' : 'declined');
    await settle(f.rt);
  });
}
