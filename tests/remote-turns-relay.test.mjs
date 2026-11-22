// #759: a turn left running under an older Postbox on its host, which the host’s daemon couldn’t relay (off) or whose
// relay ended (lost): the turn says so as a step, through the turn’s own context as every step comes, and a lost relay
// ends the turn’s open prompt cards, which no answer can reach now. Built on the rig in tests/remote-turns-helpers.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RELAY_LOST_CARD, relayLostText, relayOffText } from '../server/remote/turns-relay.mjs';
import { FIXTURE_PROMPT } from './fake-daemon.mjs';
import { HOST, rig, running, settled, until } from './remote-turns-helpers.mjs';

const OLD = '0.9.0';
const steps = (/** @type {any} */ r) => r.rt.turns.get(r.se().id)?.steps ?? [];
const cards = (/** @type {any} */ r) => r.store.items(r.t.id).filter((/** @type {any} */ i) => i.kind === 'permission');

test('#759 a turn the host couldn’t relay says so as a step', async () => {
  const r = rig();
  const turn = await running(r);
  r.d.relay(turn, OLD, 'off');
  const off = () => steps(r).find((/** @type {any} */ s) => s.label === relayOffText(OLD, HOST));
  await until(() => off(), 'the step');
  assert.equal(off().state, 'failed');
  r.d.end(turn);
  await settled(r);
});

test('#759 a lost relay says so once, and ends the turn’s open card, which no answer can reach', async () => {
  const r = rig();
  const turn = await running(r);
  r.d.prompt(turn, FIXTURE_PROMPT, 'p-1');
  await until(() => cards(r).some((/** @type {any} */ c) => c.status === 'open'), 'the card');
  r.d.relay(turn, OLD, 'lost');
  await until(() => cards(r)[0].status === 'expired', 'the card ended');
  assert.equal(cards(r)[0].remote.answer.message, RELAY_LOST_CARD, 'what the agent hears');
  r.d.relay(turn, OLD, 'lost');
  await until(() => steps(r).some((/** @type {any} */ s) => s.label === relayLostText(HOST)), 'the step');
  assert.equal(steps(r).filter((/** @type {any} */ s) => s.label === relayLostText(HOST)).length, 1, 'once');
  r.d.end(turn);
  await settled(r);
});

test('#759 a relay message for a turn Postbox doesn’t run changes nothing', async () => {
  const r = rig();
  const turn = await running(r);
  r.d.relay('another-turn', OLD, 'lost');
  r.d.relay(turn, OLD, 'off');
  await until(() => steps(r).some((/** @type {any} */ s) => s.label === relayOffText(OLD, HOST)), 'this turn’s step');
  assert.ok(!steps(r).some((/** @type {any} */ s) => s.label === relayLostText(HOST)), 'nothing from the other turn');
  r.d.end(turn);
  await settled(r);
});
