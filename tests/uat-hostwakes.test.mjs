// tests/uat/e2e/scenarios/hostwakes.md: its triggers and checks (tools/uat/triggers-hostwakes.mjs), on facts shaped as
// a host-mode run records them. The wake_agent results are the texts Postbox gives: on a host, the shim’s answer as an
// agent on a host got it on 26 October 2026 (“Sent your message for … to Postbox. Postbox applies it as soon as it’s
// connected to this host.”); here, busyCard’s refusal (server/side-threads.mjs).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { placementOf } from '../tools/uat/hosts-options.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { unknownTriggers } from '../tools/uat/triggers.mjs';
import { HOSTWAKE_CHECKS, HOSTWAKE_TRIGGERS as T } from '../tools/uat/triggers-hostwakes.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

const SENT = 'Sent your message for researcher to Postbox. Postbox applies it as soon as it’s connected to this host.';
const REFUSED = 'Your message to @critic wasn’t sent: another request is waiting for the person to answer it. Send it again once they have.';
const T0 = Date.parse('2026-10-26T10:00:00Z');
const s = (n) => T0 + n * 1000;

/** A wake_agent call in a stream, with its result. */
const wakeStream = (handle, at, to, result, message = `${handle} to ${to}`) => ({
  handle,
  events: [
    {
      type: 'assistant',
      timestamp: new Date(at).toISOString(),
      message: { content: [{ type: 'tool_use', id: `tu-${handle}-${at}`, name: 'mcp__postbox__wake_agent', input: { handle: to, message } }] },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu-${handle}-${at}`, content: [{ type: 'text', text: result }] }] } },
  ],
});
const turn = (handle, at) => ({ kind: 'agent', turnId: `t-${handle}-${at}`, handle, sessionId: `se-${handle}`, status: 'done', at });

/** The run on today’s main: a pair card opened at 10 s; both refused hand-offs lost; the card allowed at 400 s. */
function facts({ allowedAt = s(400), extraItems = [] } = {}) {
  return {
    threads: ['th1'],
    state: {
      items: {
        th1: [
          turn('researcher', s(1)),
          { kind: 'hop', from: 'researcher', to: 'critic', at: s(10), pair: 2, status: allowedAt ? 'allowed' : 'open' },
          turn('critic', s(20)),
          turn('developer', s(25)),
          ...(allowedAt ? [{ kind: 'voice', text: 'Allowed: @researcher wakes @critic', at: allowedAt }] : []),
          ...extraItems,
        ],
      },
    },
    streams: [wakeStream('critic', s(30), 'researcher', SENT), wakeStream('developer', s(100), 'critic', REFUSED)],
    hosts: {
      hosts: [{ id: 'h1', label: 'host1' }],
      placement: { researcher: 'local', critic: 'host1', developer: 'local' },
    },
  };
}
const check = (id) => HOSTWAKE_CHECKS.find((c) => c.id === id);

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
  // The host sender starts a turn 20 s after its refused wake; the target starts one after the card is allowed.
  const f = facts({ extraItems: [turn('critic', s(50)), turn('researcher', s(410))] });
  assert.equal(T['refused-wake-told-in-turn'].run(f).length, 1);
  assert.match(T['held-wake-delivered-after-allow'].run(f)[0].evidence, /@researcher started a turn after you allowed the card/);
  assert.deepEqual(
    check('refused-wake-lost')
      .run(f)
      .map((x) => x.title),
    ['@developer’s hand-off to @critic was refused and lost'],
  );
});

/** The message Postbox posts as the sender’s when it applies a wake (agentWake, server/side-threads.mjs). */
const posted = (handle, at, text) => ({ kind: 'agent', handle, text, status: 'done', at });

test('a wake Postbox posted is no refusal, even with a card open', () => {
  const f = facts({ extraItems: [posted('critic', s(31), 'critic to researcher'), turn('researcher', s(35))] });
  assert.deepEqual(check('host-wake-said-sent').run(f), []);
  assert.equal(check('refused-wake-lost').run(f).length, 1, 'only the local one is left');
});

test('a refused wake is seen though another agent woke its target meanwhile, as in the 27 October run', () => {
  // From uat-runs/2026-10-27T23-45-51-hostwakes (data/events-1.jsonl and critic’s stream): a card from @developer to
  // @researcher opened at 23:46:52. @critic, on the host, called wake_agent with the same text at 23:47:25 and 23:47:36,
  // and the shim answered both with “Sent…”. Postbox posted only the first; the second was the pair’s third wake and was
  // refused. @developer had woken @researcher at 23:47:34, so @researcher started a turn 10 s after the refusal.
  const at = (hms) => Date.parse(`2026-10-27T${hms}Z`);
  const text = '@researcher @critic has a task for you. Please answer by @-mentioning only @critic.';
  const f = {
    threads: ['th1'],
    state: {
      items: {
        th1: [
          { kind: 'hop', from: 'developer', to: 'researcher', at: at('23:46:52'), pair: 2, status: 'open' },
          posted('critic', at('23:47:25'), text),
          turn('researcher', at('23:47:46')),
        ],
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
    hosts: { hosts: [{ id: 'h1', label: 'host1' }], placement: { researcher: 'local', critic: 'host1', developer: 'local' } },
  };
  const said = check('host-wake-said-sent').run(f);
  assert.deepEqual(
    said.map((x) => x.key),
    [`critic:researcher:${at('23:47:36')}`],
  );
});

/** The 28 October rerun (uat-runs/2026-10-28T01-06-14-hostwakes): its refused calls, and when the turns after them began. */
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

test('outside host mode, the host check says nothing', () => {
  assert.deepEqual(check('host-wake-said-sent').run({ ...facts(), hosts: undefined }), []);
  assert.equal(T['refused-wake-told-in-turn'].recorded({ ...facts(), hosts: undefined }), false);
});

/** The fixture's room with @gamma, and a pair card from @alpha's third wake of @beta in a row, left open (phase 1). */
async function cardOpen() {
  const f = setup();
  f.rt.ensureSession(f.t.id, f.c.id);
  const gamma = f.rt.sessionsIn(f.t.id).find((x) => x.handle === 'gamma');
  const wake = async (from, to) => {
    const r = f.rt.agentWake(from.id, to, `${from.handle} to ${to}`);
    await settle(f.rt);
    return r;
  };
  await wake(f.alpha, 'beta');
  await wake(f.beta, 'alpha');
  assert.equal((await wake(f.alpha, 'beta')).waiting, true, 'the third wake in a row raised the card');
  return { ...f, gamma, wake };
}

test('a message from the person clears the counts, so a hand-off right after it goes through though a card waits', async () => {
  const { rt, t, gamma, wake } = await cardOpen();
  rt.sendMessage(t.id, { text: 'hand @alpha the line count' });
  await settle(rt);
  assert.equal((await wake(gamma, 'alpha')).ok, true, 'the first wake since the message never reaches the card check');
});

test('as phase 2 plays it, a hand-off that is a pair’s third wake since the person’s message is refused', async () => {
  // Each hand-off follows one message from the person: a request, its answer, then the hand-off, all between two agents.
  const { rt, t, alpha, gamma, wake } = await cardOpen();
  rt.sendMessage(t.id, { text: '@gamma ask @alpha, then hand it the line count' });
  await settle(rt);
  assert.equal((await wake(gamma, 'alpha')).ok, true);
  assert.equal((await wake(alpha, 'gamma')).ok, true);
  assert.match((await wake(gamma, 'alpha')).message, /wasn’t sent: another request is waiting for the person/);
});
