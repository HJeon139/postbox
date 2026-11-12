// #721, from the integrator’s review at 06bc5b81: only the person’s Stop keeps a waiting card’s agent from hearing its
// request expired. A shutdown, a hung stop, or a host turn ended for any other reason leaves the note, so after an
// ordinary restart the agent still learns its request didn’t run. One rule for whom Postbox tells, shared with #776:
// any agent that still exists, archived included, so a Restore finds the note.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { tellExpired } from '../server/permission-expiry.mjs';
import { endCard, openCards } from '../server/remote/turns-prompts.mjs';
import { askStop } from '../server/remote/turns-stops.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { notes, settle, setup } from './permission-expiry-fixture.mjs';
import { rig, running, settled, until } from './remote-turns-helpers.mjs';

const restart = (f) => new Runtime({ store: f.store, adapters: f.rt.adapters, config: f.rt.config });

test('#721 a shutdown with a card waiting leaves exactly one note once Postbox starts again', async () => {
  const f = await setup();
  const { card } = await f.ask();
  await f.rt.stopTurns({ graceMs: 0 });
  await settle(f.rt);
  assert.equal(f.store.item(f.t.id, card.id).status, 'expired');
  assert.equal(f.store.item(f.t.id, card.id).stoppedBy, 'shutdown', 'a shutdown isn’t the person’s Stop');
  restart(f).expireStalePermissions();
  assert.equal(notes(f.now()).length, 1, JSON.stringify(f.now().context));
});

test('#721 a hung stop with a card waiting tells the agent its request expired', async () => {
  const f = await setup();
  await f.ask();
  f.rt.stop(f.now().id, { by: 'hung', why: 'It stopped answering.' });
  await settle(f.rt);
  assert.equal(notes(f.now()).length, 1);
});

test('#721 a host turn stopped for a reason that isn’t the person’s Stop tells the agent', async () => {
  const r = rig();
  const turn = await running(r);
  const a = r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).some((i) => i.remote?.prompt === a), 'the card');
  const card = r.store.items(r.t.id).find((i) => i.remote?.prompt === a);
  r.rt.permissionWaits.delete(card.id); // as after a restart: the card is kept, nothing here waits on it
  askStop(r.rt.remote, r.se().id, r.host.id, r.se().remoteTurn.turn); // a sign-in end, an errored end, a re-ask
  r.d.end(turn);
  await settled(r);
  assert.equal(r.store.item(r.t.id, card.id).stoppedBy, undefined);
  assert.equal(notes(r.se()).length, 1, JSON.stringify(r.se().context));
});

test('#721 an agent archived while its card waits gets no note: archiving stops its turn as the person', async () => {
  const f = await setup();
  await f.ask();
  f.rt.archive(f.now().id);
  await settle(f.rt);
  assert.equal(notes(f.now()).length, 0);
});

test('#721 a note for an agent archived is kept, so a Restore finds it', async () => {
  for (const patch of [{ archived: true }]) {
    const f = await setup();
    const it = f.rt.addItem(f.t.id, {
      kind: 'permission',
      sessionId: f.now().id,
      handle: 'deployer',
      tool: 'Bash',
      summary: 'run the deploy',
      status: 'expired',
    });
    f.rt.updateSession(f.now().id, patch);
    tellExpired(f.rt, f.t.id, it.id);
    assert.equal(notes(f.now()).length, 1, JSON.stringify(patch));
  }
});

test('#721 a subagent’s request is named as its own in the note', async () => {
  const f = await setup();
  const it = f.rt.addItem(f.t.id, {
    kind: 'permission',
    sessionId: f.now().id,
    handle: 'deployer',
    who: 'reviewer',
    tool: 'Bash',
    summary: 'run the tests',
    status: 'expired',
  });
  tellExpired(f.rt, f.t.id, it.id);
  assert.match(notes(f.now())[0], /^\[Postbox\] Your subagent’s \(reviewer\) request to run the tests expired/);
});

test('#721 the person’s Stop on a host turn with a card open marks the card, so its note will say the Stop withdrew it (#853)', async () => {
  const r = rig();
  const turn = await running(r);
  const a = r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).some((i) => i.remote?.prompt === a), 'the card');
  const card = r.store.items(r.t.id).find((i) => i.remote?.prompt === a);
  r.rt.permissionWaits.delete(card.id); // as after a restart: nothing here waits on it, so only the host’s word ends it
  r.rt.stop(r.se().id); // the person’s Stop
  r.d.end(turn);
  await settled(r);
  assert.equal(r.store.item(r.t.id, card.id).stoppedBy, 'you');
  // The card stays open on main after this Stop (#800), so no note yet: #1020 closes it, and then tellExpired sends the
  // withdrawn note, as tests/permission-expiry-host.test.mjs checks for a card its host ends.
  assert.equal(notes(r.se()).length, 0, 'not told it expired');
});

test('#721 a store outage that stops a host turn isn’t the person’s Stop: its card, ended later, tells the agent', async (t) => {
  // The integrator’s probe at f220d7b5. On a store that can reopen, with the host’s link down so the turn hasn’t
  // exited when writes reopen, and the outage’s stop reaches the host turn.
  const dir = await mkdtemp(join(tmpdir(), 'pb-expiry-outage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = rig({ store: await new Store(dir).load() });
  const turn = await running(r);
  const a = r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).some((i) => i.remote?.prompt === a), 'the card');
  const id = r.store.items(r.t.id).find((i) => i.remote?.prompt === a).id;
  r.rt.permissionWaits.delete(id); // nothing here waits on it, so only the host’s word ends it
  await r.store.flush();
  r.d.drop();
  r.store.fail(Object.assign(new Error('disk sync refused'), { code: 'EIO' }));
  await r.store.reload();
  await until(() => r.rt.storeWait.length === 0, 'the outage’s stop to be recorded');
  assert.equal(r.store.item(r.t.id, id).stoppedBy, undefined, 'an outage isn’t the person’s Stop');
  for (const card of openCards(r.rt.remote, turn)) endCard(r.rt.remote, card, 'ended', '', Date.now());
  assert.equal(notes(r.se()).length, 1, JSON.stringify(r.se().context));
  await r.store.close();
});
