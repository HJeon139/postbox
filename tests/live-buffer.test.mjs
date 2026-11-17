// A running turn’s live buffer (server/live-buffer.mjs; designs/architecture/live-progress.md, “Commit points” and
// “The buffer”): each update to a step goes to the pages as a live frame with its rev, and is stored only at a commit
// point, a new step of the agent’s own or the turn’s end, without the live view’s detail; the session’s live fields go
// as frames only; the buffer is bounded where it’s built, whatever a harness reports.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveEnd, liveSession, liveSnapshots, liveStep } from '../server/live-buffer.mjs';
import { Store } from '../server/store.mjs';
import { onLive } from '../server/store-live.mjs';
import { LIVE_CAPS, STEP_TEXT } from '../shared/limits.mjs';

/** A store, a running turn on it, what it stores of steps and the frames it sends. */
async function rig() {
  const store = await new Store(null).load();
  /** @type {any[]} */
  const stored = [];
  /** @type {any[]} */
  const frames = [];
  store.subscribe((/** @type {any} */ ev) => ev.type === 'item.patch' && ev.data.activityStep && stored.push(ev.data.activityStep));
  onLive(store, (f) => frames.push(f));
  const turn = { id: 'tu_1', sessionId: 'se_1', threadId: 'th_1', first: 'it_1', steps: [] };
  const rt = { store, running: { all: () => [turn] } };
  return { rt, turn, stored, frames };
}

const run = (/** @type {string} */ id, more = {}) => ({ id, label: `Ran ${id}`, state: 'running', at: 3, part: 'p1', input: 'ls -la', ...more });
const done = (/** @type {string} */ id, more = {}) => ({
  id,
  label: `Ran ${id}`,
  state: 'done',
  output: 'a\nb',
  diff: '-a\n+b',
  detail: 'x'.repeat(5000),
  ...more,
});

test('a step’s updates go live with a rising rev; it’s stored once, at the next step of the agent’s own, without its detail', async () => {
  const { rt, turn, stored, frames } = await rig();
  liveStep(rt, turn, run('s1'));
  liveStep(rt, turn, done('s1'));
  assert.deepEqual(stored, [], 'nothing stored before a commit point');
  assert.deepEqual(
    frames.map((f) => [f.kind, f.step.id, f.rev]),
    [
      ['step', 's1', 1],
      ['step', 's1', 2],
    ],
  );
  assert.equal(frames[1].step.output, 'a\nb', 'the live frame carries the detail');
  liveStep(rt, turn, run('s2'));
  assert.equal(stored.length, 1, 'the new step is a commit point: s1 is stored');
  assert.equal(stored[0].id, 's1');
  assert.equal(stored[0].state, 'done');
  for (const k of ['input', 'output', 'diff']) assert.equal(stored[0][k], undefined, `${k} stays live`);
  assert.equal(stored[0].detail.length, STEP_TEXT.detail, 'detail cut as the fold cuts it');
  assert.equal(stored[0].at, 3, 'at stays, to place it among the words');
  assert.equal(stored[0].part, 'p1');
});

test('a subagent’s step, a thought or narration is no commit point', async () => {
  const { rt, turn, stored } = await rig();
  liveStep(rt, turn, run('s1'));
  liveStep(rt, turn, run('sub', { who: 'helper' }));
  liveStep(rt, turn, run('t1', { kind: 'thought' }));
  liveStep(rt, turn, run('n1', { kind: 'said' }));
  assert.deepEqual(stored, []);
});

test('the session’s live fields go as frames only, merged; the turn’s end stores what’s left and drops the buffer', async () => {
  const { rt, turn, stored, frames } = await rig();
  liveSession(rt, turn, { currentStep: 'Read', toolCount: 1 });
  liveSession(rt, turn, { glimpse: 'Looking' });
  assert.deepEqual(frames.at(-1), { kind: 'session', sessionId: 'se_1', glimpse: 'Looking' });
  liveStep(rt, turn, done('s1'));
  assert.deepEqual(
    liveSnapshots(rt).map((s) => [s.turnId, s.steps.length, s.session.currentStep, s.session.glimpse]),
    [['tu_1', 1, 'Read', 'Looking']],
  );
  liveEnd(rt, turn);
  assert.deepEqual(
    stored.map((s) => s.id),
    ['s1'],
  );
  assert.deepEqual(liveSnapshots(rt), [], 'the buffer is gone');
  liveEnd(rt, turn);
  assert.equal(stored.length, 1, 'a second end stores nothing again');
});

test('the buffer is bounded where it’s built: lists and strings, whatever the harness reports', async () => {
  const { rt, turn, stored, frames } = await rig();
  const huge = 'w'.repeat(LIVE_CAPS.string * 3);
  liveSession(rt, turn, {
    toolCalls: Array.from({ length: 100_000 }, (_, i) => ({ name: `t${i}`, state: 'done' })),
    subagents: Array.from({ length: 10_000 }, (_, i) => ({ id: `a${i}`, name: huge })),
    currentStep: huge,
    glimpse: huge,
  });
  const f = frames.at(-1);
  assert.equal(f.toolCalls.length, LIVE_CAPS.toolCalls);
  assert.equal(f.subagents.length, LIVE_CAPS.subagents);
  assert.equal(f.subagents[0].name.length, LIVE_CAPS.string);
  assert.equal(f.currentStep.length, LIVE_CAPS.string);
  liveStep(rt, turn, run('big', { label: huge, input: huge }));
  assert.equal(frames.at(-1).step.label.length, LIVE_CAPS.string);
  // More steps changed than the buffer holds: it stores them early, so it never holds more.
  for (let i = 0; i < LIVE_CAPS.steps + 10; i++) liveStep(rt, turn, { id: `w${i}`, label: 'x', state: 'running', who: 'helper' });
  assert.ok(liveSnapshots(rt)[0].steps.length <= LIVE_CAPS.steps);
  assert.ok(stored.length >= 10);
});
