// #1746’s UAT triggers and the asks they time (tools/uat/idle-triggers.mjs, mid-turn-asks.mjs) over recorded runs’
// events (tests/fixtures/uat/quiet-rooms.json says which, and how each was cut). No recorded run has an ask whose turn
// went on 30 s past it, so that trigger and its check are tested on a recorded 4.5 s with the bar lowered, and at
// their real bar must find nothing.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { handOffs, quietWhileWaiting } from '../tools/uat/idle-triggers.mjs';
import { midTurnAsks } from '../tools/uat/mid-turn-asks.mjs';
import { ASK_UNCOUNTED_MS, uncountedAskFindings } from '../tools/uat/room-checks-idle.mjs';
import { TRIGGERS } from '../tools/uat/triggers.mjs';

const { runs } = JSON.parse(readFileSync(new URL('./fixtures/uat/quiet-rooms.json', import.meta.url), 'utf8'));

test('room-quiet-while-work-waited fires on a stretch that ended, of a minute or more, waiting on a wake or on nothing', () => {
  const { run, recorded } = TRIGGERS['room-quiet-while-work-waited'];
  assert.equal(recorded({ events: [] }), false);
  assert.deepEqual(run({ events: runs.addressed.events }), [
    { at: 1795471076170, evidence: 'Quiet for 2 min 37 s from 21:55:19 UTC, until @critic’s scheduled wake.' },
  ]);
  // Waiting on the person isn’t the stall this is there to reach, and neither is a room with no definition of done.
  assert.deepEqual(run({ events: runs.needsnav.events }), []);
  assert.deepEqual(run({ events: runs.scifact.events }), []);
  // The same room before the wake came: the stretch is still open, so the run hasn’t seen it end.
  const before = runs.addressed.events.filter((/** @type {any} */ e) => e.seq < 222);
  assert.deepEqual(run({ events: before }), []);
  // A wake that comes once the work has passed isn’t the room waiting on its work.
  const f = { events: runs.addressed.events };
  assert.equal(quietWhileWaiting(f, { asked: 0, queued: null, passed: null }).length, 1);
  assert.deepEqual(quietWhileWaiting(f, { asked: 0, queued: null, passed: { at: 1 } }), []);
});

test('work-handed-between-agents needs two hand-offs between three agents that a turn took, and no message from the person counts', () => {
  const { run } = TRIGGERS['work-handed-between-agents'];
  const f = { events: runs.holdstill.events };
  assert.deepEqual(handOffs(f).slice(0, 3), [
    { from: 'developer', to: 'critic', at: 1795459783677 },
    { from: 'developer', to: 'researcher', at: 1795459783677 },
    { from: 'critic', to: 'developer', at: 1795459789330 },
  ]);
  const [hit, ...rest] = run(f);
  assert.deepEqual(rest, []);
  assert.equal(hit.at, 1795459783677);
  assert.match(hit.evidence, /^5 hand-offs: @developer to @critic, @developer to @researcher, @critic to @developer, /);
  // Two agents asked by the person, each answering only the person: no hand-off, so a coverage gap.
  assert.deepEqual(handOffs({ events: runs.addressed.events }), []);
  assert.deepEqual(run({ events: runs.addressed.events }), []);
  // One hand-off isn’t a team at work: the same room up to the first message one agent’s turn took from another.
  const first = runs.holdstill.events.filter((/** @type {any} */ e) => e.seq <= 262);
  assert.deepEqual(handOffs({ events: first }), [{ from: 'developer', to: 'critic', at: 1795459783677 }]);
  assert.deepEqual(run({ events: first }), []);
  // …and two agents passing work back and forth aren’t three: the room’s entries without @researcher’s.
  const sessionOf = new Map(
    runs.holdstill.events.filter((/** @type {any} */ e) => e.type === 'session').map((/** @type {any} */ e) => [e.data.id, e.data.handle]),
  );
  const pair = runs.holdstill.events.filter(
    (/** @type {any} */ e) => e.type !== 'entry.add' || (e.data.entry.from !== 'researcher' && sessionOf.get(e.data.sessionId) !== 'researcher'),
  );
  assert.equal(handOffs({ events: pair }).length, 2);
  assert.deepEqual(run({ events: pair }), []);
  // A message that waits in an inbox and no turn takes isn’t work handed on.
  const untaken = runs.holdstill.events.filter((/** @type {any} */ e) => !(e.type === 'entry.patch' && e.data.patch.state === 'taken'));
  assert.deepEqual(handOffs({ events: untaken }), []);
});

test('an ask shown mid-turn is timed from when it showed to when its session named it, which on main is the turn’s end', () => {
  const [a, ...rest] = midTurnAsks({ events: runs.addressed.events });
  assert.deepEqual(rest, []);
  assert.deepEqual(a, {
    itemId: 'it_A7KpEE1Q',
    handle: 'researcher',
    title: 'Fix the load script?',
    shownAt: 1795470889059,
    turnMs: 4508,
    uncountedMs: 4508,
    counted: 'at-turn-end',
  });
  const f = { events: runs.addressed.events };
  const [x] = uncountedAskFindings(f, { min: 4000 });
  assert.equal(x.title, 'An ask shown mid-turn didn’t count as needing you for 5 s');
  assert.match(
    x.evidence,
    /^@researcher showed “Fix the load script\?” at 21:54:49 UTC and its turn ran 5 s more\. Its session first named it as what it needs when the turn ended\.$/,
  );
  assert.deepEqual(uncountedAskFindings(f, { min: 4600 }), []);
  assert.deepEqual(uncountedAskFindings(f), [], `4.5 s is under the check’s own bar of ${ASK_UNCOUNTED_MS / 1000} s`);
  // Three agents at work at once: each ask is timed by its own agent’s turn, not by the others’ events.
  assert.deepEqual(
    midTurnAsks({ events: runs.holdstill.events }).map((x) => [x.handle, x.title, x.turnMs, x.counted]),
    [
      ['critic', 'Draft: word-list app spec', 2632, 'never'],
      ['critic', 'Which file name should the app use?', 1994, 'at-turn-end'],
    ],
  );
  // The turn ended 4.5 s after the form, on a closing line: not an ask shown while its agent went on working.
  assert.deepEqual(TRIGGERS['ask-shown-mid-turn'].run(f), []);
});
