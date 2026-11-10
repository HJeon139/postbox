// A host’s permission card that expired before the person answered it (#721, server/permission-expiry.mjs), through the
// remote rig: the agent is told once for each card its host expired or ended, or that an Allow reached too late, and not
// at all when the person stopped the turn. Split from permission-expiry.test.mjs, which holds this computer’s paths.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askStop } from '../server/remote/turns-stops.mjs';
import { FIXTURE_PROMPTS } from './fake-daemon.mjs';
import { rig, running, settled, until } from './remote-turns-helpers.mjs';

const notes = (se) => (se.context ?? []).filter((n) => /expired before the person answered/.test(n));
const withdrawn = (se) =>
  (se.context ?? []).filter((n) => /was still waiting for the person when they stopped your turn, so it didn’t run\. They didn’t refuse it\./.test(n));

test('#721 a host’s card its host expired, or ended, tells the agent once for each card', async () => {
  const r = rig();
  const turn = await running(r);
  const a = r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).some((i) => i.remote?.prompt === a), 'the first card');
  r.d.expire(turn, a);
  await until(() => r.store.items(r.t.id).find((i) => i.remote?.prompt === a).status === 'expired', 'the card expired');
  // A second call’s prompt: one call gets one card (#353).
  const b = r.d.prompt(turn, FIXTURE_PROMPTS[1]);
  await until(() => r.store.items(r.t.id).some((i) => i.remote?.prompt === b), 'the second card');
  r.link.hear({ type: 'error', code: 'internal', re: 'prompt-expired', turn, id: b, message: 'Couldn’t write it down.' });
  assert.equal(r.store.items(r.t.id).find((i) => i.remote?.prompt === b).status, 'ended');
  // The host saying so again changes nothing.
  r.link.hear({ type: 'prompt-expired', turn, id: a, at: 1_760_000_000_000 });
  r.d.end(turn);
  await settled(r);
  assert.equal(notes(r.se()).length, 2, JSON.stringify(r.se().context));
  assert.equal(r.se().needs, null);
});

test('#721 an Allow that reached the host after it stopped waiting expires the card, and the agent is told', async () => {
  const r = rig();
  const turn = await running(r);
  const a = r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).some((i) => i.remote?.prompt === a), 'the card');
  const card = r.store.items(r.t.id).find((i) => i.remote?.prompt === a);
  r.rt.resolvePermission(r.t.id, card.id, 'allow');
  r.link.hear({ type: 'error', code: 'no-prompt', re: 'answer', turn, id: a, message: 'Nothing waits for that answer.' });
  assert.equal(r.store.item(r.t.id, card.id).status, 'expired');
  assert.equal(notes(r.se()).length, 1, JSON.stringify(r.se().context));
});

test('#721 a host card with no wait here, left open when the person stops the turn, ends; #853 the note says the Stop withdrew it', async () => {
  const r = rig();
  const turn = await running(r);
  const a = r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).some((i) => i.remote?.prompt === a), 'the card');
  const card = r.store.items(r.t.id).find((i) => i.remote?.prompt === a);
  r.rt.permissionWaits.delete(card.id); // as after a restart: the card is kept, nothing here waits on it
  askStop(r.rt.remote, r.se().id, r.host.id, r.se().remoteTurn.turn, { byPerson: true }); // the person’s Stop
  r.d.end(turn);
  await settled(r);
  assert.equal(r.store.item(r.t.id, card.id).status, 'expired');
  assert.equal(r.store.item(r.t.id, card.id).stoppedBy, 'you');
  assert.equal(notes(r.se()).length, 0, 'not told it expired');
  assert.equal(withdrawn(r.se()).length, 1, JSON.stringify(r.se().context));
});
