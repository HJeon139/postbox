// A host turn’s permission card that waits on nothing here (one kept across a restart, whose wait wasn’t) ends when
// Postbox stops following its turn (#800, #965’s G2): on any stop but a shutdown, on its end, and when Postbox gives up
// attaching it after a restart. A shutdown keeps it, for the turn attached again after the restart. Built on the rig in
// tests/remote-turns-helpers.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { FIXTURE_PROMPT } from './fake-daemon.mjs';
import { restarted, rig, running, settled, startUp, until } from './remote-turns-helpers.mjs';

const cards = (r) => r.store.items(r.t.id).filter((i) => i.kind === 'permission');

/** A host turn with its prompt’s card open, and that card’s wait gone from this computer, as after a restart. */
async function orphaned() {
  const r = rig();
  const turn = await running(r);
  r.d.prompt(turn, FIXTURE_PROMPT, 'p-1');
  await until(() => cards(r).some((c) => c.status === 'open'), 'the card');
  const card = cards(r)[0];
  r.rt.permissionWaits.delete(card.id);
  return { r, turn, card };
}

for (const [by, opts] of [
  ['you', {}],
  ['hung', { by: 'hung', why: 'Stopped: no output for 15 min' }],
])
  test(`#800 after a ${by} stop, a host card that waits on nothing here expires`, async () => {
    const { r, turn, card } = await orphaned();
    r.rt.stop(r.se().id, /** @type {any} */ (opts));
    r.d.end(turn);
    await settled(r);
    assert.equal(r.store.item(r.t.id, card.id).status, 'expired');
  });

test('#800 a shutdown keeps that card open, for the turn attached again after the restart', async () => {
  const { r, card } = await orphaned();
  r.rt.stop(r.se().id, { silent: true, by: 'shutdown' });
  await settled(r);
  assert.equal(r.store.item(r.t.id, card.id).status, 'open');
});

test('#800 a card that still waits here is answered once by the Stop, as before', async () => {
  const r = rig();
  const turn = await running(r);
  r.d.prompt(turn, FIXTURE_PROMPT, 'p-1');
  await until(() => cards(r).some((c) => c.status === 'open'), 'the card');
  r.rt.stop(r.se().id);
  r.d.end(turn);
  await settled(r);
  assert.notEqual(cards(r)[0].status, 'open');
  assert.equal(r.d.answers.filter((a) => a.id === 'p-1').length, 1, 'one answer to the host');
});

for (const why of ['moved', 'unregistered'])
  test(`#965 a card restored with a turn Postbox gives up attaching (${why}) expires with it`, async () => {
    const { store, d } = restarted();
    const r = rig({ store, d });
    if (why === 'moved') r.store.emit('persona', { ...r.rt.persona(r.se().personaId), remote: null });
    else arrange.withoutAdapters(r.rt);
    startUp(r);
    await until(() => r.se().remoteTurn?.state === 'interrupted', 'Interrupted');
    assert.equal(cards(r)[0].status, 'expired');
  });
