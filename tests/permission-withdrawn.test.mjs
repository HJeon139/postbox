// #853: a card still waiting when the person’s Stop or Send now ends its turn is told to the agent at its next turn as
// withdrawn by the stop, not refused, since Claude Code’s own text for the cut-off call (“The user doesn’t want to
// proceed…”) reads as a refusal. Every other stop keeps #721’s note that the request expired. Built on
// tests/permission-expiry-fixture.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXPIRED_NOTE, notes, settle, setup, WITHDRAWN_NOTE } from './permission-expiry-fixture.mjs';

test('#853 Send now ends the turn, and its next turn hears the waiting request was withdrawn, not refused', async () => {
  const { rt, t, calls, ask, now } = await setup();
  await ask();
  rt.sendMessage(t.id, { text: 'never mind, do this instead', sendNow: true });
  await settle(rt);
  const heard = calls.at(-1).context ?? [];
  assert.equal(heard.filter((n) => WITHDRAWN_NOTE.test(n)).length, 1, JSON.stringify(heard));
  assert.equal(heard.filter((n) => EXPIRED_NOTE.test(n)).length, 0);
  assert.equal(notes(now()).length, 0, 'told once');
});

test('#853 the person’s Stop: the next turn hears it once, and the turn after doesn’t', async () => {
  const { rt, t, calls, ask, now } = await setup();
  await ask();
  rt.stop(now().id);
  await settle(rt);
  rt.sendMessage(t.id, { text: 'go on' });
  await settle(rt);
  assert.equal((calls.at(-1).context ?? []).filter((n) => WITHDRAWN_NOTE.test(n)).length, 1);
  rt.sendMessage(t.id, { text: 'and now?' });
  await settle(rt);
  assert.equal((calls.at(-1).context ?? []).filter((n) => WITHDRAWN_NOTE.test(n)).length, 0);
});

test('#853 a hung stop keeps #721’s note that the request expired', async () => {
  const { rt, ask, now } = await setup();
  await ask();
  rt.stop(now().id, { by: 'hung', why: 'Stopped: no output for 15 min' });
  await settle(rt);
  assert.deepEqual(
    notes(now()).map((n) => EXPIRED_NOTE.test(n)),
    [true],
    JSON.stringify(now().context),
  );
});
