// bigroom.md phase 1’s trigger, window-paged-back (#531, tools/uat/view-triggers.mjs): the view probe saw you reading
// at one of the seeded big room’s first-day items, so you paged back through the room to its start.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { bigRoomItems, onBigRoomFirstDay } from '../tools/uat/big-room.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { unknownTriggers } from '../tools/uat/triggers.mjs';
import { VIEW_TRIGGERS } from '../tools/uat/view-triggers.mjs';

const T0 = Date.UTC(2026, 10, 4, 9);
const DAY_MS = 24 * 60 * 60 * 1000;
const sample = (step, o = {}) => ({
  step,
  at: T0 + step * 1000,
  where: 'main',
  thread: 't_big',
  origin: T0 - 60_000,
  mode: 'reading',
  anchorId: 'it_big0150',
  expected: 80,
  actual: 80,
  gap: 90_000,
  prev: null,
  settled: true,
  ...o,
});
const trigger = VIEW_TRIGGERS['window-paged-back'];
const run = (views) => trigger.run({ probes: { views } });

test('the big room names its first day’s last item, and the predicate holds for that day’s items only', () => {
  const { items, landmarks } = bigRoomItems();
  const firstDay = items.filter((it) => it.at < items[0].at + DAY_MS);
  assert.equal(landmarks.firstDayLast, firstDay.at(-1).id);
  assert.ok(firstDay.length > 100 && firstDay.length < items.length, 'a first day, not the whole room');
  assert.ok(firstDay.every((it) => onBigRoomFirstDay(it.id)));
  assert.equal(items.filter((it) => onBigRoomFirstDay(it.id)).length, firstDay.length);
  assert.equal(onBigRoomFirstDay(''), false);
  assert.equal(onBigRoomFirstDay('it_somethingelse'), false);
});

test('window-paged-back fires on a settled reading sample anchored at a first-day item', () => {
  const hits = run([sample(1, { anchorId: 'it_big0900' }), sample(2)]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].at, T0 + 2000);
  assert.match(hits[0].evidence, /step 2[\s\S]*it_big0150/);
});

test('window-paged-back stays silent on a later day’s anchor, on following, and on an unsettled sample', () => {
  const later = bigRoomItems().items[600].id;
  assert.deepEqual(run([sample(1, { anchorId: later })]), []);
  assert.deepEqual(run([sample(1, { mode: 'following', anchorId: '' })]), []);
  assert.deepEqual(run([sample(1, { settled: false })]), []);
});

test('window-paged-back can’t tell on a run with no view probe', () => {
  assert.equal(trigger.recorded({ probes: {} }), false);
  assert.equal(trigger.recorded({ probes: { views: [] } }), true);
});

test('bigroom.md’s phase 1 names window-paged-back, and every trigger it names exists', () => {
  const bigroom = parseScenario(readFileSync(new URL('uat/e2e/scenarios/bigroom.md', import.meta.url), 'utf8'));
  assert.ok(bigroom.phases[0].triggers.includes('window-paged-back'), bigroom.phases[0].triggers.join(', '));
  assert.deepEqual(unknownTriggers({ phases: bigroom.phases.slice(0, 1) }), []);
});
