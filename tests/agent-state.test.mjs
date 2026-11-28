// Each agent’s state, read from records and never from chat (designs/rooms-at-scale.md, “Live state”;
// designs/architecture/services.md, “Agent state”): running with its step, waiting on a job, out of quota, failed, or
// idle. A post still waiting in another agent’s inbox is no state of the sender’s (#1975). One state at a time, the
// first that holds in that order.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentState } from '../shared/agent-state.mjs';

/**
 * A conversation `c1` with two agents, dev and critic, each idle with no jobs, and nothing in the inboxes. Its work
 * list throws if read: an agent’s state reads the session’s bounded jobs, never the conversation’s work, so a paint’s
 * cost doesn’t grow with the work list (#1155’s 10x–100x targets).
 */
function room() {
  return {
    threads: { c1: { id: 'c1' }, side: { id: 'side', parentId: 'c1' } },
    sessions: {
      s1: { id: 's1', handle: 'dev', threadId: 'c1', state: 'idle', currentStep: '', jobs: [] },
      s2: { id: 's2', handle: 'critic', threadId: 'c1', state: 'idle', currentStep: '', jobs: [] },
    },
    work: new Proxy(
      {},
      {
        get() {
          throw new Error('an agent’s state read the work list');
        },
      },
    ),
    inbox: {},
  };
}
const of = (s, id = 's1') => agentState(s.sessions[id]);

test('an agent with nothing to do is idle', () => {
  assert.deepEqual(of(room()), { state: 'idle', detail: '' });
});

test('a running agent says its current step, whatever it is doing', () => {
  for (const state of ['think', 'gen', 'tool']) {
    const s = room();
    Object.assign(s.sessions.s1, { state, currentStep: 'Running npm test' });
    assert.deepEqual(of(s), { state: 'running', detail: 'Running npm test' }, state);
  }
});

test('a turn whose Stop is still ending it says stopping, not its step, so the person sees the Stop took', () => {
  const s = room();
  Object.assign(s.sessions.s1, { state: 'stopping', currentStep: 'Running npm test' });
  assert.deepEqual(of(s), { state: 'stopping', detail: '' });
});

test('a turn still on its host is running, as it is awaiting attach', () => {
  const s = room();
  s.sessions.s1.remoteTurn = { state: 'waiting' };
  assert.equal(of(s).state, 'running');
});

test('an agent whose background job still runs is waiting on that job, the newest one', () => {
  const s = room();
  s.sessions.s1.jobs = [
    { id: 'j1', state: 'running', label: 'npm run build', kept: true },
    { id: 'j2', state: 'running', label: 'Serve the site', kept: true },
  ];
  s.sessions.s2.jobs = [{ id: 'j3', state: 'running', label: 'sleep 100' }];
  assert.deepEqual(of(s), { state: 'job', detail: 'Serve the site' });
});

test('a job that is no longer running is not waited on', () => {
  const s = room();
  s.sessions.s1.jobs = [{ id: 'j1', state: 'done', label: 'npm test' }];
  assert.equal(of(s).state, 'idle');
});

// The room’s inboxes aren’t an input any more, so a post still waiting in one can’t change this: the browser spec
// (tests/browser/agent-state.spec.mjs) shows it on the page.
test('#1975 an agent’s state is read from its session alone: an idle one with no job is idle', () => {
  const s = room();
  assert.deepEqual(of(s), { state: 'idle', detail: '' });
});

test('an agent whose harness ran out of quota says until when', () => {
  const s = room();
  s.sessions.s1.quota = { until: 5000 };
  assert.deepEqual(agentState(s.sessions.s1, 1000), { state: 'quota', detail: '', until: 5000 });
  s.sessions.s1.quota = { until: null };
  assert.deepEqual(agentState(s.sessions.s1, 1000), { state: 'quota', detail: '' }, 'a harness that gives no reset time');
});

test('once the reset time has passed, the quota no longer holds it', () => {
  const s = room();
  s.sessions.s1.quota = { until: 5000 };
  assert.equal(agentState(s.sessions.s1, 6000).state, 'idle');
  s.sessions.s1.state = 'failed';
  assert.equal(agentState(s.sessions.s1, 6000).state, 'failed', 'the turn it failed is still failed');
});

test('an agent that needs the person is waiting on you', () => {
  const s = room();
  s.sessions.s1.state = 'needs';
  assert.deepEqual(of(s), { state: 'you', detail: '' });
});

test('the first state that holds wins: needs you, running, quota, failed, then a job', () => {
  const s = room();
  const se = s.sessions.s1;
  Object.assign(se, { state: 'needs', remoteTurn: { state: 'running' }, quota: { until: Date.now() + 60_000 } });
  assert.equal(of(s).state, 'you', 'a host turn with a card open needs the person');
  Object.assign(se, { state: 'tool', remoteTurn: null });
  assert.equal(of(s).state, 'running', 'a stale quota on a session running again doesn’t say out of quota');
  se.state = 'failed';
  assert.equal(of(s).state, 'quota', 'a turn failed for quota says why, though the session stays failed so nothing wakes it');
  se.quota = undefined;
  assert.equal(of(s).state, 'failed');
  se.state = 'idle';
  se.jobs = [{ id: 'j1', state: 'running', label: 'npm run build' }];
  s.inbox.s2 = [{ id: 'e1', sessionId: 's2', threadId: 'c1', from: 'dev', state: 'waiting', at: 1 }];
  assert.equal(of(s).state, 'job');
  se.jobs = [];
  assert.equal(of(s).state, 'idle', 'a post still waiting elsewhere is no state of its own (#1975)');
});

test('a missing or malformed session reads as idle, not a throw', () => {
  assert.deepEqual(agentState(undefined), { state: 'idle', detail: '' });
  assert.deepEqual(agentState({ id: 'x', handle: 'x', state: 'idle', jobs: 'not a list' }), { state: 'idle', detail: '' });
});
