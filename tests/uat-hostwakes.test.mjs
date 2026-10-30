// tests/uat/e2e/scenarios/hostwakes.md: its triggers and checks (tools/uat/triggers-hostwakes.mjs), on facts shaped as
// a host-mode run records them (tests/uat-hostwakes-fixture.mjs).

import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { placementOf } from '../tools/uat/hosts-options.mjs';
import { readReceived } from '../tools/uat/run-files.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { unknownTriggers } from '../tools/uat/triggers.mjs';
import { HOSTWAKE_TRIGGERS as T } from '../tools/uat/triggers-hostwakes.mjs';

import { check, facts, REFUSED, received, SENT, s, turn, wakeStream } from './uat-hostwakes-fixture.mjs';

test('the scenario parses, and every trigger it names is one the runner knows', () => {
  const sc = parseScenario(readFileSync(new URL('./uat/e2e/scenarios/hostwakes.md', import.meta.url), 'utf8'));
  assert.equal(sc.phases.length, 3);
  assert.deepEqual(unknownTriggers(sc), []);
});

test('the scenario runs with one --host: only @critic is on a host, and the others are here', () => {
  // One test host is enough: the defects need only a sender on a host, and the runner refuses the same destination twice (hostsOf).
  const sc = parseScenario(readFileSync(new URL('./uat/e2e/scenarios/hostwakes.md', import.meta.url), 'utf8'));
  assert.deepEqual(placementOf(sc, [], 1), { researcher: 'local', critic: 'host1', developer: 'local' });
});

test('on main: the card opened, the local sender was told in its turn, and the host sender wasn’t', () => {
  const f = facts();
  assert.equal(T['pair-card-opened'].run(f).length, 1);
  assert.match(T['local-wake-told-in-turn'].run(f)[0].evidence, /wasn’t sent/);
  assert.deepEqual(T['refused-wake-told-in-turn'].run(f), [], 'the host sender started no turn after its refused wake');
  assert.deepEqual(T['held-wake-delivered-after-allow'].run(f), [], 'no target started a turn after the Allow');
});

test('on main: the checks report the host sender told “Sent”, and both hand-offs lost', () => {
  const f = facts();
  const said = check('host-wake-said-sent').run(f);
  assert.equal(said.length, 1);
  assert.match(said[0].title, /@critic on host1 was told its wake of @researcher was sent/);
  assert.deepEqual(
    check('refused-wake-lost')
      .run(f)
      .map((x) => x.title),
    ['@critic’s hand-off to @researcher was refused and lost', '@developer’s hand-off to @critic was refused and lost'],
  );
});

test('after a fix: a host sender woken by its refusal, and a held wake delivered after the Allow, are seen', () => {
  // The host sender starts a turn 20 s after its refused wake. After the Allow at 400 s, Postbox posts the held
  // hand-off as critic's message (as Allow's agentWake does), and its target starts a turn with it.
  const f = {
    ...facts({ extraItems: [turn('critic', s(50)), turn('researcher', s(410))] }),
    received: [received('researcher', 'critic', s(405), 'critic to researcher')],
  };
  assert.equal(T['refused-wake-told-in-turn'].run(f).length, 1);
  assert.match(T['held-wake-delivered-after-allow'].run(f)[0].evidence, /Postbox sent @critic’s refused hand-off to @researcher after you allowed the card/);
  assert.deepEqual(
    check('refused-wake-lost')
      .run(f)
      .map((x) => x.title),
    ['@developer’s hand-off to @critic was refused and lost'],
  );
});

test('a wake its target received is no refusal, even with a card open', () => {
  const f = { ...facts({ extraItems: [turn('researcher', s(35))] }), received: [received('researcher', 'critic', s(31), 'critic to researcher')] };
  assert.deepEqual(check('host-wake-said-sent').run(f), []);
  assert.equal(check('refused-wake-lost').run(f).length, 1, 'only the local one is left');
});

test('a refused wake is seen though another agent woke its target meanwhile, as in the 27 October run', () => {
  // From a hostwakes run of 27 October 2026 (its data/events-1.jsonl and critic’s stream; uat-runs/ isn’t committed): a card from @developer to
  // @researcher opened at 23:46:52. @critic, on the host, called wake_agent with the same text at 23:47:25 and 23:47:36,
  // and the shim answered both with “Sent…”. researcher received only the first; the second was the pair’s third wake and was
  // refused. @developer had woken @researcher at 23:47:34, so @researcher started a turn 10 s after the refusal.
  const at = (hms) => Date.parse(`2026-10-27T${hms}Z`);
  const text = '@researcher @critic has a task for you. Please answer by @-mentioning only @critic.';
  const f = {
    threads: ['th1'],
    state: {
      items: {
        th1: [{ kind: 'hop', from: 'developer', to: 'researcher', at: at('23:46:52'), pair: 2, status: 'open' }, turn('researcher', at('23:47:46'))],
      },
    },
    streams: [
      {
        handle: 'critic',
        events: [
          ...wakeStream('critic', at('23:47:25'), 'researcher', SENT, text).events,
          ...wakeStream('critic', at('23:47:36'), 'researcher', SENT, text).events,
        ],
      },
    ],
    received: [received('researcher', 'critic', at('23:47:25'), text)],
    hosts: { hosts: [{ id: 'h1', label: 'host1' }], placement: { researcher: 'local', critic: 'host1', developer: 'local' } },
  };
  const said = check('host-wake-said-sent').run(f);
  assert.deepEqual(
    said.map((x) => x.key),
    [`critic:researcher:${at('23:47:36')}`],
  );
});

/** A hostwakes run of 28 October 2026 (uat-runs/ isn’t committed): its refused calls, and when the turns after them began. */
function rerun(now) {
  const at = (hms) => Date.parse(`2026-10-28T${hms}Z`);
  const stream = (handle, started, calls = []) => ({
    handle,
    started: at(started),
    events: calls.flatMap(([t, to, result, message]) => wakeStream(handle, at(t), to, result, message).events),
  });
  return {
    at,
    f: {
      now: at(now),
      threads: ['th1'],
      state: {
        items: {
          th1: [
            { kind: 'hop', from: 'researcher', to: 'developer', at: at('01:07:17'), pair: 2, status: 'open' },
            { kind: 'user', text: '@critic, what happened to your hand-off to researcher?', at: at('01:08:35') },
            turn('critic', at('01:08:39')),
            turn('developer', at('01:09:06')),
          ],
        },
      },
      // critic’s refused call at 01:08:24, then the turn the person started at 01:08:35; developer’s refused call at
      // 01:09:03, in the turn that started at 01:08:59, whose first item came at 01:09:06.
      streams: [
        stream('critic', '01:08:16.405', [['01:08:24', 'researcher', SENT, 'Task: count the lines in work/*.txt and post the total.']]),
        stream('critic', '01:08:35.998'),
        stream('developer', '01:08:59.610', [['01:09:03', 'critic', REFUSED, 'Task: list the files in work/ and post their names.']]),
      ],
      hosts: { hosts: [{ id: 'h1', label: 'host1' }], placement: { researcher: 'local', critic: 'host1', developer: 'local' } },
    },
  };
}

test('a turn the person started isn’t the host sender told of its refusal, as in the 28 October rerun', () => {
  const { f } = rerun('01:12:00');
  assert.deepEqual(T['refused-wake-told-in-turn'].run(f), [], '@critic’s turn at 01:08:36 followed the person’s question');
});

test('a refused hand-off is judged lost only 3 minutes on, by turns that started after the call', () => {
  assert.deepEqual(check('refused-wake-lost').run(rerun('01:09:10').f), [], 'during the run, 3 minutes hadn’t passed');
  assert.deepEqual(
    check('refused-wake-lost')
      .run(rerun('01:12:10').f)
      .map((x) => x.title),
    ['@critic’s hand-off to @researcher was refused and lost', '@developer’s hand-off to @critic was refused and lost'],
  );
});

test('a target’s turn started by the card’s own held wake isn’t a refused hand-off delivered, as in the 28 October third run', () => {
  // From a later hostwakes run of 28 October 2026 (uat-runs/ isn’t committed): critic’s wake_agent hand-off to developer at 02:10:37 was refused
  // while researcher’s card to developer waited. The card was allowed at 02:14:00, which delivered researcher’s held
  // thank-you, and developer’s turn started then; critic’s hand-off was never posted.
  const at = (hms) => Date.parse(`2026-10-28T${hms}Z`);
  const f = {
    now: at('02:16:00'),
    threads: ['th1'],
    state: {
      items: {
        th1: [
          { kind: 'hop', from: 'researcher', to: 'developer', at: at('02:05:32'), pair: 2, status: 'allowed' },
          { kind: 'voice', text: 'Allowed: @researcher wakes @developer', at: at('02:14:00') },
          turn('developer', at('02:14:07')),
        ],
      },
    },
    streams: [
      { handle: 'critic', started: at('02:10:33'), events: wakeStream('critic', at('02:10:37'), 'developer', SENT, 'Task: list the files in work/.').events },
      { handle: 'developer', started: at('02:14:00'), events: [] },
    ],
    hosts: { hosts: [{ id: 'h1', label: 'host1' }], placement: { researcher: 'local', critic: 'host1', developer: 'local' } },
  };
  assert.deepEqual(T['held-wake-delivered-after-allow'].run(f), []);
});

test('a refused hand-off is lost though its target had a turn the person started, as in the 28 October third run', () => {
  // From a later hostwakes run of 28 October 2026 (uat-runs/ isn’t committed): developer’s wake_agent hand-off to critic was refused at 02:10:00 while
  // researcher’s card waited; the person then messaged critic at 02:10:23, and critic’s turn started. The hand-off was
  // never posted, so it never reached critic.
  const at = (hms) => Date.parse(`2026-10-28T${hms}Z`);
  const f = {
    now: at('02:16:00'),
    threads: ['th1'],
    state: {
      items: {
        th1: [
          { kind: 'hop', from: 'researcher', to: 'developer', at: at('02:05:32'), pair: 2, status: 'open' },
          { kind: 'user', text: '@critic, write one line that @-mentions developer…', at: at('02:10:23') },
          turn('critic', at('02:10:28')),
        ],
      },
    },
    streams: [
      {
        handle: 'developer',
        started: at('02:09:57'),
        events: wakeStream('developer', at('02:10:00'), 'critic', REFUSED, 'Task: list the files in work/.').events,
      },
      { handle: 'critic', started: at('02:10:23'), events: [] },
    ],
    hosts: { hosts: [{ id: 'h1', label: 'host1' }], placement: { researcher: 'local', critic: 'host1', developer: 'local' } },
  };
  assert.deepEqual(
    check('refused-wake-lost')
      .run(f)
      .map((x) => x.title),
    ['@developer’s hand-off to @critic was refused and lost'],
  );
});

test('a held wake the conversation shows while it waits is still a refusal until its target receives it', () => {
  // #439’s fix may post a held hand-off while it waits, so the person sees it. Only what the target received counts.
  const f = facts({ extraItems: [{ kind: 'agent', handle: 'critic', text: 'critic to researcher', status: 'held', at: s(31) }] });
  assert.equal(check('host-wake-said-sent').run(f).length, 1);
});

test('readReceived reads what each agent received from the store’s session events, merged with what it read before', () => {
  // Session events shaped as in a run’s data/events-1.jsonl, a line each as the store appends them, trimmed to the fields read here.
  const dir = mkdtempSync(join(tmpdir(), 'pb-received-'));
  const msg = (other, text, at) => ({ dir: 'from', other, text, at });
  const line = (seq, data) => JSON.stringify({ seq, type: 'session', data });
  writeFileSync(
    join(dir, 'events-1.jsonl'),
    [
      line(25, { id: 'se_c', handle: 'critic', agentMessages: [msg('researcher', '@critic Ready for your task.', 1)] }),
      line(26, { id: 'se_c', agentMessages: [msg('developer', '@critic, I’m ready for your task.', 2), msg('researcher', '@critic Ready for your task.', 1)] }),
    ]
      .map((l) => `${l}\n`)
      .join(''),
  );
  try {
    const earlier = [{ handle: 'developer', from: 'researcher', text: 'gone with an old segment', at: 0 }];
    assert.deepEqual(
      readReceived(dir, earlier).map((r) => [r.handle, r.from, r.at]),
      [
        ['developer', 'researcher', 0],
        ['critic', 'researcher', 1],
        ['critic', 'developer', 2],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outside host mode, the host check says nothing', () => {
  assert.deepEqual(check('host-wake-said-sent').run({ ...facts(), hosts: undefined }), []);
  assert.equal(T['refused-wake-told-in-turn'].recorded({ ...facts(), hosts: undefined }), false);
});

test('#508: readReceived applies the store’s session.patch events onto the snapshot’s sessions, and unset drops a field', () => {
  // recordAgentMessage writes through updateSession, which emits session.patch, not a whole session (designs/508, “Store
  // events”). The fixture is a run’s data folder: snapshot.json is the state itself, and the log after it holds patches.
  const dir = mkdtempSync(join(tmpdir(), 'pb-received-'));
  cpSync(new URL('./fixtures/uat/received-patches/', import.meta.url), dir, { recursive: true });
  try {
    const got = readReceived(dir);
    assert.deepEqual(
      got.map((r) => [r.handle, r.from, r.text]),
      [
        ['critic', 'researcher', '@critic Ready for your task.'],
        ['critic', 'developer', '@critic, I’m ready for your task.'],
        ['researcher', 'critic', 'critic to researcher'],
      ],
      'the snapshot’s message, the patch’s, and none from a patch to a session the log never held whole',
    );
    assert.equal(
      got.some((r) => r.handle === 'ghost'),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#508: the hostwakes triggers see a hand-off delivered after the Allow when the store recorded it as a session.patch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-received-'));
  cpSync(new URL('./fixtures/uat/received-patches/', import.meta.url), dir, { recursive: true });
  try {
    const f = { ...facts({ extraItems: [turn('critic', s(50)), turn('researcher', s(410))] }), received: readReceived(dir) };
    const seen = T['held-wake-delivered-after-allow'].run(f);
    assert.equal(seen.length, 1, 'the refused hand-off reached @researcher after the Allow');
    assert.match(seen[0].evidence, /Postbox sent @critic’s refused hand-off to @researcher after you allowed the card/);
    assert.deepEqual(
      check('refused-wake-lost')
        .run(f)
        .map((x) => x.title),
      ['@developer’s hand-off to @critic was refused and lost'],
      'critic’s hand-off was delivered, so only developer’s is lost',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
