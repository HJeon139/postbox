// The integrator's review of PR #451: cases where the hostwakes checks (tools/uat/triggers-hostwakes.mjs) would file a
// false finding against #439, in this scenario or in any other run, each on facts shaped as a run records them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check, SENT, s, turn, wakeStream } from './uat-hostwakes-fixture.mjs';

const HOSTS = { hosts: [{ id: 'h1', label: 'host1' }], placement: { researcher: 'local', critic: 'host1', developer: 'local' } };
/** A conversation’s items, a wake_agent call of developer’s, and what Postbox sent, read four minutes on. */
const run = (items, call, received = [], hosts = HOSTS) => ({
  now: s(400),
  threads: ['th1'],
  state: { items: { th1: items } },
  streams: [call],
  received,
  hosts,
});
const NO_AGENT = 'There’s no agent called @nobody.';

test('a declined card waits no more: a wake made after the Decline that Postbox refused for its own reason isn’t #439', () => {
  const f = run(
    [
      { kind: 'hop', from: 'researcher', to: 'critic', at: s(10), pair: 2, status: 'declined' },
      { kind: 'voice', text: 'Didn’t allow @researcher to wake @critic', at: s(20) },
      turn('developer', s(90)),
    ],
    wakeStream('developer', s(100), 'nobody', NO_AGENT),
  );
  assert.deepEqual(check('refused-wake-lost').run(f), []);
});

test('outside host mode, refused-wake-lost says nothing either: it runs in every UAT run (withRemote)', () => {
  const f = run(
    [{ kind: 'hop', from: 'researcher', to: 'critic', at: s(10), pair: 2, status: 'open' }, turn('developer', s(90))],
    wakeStream('developer', s(100), 'critic', 'refused'),
    [],
    null,
  );
  assert.deepEqual(check('refused-wake-lost').run(f), []);
});

test('a wake to “@Researcher” that Postbox sent researcher was applied: handles match without case, as Postbox matches them', () => {
  const text = 'Count the lines in work/.';
  const f = run(
    [{ kind: 'hop', from: 'developer', to: 'critic', at: s(10), pair: 2, status: 'open' }],
    wakeStream('critic', s(100), 'Researcher', SENT, text),
    [{ handle: 'researcher', from: 'critic', at: s(101), text }],
  );
  assert.deepEqual(check('host-wake-said-sent').run(f), []);
});
