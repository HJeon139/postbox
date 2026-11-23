// #759: a turn left running under an older Postbox on its host, which the host’s daemon couldn’t relay (off) or whose
// relay ended (lost): the turn says so as a step, through the turn’s own context as every step comes, and a lost relay
// ends the turn’s open prompt cards, which no answer can reach now. Built on the rig in tests/remote-turns-helpers.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RELAY_LOST_CARD, relayLostText, relayOffText } from '../server/remote/turns-relay.mjs';
import { FIXTURE_PROMPT } from './fake-daemon.mjs';
import { HOST, restarted, rig, running, settled, startUp, until } from './remote-turns-helpers.mjs';

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
  await until(() => steps(r).some((/** @type {any} */ s) => s.label === relayLostText(OLD, HOST)), 'the step');
  assert.equal(steps(r).filter((/** @type {any} */ s) => s.label === relayLostText(OLD, HOST)).length, 1, 'once');
  r.d.end(turn);
  await settled(r);
});

test('#759 a relay message for a turn Postbox doesn’t run changes nothing', async () => {
  const r = rig();
  const turn = await running(r);
  r.d.relay('another-turn', OLD, 'lost');
  r.d.relay(turn, OLD, 'off');
  await until(() => steps(r).some((/** @type {any} */ s) => s.label === relayOffText(OLD, HOST)), 'this turn’s step');
  assert.ok(!steps(r).some((/** @type {any} */ s) => s.label === relayLostText(OLD, HOST)), 'nothing from the other turn');
  r.d.end(turn);
  await settled(r);
});

test('#759 a turn the host couldn’t relay keeps its open card: the prompt can still be answered from the old Postbox', async () => {
  const r = rig();
  const turn = await running(r);
  r.d.prompt(turn, FIXTURE_PROMPT, 'p-1');
  await until(() => cards(r).some((/** @type {any} */ c) => c.status === 'open'), 'the card');
  r.d.relay(turn, OLD, 'off');
  await until(() => steps(r).some((/** @type {any} */ s) => s.label === relayOffText(OLD, HOST)), 'the step');
  assert.equal(cards(r)[0].status, 'open', 'only a lost relay ends cards');
  r.d.end(turn);
  await settled(r);
});

test('#759 a relay message that comes while the turn is being attached after a restart still reaches it', async () => {
  const { store, d } = restarted({ welcome: 'running' });
  const r = rig({ store, d });
  let release = () => {};
  const held = new Promise((res) => {
    release = () => res(undefined);
  });
  const ensure = r.hosts.ensureWelcome;
  r.hosts.ensureWelcome = async (/** @type {string} */ hostId) => {
    if (hostId === r.host.id) await held;
    return ensure(hostId);
  };
  startUp(r);
  await until(() => r.rt.remote.restoring.has('host-turn-1'), 'the turn waiting to be attached');
  d.relay('host-turn-1', OLD, 'off');
  release();
  await until(() => steps(r).some((/** @type {any} */ s) => s.label === relayOffText(OLD, HOST)), 'the step, once attached');
  d.end('host-turn-1');
  await settled(r);
});
