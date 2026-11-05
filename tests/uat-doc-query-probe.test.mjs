// #564-b1’s UAT trigger, session-scoped (tools/uat/view-triggers.mjs), on samples recorded by its probe
// (tools/uat/doc-query-probe.mjs) through tests/browser/doc-query-probe.spec.mjs, in the same 1,000-item room with an
// open ask: on `main` at fdea9398, where each session event ran lookups over the whole document, and on #564-b1.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ROOM_FLOOR, SESSION_FLOOR, VIEW_TRIGGERS } from '../tools/uat/view-triggers.mjs';

const recorded = (name) => JSON.parse(readFileSync(new URL(`fixtures/uat/doc-queries-${name}.json`, import.meta.url), 'utf8'));
const onMain = recorded('main');
const scoped = recorded('scoped');
const trigger = VIEW_TRIGGERS['session-scoped'];
const run = (docQueries) => trigger.run({ probes: { docQueries } });

test('the recorded samples are what they say: main’s session events scanned the document, #564-b1’s didn’t', () => {
  const [mainLast, scopedLast] = [onMain.at(-1), scoped.at(-1)];
  assert.equal(mainLast.sessionEvents, 6);
  assert.ok(mainLast.scanCount > 0, 'main scanned');
  assert.ok(mainLast.scans.includes('querySelectorAll [data-open-asks]'));
  assert.equal(scopedLast.sessionEvents, 6);
  assert.equal(scopedLast.scanCount, 0);
  assert.equal(scopedLast.items, 1001);
});

test('session-scoped fires on #564-b1’s samples, at the last one, and names what it heard', () => {
  const hits = run(scoped);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].at, scoped.at(-1).at);
  assert.match(hits[0].evidence, /By step 4 the page had handled 6 session events in a conversation of 1001 items/);
});

test('session-scoped stays silent on main’s samples', () => {
  assert.deepEqual(run(onMain), []);
});

test('session-scoped stays silent when a scan came in any sample, even a later page load’s', () => {
  assert.deepEqual(run([...scoped, { ...onMain.at(-1), origin: scoped[0].origin + 60_000 }]), []);
});

test(`session-scoped stays silent until the page has heard ${SESSION_FLOOR} session events`, () => {
  const few = scoped.map((s) => ({ ...s, sessionEvents: Math.min(s.sessionEvents, SESSION_FLOOR - 1) }));
  assert.deepEqual(run(few), []);
  assert.equal(run(scoped.map((s) => ({ ...s, sessionEvents: Math.min(s.sessionEvents, SESSION_FLOOR) }))).length, 1);
});

test(`session-scoped stays silent in a room under ${ROOM_FLOOR} items, and fires at exactly ${ROOM_FLOOR}`, () => {
  assert.deepEqual(run(scoped.map((s) => ({ ...s, items: ROOM_FLOOR - 1 }))), []);
  assert.equal(ROOM_FLOOR, 1000);
  assert.equal(run(scoped.map((s) => ({ ...s, items: ROOM_FLOOR }))).length, 1);
});

test('session-scoped is silent with no samples, and recorded only when the probe ran', () => {
  assert.deepEqual(run([]), []);
  assert.equal(trigger.recorded({ probes: {} }), false);
  assert.equal(trigger.recorded({ probes: { docQueries: [] } }), true);
});
