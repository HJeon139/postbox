// #934: an app’s sends go one after another (app/js/send-chain.mjs). A send waits until the one before it has an
// answer, or until that one has itself run for SEND_TURN_MS: the turn starts when that send starts, not when it was
// queued, so a slow burst keeps its order. With mock timers, so the times are exact.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inOrder, SEND_TURN_MS } from '../app/js/send-chain.mjs';

/** A send the test answers by hand. Records when it started, on the mock clock. */
function heldSend(log, name, now) {
  /** @type {(v?: any) => void} */
  let answer = () => {};
  const send = () => {
    log.push({ name, at: now() });
    return new Promise((done) => {
      answer = done;
    });
  };
  return { send, answer: () => answer(name) };
}
/** Lets every pending then and resolve run. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test('#934 three slow sends of 4 s each start one after another, each once the one before has answered', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const log = [];
  const sends = ['one', 'two', 'three'].map((name) => heldSend(log, name, Date.now));
  const done = sends.map((s) => inOrder('app-slow', s.send));
  await settle();
  assert.deepEqual(
    log.map((x) => x.name),
    ['one'],
  );
  t.mock.timers.tick(4000);
  sends[0].answer();
  await settle();
  assert.deepEqual(
    log.map((x) => x.name),
    ['one', 'two'],
    'two starts once one answers',
  );
  // 1.5 s into two’s own run, 5.5 s after all three were queued: three must still wait for two.
  t.mock.timers.tick(1500);
  await settle();
  assert.deepEqual(
    log.map((x) => x.name),
    ['one', 'two'],
    'three waits for two, whose own turn has 3.5 s left',
  );
  t.mock.timers.tick(2500);
  sends[1].answer();
  await settle();
  assert.deepEqual(
    log.map((x) => x.name),
    ['one', 'two', 'three'],
  );
  sends[2].answer();
  assert.deepEqual(await Promise.all(done), ['one', 'two', 'three']);
});

test('#934 a send with no answer holds back the next for SEND_TURN_MS of its own run, then the next starts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const log = [];
  const [stuck, next] = ['stuck', 'next'].map((name) => heldSend(log, name, Date.now));
  inOrder('app-stuck', stuck.send);
  const after = inOrder('app-stuck', next.send);
  await settle();
  t.mock.timers.tick(SEND_TURN_MS - 1);
  await settle();
  assert.deepEqual(
    log.map((x) => x.name),
    ['stuck'],
    'still the stuck one’s turn',
  );
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(
    log.map((x) => x.name),
    ['stuck', 'next'],
    'the next starts once that turn is over',
  );
  next.answer();
  assert.equal(await after, 'next');
});
