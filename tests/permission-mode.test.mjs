// A permission mode changed while a turn runs (#371, #381): a backend that can’t change a running turn keeps the mode
// the turn started with until it ends. setPermissionMode says which sessions’ turns did, and each conversation’s quick
// panel says so for its own session, and counts the persona’s turns in other conversations.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modeWhen } from '../shared/mode-when.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

test('#371 a running turn its backend can’t change is listed, by session, as keeping its mode; with none, nothing is', async () => {
  const { rt, adapter, t, a, alpha } = setup();
  const h = held();
  adapter.next.push(h.step);
  rt.sendMessage(t.id, { text: '@alpha run the tests' });
  await sleep(5);
  assert.deepEqual(await rt.setPermissionMode(a.id, 'bypass'), { ok: true, now: [], later: [alpha.id] });
  assert.equal(rt.persona(a.id).permissionMode, 'bypass', 'the persona changes at once, for its next turns');
  h.release();
  await settle(rt);
  assert.deepEqual(await rt.setPermissionMode(a.id, 'ask'), { ok: true, now: [], later: [] });
});

test('#371 one persona in two conversations: only the one with a running turn says Stop; the other counts it elsewhere', async () => {
  const { rt, adapter, t, a, alpha } = setup();
  const other = rt.createThread({ projectId: 'p1', title: 'Other', personaIds: [a.id] });
  const idle = rt.sessionsIn(other.id).find((x) => x.personaId === a.id);
  const h = held();
  adapter.next.push(h.step);
  rt.sendMessage(t.id, { text: '@alpha run the tests' });
  await sleep(5);
  const r = await rt.setPermissionMode(a.id, 'bypass');
  assert.deepEqual(r.later, [alpha.id], 'the running session, not every session of the persona');
  assert.equal(modeWhen(r, alpha.id), 'from their next turns. Its running turn here keeps the mode it started with until it ends: Stop it to apply this now.');
  assert.equal(modeWhen(r, idle.id), 'from their next turns. Its running turn in another conversation keeps the mode it started with until it ends.');
  assert.equal(
    modeWhen({ now: [], later: ['x', 'y'] }, idle.id),
    'from their next turns. Its 2 running turns in other conversations keep the mode they started with until they end.',
  );
  assert.equal(modeWhen({ now: [idle.id], later: [] }, idle.id), 'from now: its running turn changed too.');
  h.release();
  await settle(rt);
});
