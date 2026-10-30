// The delivery checks on a room read mid-run (#508, server/room-delivery.mjs’s turnsOf): a turn still under way
// hasn’t ended, however long ago its stream’s file was last written, so what it hasn’t done yet isn’t judged. The rooms
// are hand-built from the shapes UAT runs record (tests/delivery-fixture.mjs says why, and which). Moved from
// tests/uat-checks-delivery.test.mjs for size.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inputsOf, recorded, turnsOf } from '../server/room-delivery.mjs';
import { runChecks } from '../tools/uat/checks.mjs';
import { ROUND_TWO, room, T0 } from './delivery-fixture.mjs';

const s = (n) => T0 + n * 1000;
const found = (f, id) => runChecks(f, { only: [id] });

// The delivery run of 29 October 2026, event 1599: @researcher’s marker moved, its turn hadn’t written yet when a live
// check read it, and it did write later.

/**
 * @researcher’s marker moves as its turn’s prompt is built, and the turn is still running with no output yet, and no
 * line of it in the transcript, as a turn tools/uat/fault-launcher.mjs cuts has none (one that recorded its prompt
 * delivered what the catch-up gave, DL-3).
 */
function runningMarkerRoom() {
  const r = room();
  r.agent('researcher');
  r.add({ id: 'it_a', at: s(1), kind: 'user', text: 'First message' });
  r.marker('researcher', null, s(0));
  r.marker('researcher', 'it_a', s(10));
  r.turn('researcher', s(10) + 3, { prompt: 'First message', output: false, ms: 5, running: true, recorded: false });
  return r;
}

test('marker-before-output doesn’t judge a turn still running with no output yet, nor once it writes', () => {
  const r = runningMarkerRoom();
  assert.deepEqual(found(r.f, 'marker-before-output'), []);
  r.end('researcher', s(30), { output: true });
  assert.deepEqual(found(r.f, 'marker-before-output'), []);
});

test('marker-before-output treats a stream with no end as a turn still running', () => {
  const r = runningMarkerRoom();
  Object.assign(r.f.state.sessions.se_researcher, { state: 'idle', finishedAt: undefined });
  delete r.f.streams[0].ended;
  assert.deepEqual(found(r.f, 'marker-before-output'), []);
});

test('marker-before-output still fires once the running turn ends with no output', () => {
  const r = runningMarkerRoom();
  r.end('researcher', s(30));
  assert.equal(found(r.f, 'marker-before-output').length, 1);
});

/** @critic mentions @researcher; its first turn after doesn’t hold it, and its second is still running. */
function secondRunningRoom() {
  const r = room();
  r.agent('researcher');
  r.agent('critic');
  r.add({ id: 'it_round2', at: s(10), kind: 'agent', handle: 'critic', sessionId: 'se_critic', text: ROUND_TWO });
  r.turn('researcher', s(20), { prompt: '[Postbox] You: Allowed: @critic wakes @researcher' });
  r.turn('researcher', s(40), { prompt: '[Postbox] What happened in this room since your last turn:\n\nYou: are we done?', ms: 5, running: true });
  return r;
}

test('delivery-dropped waits for the second turn after a mention to end before it calls the mention dropped', () => {
  const r = secondRunningRoom();
  assert.deepEqual(found(r.f, 'delivery-dropped'), []);
  // The turn reads the mention before it ends.
  r.end('researcher', s(60), { output: true, results: [`Message it_round2: ${ROUND_TWO}`] });
  assert.deepEqual(found(r.f, 'delivery-dropped'), []);
});

test('delivery-dropped fires once the running second turn ends without the mention', () => {
  const r = secondRunningRoom();
  r.end('researcher', s(60), { output: true });
  assert.deepEqual(
    found(r.f, 'delivery-dropped').map((x) => x.key),
    ['delivery-dropped:researcher:it_round2'],
  );
});

test('a running turn with no transcript line yet isn’t one a check couldn’t read', () => {
  const r = room();
  r.agent('critic');
  const text = '@critic please review the latest changes and report blocking problems.';
  r.add({ id: 'it_first', at: s(1), kind: 'user', text });
  r.turn('critic', s(2), { prompt: `Message it_first: ${text}` });
  // Claude Code hasn’t written this turn’s prompt yet.
  r.turn('critic', s(40), { ms: 5, recorded: false, running: true });
  assert.deepEqual(found(r.f, 'unlabeled-repeat'), []);
  const running = turnsOf(r.f, 'critic').at(-1);
  assert.equal(running?.running, true);
  assert.equal(recorded(inputsOf(r.f, 'critic') ?? [], /** @type {any} */ (running)), true);
});
