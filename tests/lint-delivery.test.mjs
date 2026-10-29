import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendLint } from '../server/lint-delivery.mjs';

test('#336 a lint turn names an app version that no open page checked', () => {
  const calls = [];
  const timers = [];
  let now = 0;
  const entry = { sessionId: 's1', threadId: 't1', problems: [], sent: false, timer: null };
  const rt = {
    lints: new Map([['turn-1', entry]]),
    config: {
      lintSettleMs: 5,
      lintWaitMaxMs: 15,
      now: () => now,
      setTimer(fn, ms) {
        const timer = { fn, ms, unref() {} };
        timers.push(timer);
        return timer;
      },
    },
    s: {
      apps: { explorer: { id: 'explorer', title: 'Corpus explorer', current: 5, sessionId: 's1', check: { status: 'pending' } } },
      sessions: { s1: { id: 's1' } },
    },
    deliver(sessionId, message, options) {
      calls.push({ sessionId, message, options });
    },
  };

  sendLint(rt, 'turn-1');
  while (timers.length) {
    const timer = timers.shift();
    now += timer.ms;
    timer.fn();
  }

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].message.problems, [
    {
      code: 'app-unchecked',
      message: 'No Postbox page was open to check Corpus explorer v5. It will be checked when one opens.',
      scope: { kind: 'app', id: 'explorer', title: 'Corpus explorer' },
    },
  ]);
});
