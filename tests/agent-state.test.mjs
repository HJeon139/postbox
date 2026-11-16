// Each agent’s state, read from records and never from chat (designs/rooms-at-scale.md, “Live state”;
// designs/architecture/services.md, “Agent state”): running with its step, waiting on a job, waiting behind another
// agent, failed, or idle. One state at a time, the first that holds in that order.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentState } from '../shared/agent-state.mjs';

/** A conversation `c1` with two agents, dev and critic, each idle, and nothing in its work or inboxes. */
function room() {
  return {
    threads: { c1: { id: 'c1' }, side: { id: 'side', parentId: 'c1' } },
    sessions: {
      s1: { id: 's1', handle: 'dev', threadId: 'c1', state: 'idle', currentStep: '' },
      s2: { id: 's2', handle: 'critic', threadId: 'c1', state: 'idle', currentStep: '' },
    },
    work: { c1: [] },
    inbox: {},
  };
}
const of = (s, id = 's1') => agentState(s.sessions[id], s);

test('an agent with nothing to do is idle', () => {
  assert.deepEqual(of(room()), { state: 'idle', detail: '' });
});

test('a running agent says its current step, whatever it is doing', () => {
  for (const state of ['think', 'gen', 'tool', 'stopping']) {
    const s = room();
    Object.assign(s.sessions.s1, { state, currentStep: 'Running npm test' });
    assert.deepEqual(of(s), { state: 'running', detail: 'Running npm test' }, state);
  }
});

test('a turn still on its host is running, as it is awaiting attach', () => {
  const s = room();
  s.sessions.s1.remoteTurn = { state: 'waiting' };
  assert.equal(of(s).state, 'running');
});

test('an agent whose background command still runs is waiting on that job', () => {
  const s = room();
  s.work.c1.push(
    { kind: 'command', id: 'w1', sessionId: 's1', state: 'done', command: 'npm ci' },
    { kind: 'command', id: 'w2', sessionId: 's1', state: 'background', command: 'npm run build\n--watch', description: '' },
    { kind: 'command', id: 'w3', sessionId: 's2', state: 'background', command: 'sleep 100' },
  );
  assert.deepEqual(of(s), { state: 'job', detail: 'npm run build' });
  s.work.c1[1].description = 'Build the site';
  assert.deepEqual(of(s), { state: 'job', detail: 'Build the site' });
});

test('a job that ended, or one whose state is unknown, is not waited on', () => {
  const s = room();
  s.work.c1.push({ kind: 'command', id: 'w1', sessionId: 's1', state: 'unknown', command: 'npm test' });
  assert.equal(of(s).state, 'idle');
});

test('an agent whose post still waits in another agent’s inbox is waiting behind it, since then', () => {
  const s = room();
  s.inbox.s2 = [
    { id: 'e1', sessionId: 's2', threadId: 'c1', from: 'dev', state: 'delivered', at: 1 },
    { id: 'e2', sessionId: 's2', threadId: 'side', from: 'dev', state: 'waiting', at: 2000 },
  ];
  assert.deepEqual(of(s), { state: 'behind', detail: 'critic', since: 2000 });
  assert.equal(of(s, 's2').state, 'idle', 'the agent it waits on has its own state');
});

test('an entry already taken by a turn is no longer waited behind', () => {
  const s = room();
  s.inbox.s2 = [{ id: 'e1', sessionId: 's2', threadId: 'c1', from: 'dev', state: 'taken', at: 1 }];
  assert.equal(of(s).state, 'idle');
});

test('only the agent’s own conversation counts', () => {
  const s = room();
  s.threads.c2 = { id: 'c2' };
  s.sessions.s3 = { id: 's3', handle: 'critic', threadId: 'c2', state: 'idle' };
  s.inbox.s3 = [{ id: 'e1', sessionId: 's3', threadId: 'c2', from: 'dev', state: 'waiting', at: 1 }];
  s.work.c2 = [{ kind: 'command', id: 'w1', sessionId: 's1', state: 'background', command: 'x' }];
  assert.equal(of(s).state, 'idle');
});

test('an agent whose harness ran out of quota says until when', () => {
  const s = room();
  s.sessions.s1.quota = { until: 5000 };
  assert.deepEqual(agentState(s.sessions.s1, s, 1000), { state: 'quota', detail: '', until: 5000 });
  s.sessions.s1.quota = { until: null };
  assert.deepEqual(agentState(s.sessions.s1, s, 1000), { state: 'quota', detail: '' }, 'a harness that gives no reset time');
});

test('once the reset time has passed, the quota no longer holds it', () => {
  const s = room();
  s.sessions.s1.quota = { until: 5000 };
  assert.equal(agentState(s.sessions.s1, s, 6000).state, 'idle');
  s.sessions.s1.state = 'failed';
  assert.equal(agentState(s.sessions.s1, s, 6000).state, 'failed', 'the turn it failed is still failed');
});

test('an agent that needs the person is waiting on you', () => {
  const s = room();
  s.sessions.s1.state = 'needs';
  assert.deepEqual(of(s), { state: 'you', detail: '' });
});

test('the first state that holds wins: quota, failed, running, a job, then behind', () => {
  const s = room();
  s.sessions.s1.quota = { until: Date.now() + 60_000 };
  s.sessions.s1.state = 'tool';
  assert.equal(of(s).state, 'quota');
  s.sessions.s1.state = 'failed';
  assert.equal(of(s).state, 'quota', 'a turn failed for quota says why, though the session stays failed so nothing wakes it');
  s.sessions.s1.quota = undefined;
  s.sessions.s1.state = 'idle';
  s.work.c1.push({ kind: 'command', id: 'w1', sessionId: 's1', state: 'background', command: 'npm run build' });
  s.inbox.s2 = [{ id: 'e1', sessionId: 's2', threadId: 'c1', from: 'dev', state: 'waiting', at: 1 }];
  assert.equal(of(s).state, 'job');
  s.sessions.s1.state = 'tool';
  assert.equal(of(s).state, 'running');
  s.sessions.s1.state = 'failed';
  assert.deepEqual(of(s), { state: 'failed', detail: '' });
});

test('a missing session or room reads as idle, not a throw', () => {
  assert.deepEqual(agentState(undefined, room()), { state: 'idle', detail: '' });
  assert.deepEqual(agentState({ id: 'x', handle: 'x', state: 'idle' }, {}), { state: 'idle', detail: '' });
});
