// How the page applies live frames (shared/live-apply.mjs; designs/architecture/live-progress.md, “Order” and “The
// buffer”): a step frame as its item’s activityStep, only if its rev is newer than what the page has; a session frame
// as the session’s patch; a frame for an item the page doesn’t hold yet kept, bounded, until it does; and a snapshot
// at load, which brings a page that joins mid-turn up to date.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HELD_MOST, liveApplier } from '../shared/live-apply.mjs';
import { EVENTS, emptyState } from '../shared/state.mjs';

/** A page’s state with one reply and one session. */
function page() {
  const s = emptyState();
  EVENTS['item.add'].apply(s, { threadId: 'th_1', item: { id: 'it_1', kind: 'agent', text: '' } });
  EVENTS.session.apply(s, { id: 'se_1', threadId: 'th_1', state: 'tool', currentStep: 'Idle', toolCalls: [] });
  const has = (/** @type {string} */ threadId, /** @type {string} */ id) => (s.items[threadId] ?? []).some((x) => x.id === id);
  return { s, has };
}
const step = (/** @type {number} */ rev, more = {}) => ({
  kind: 'step',
  threadId: 'th_1',
  itemId: 'it_1',
  turnId: 'tu_1',
  rev,
  step: { id: 's1', label: 'Read', ...more },
});
const stepsOf = (/** @type {any} */ s) => s.items.th_1.find((/** @type {any} */ x) => x.id === 'it_1').activity?.steps ?? [];

test('a step frame applies as its item’s activityStep, and tells the page as an item.patch', () => {
  const { s, has } = page();
  const live = liveApplier();
  const changes = live.apply(s, step(1, { state: 'running', input: 'ls' }), has);
  assert.deepEqual(stepsOf(s), [{ id: 's1', label: 'Read', state: 'running', input: 'ls' }]);
  assert.deepEqual(
    changes.map((c) => c.type),
    ['item.patch'],
  );
});

test('a step frame older than what the page has is dropped, so a late one can’t undo a newer one', () => {
  const { s, has } = page();
  const live = liveApplier();
  live.apply(s, step(2, { state: 'done' }), has);
  assert.deepEqual(live.apply(s, step(1, { state: 'running' }), has), []);
  assert.equal(stepsOf(s)[0].state, 'done');
});

test('a session frame applies as the session’s patch, and tells the page the whole session', () => {
  const { s, has } = page();
  const live = liveApplier();
  const changes = live.apply(s, { kind: 'session', sessionId: 'se_1', currentStep: 'Read', toolCount: 2 }, has);
  assert.equal(s.sessions.se_1.currentStep, 'Read');
  assert.equal(s.sessions.se_1.state, 'tool', 'what the frame doesn’t carry stays');
  assert.deepEqual(changes, [{ type: 'session', data: s.sessions.se_1 }]);
  assert.deepEqual(live.apply(s, { kind: 'session', sessionId: 'se_gone', currentStep: 'x' }, has), [], 'a session the page lacks');
});

test('a frame for an item the page doesn’t hold yet waits, bounded, and applies when it does', () => {
  const { s, has } = page();
  const live = liveApplier();
  const early = { ...step(1, { state: 'running' }), itemId: 'it_2' };
  assert.deepEqual(live.apply(s, early, has), []);
  EVENTS['item.add'].apply(s, { threadId: 'th_1', item: { id: 'it_2', kind: 'agent', text: '' } });
  const changes = live.flush(s, has);
  assert.deepEqual(
    changes.map((c) => c.data.id),
    ['it_2'],
  );
  assert.deepEqual(live.flush(s, has), [], 'once');
  for (let i = 0; i < HELD_MOST + 50; i++) live.apply(s, { ...step(i + 1), itemId: `it_x${i}` }, has);
  assert.ok(live.held() <= HELD_MOST);
});

test('a snapshot at load brings a page that joins mid-turn up to date: its steps and its session’s live fields', () => {
  const { s, has } = page();
  const live = liveApplier();
  const changes = live.snapshot(
    s,
    [
      {
        turnId: 'tu_1',
        sessionId: 'se_1',
        threadId: 'th_1',
        itemId: 'it_1',
        steps: [{ id: 's1', label: 'Read', state: 'running' }],
        session: { currentStep: 'Read' },
      },
    ],
    has,
  );
  assert.equal(stepsOf(s)[0].state, 'running');
  assert.equal(s.sessions.se_1.currentStep, 'Read');
  assert.ok(changes.length >= 2);
});
