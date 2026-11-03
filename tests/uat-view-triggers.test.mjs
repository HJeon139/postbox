// #701’s UAT trigger: a diagram out of view stays unloaded, and draws once it’s scrolled to (tools/uat/view-triggers.mjs).
// It reads the diagram probe tools/uat/observe.mjs records each step before any screenshot scrolls the page.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VIEW_TRIGGERS } from '../tools/uat/view-triggers.mjs';

const T0 = Date.UTC(2026, 10, 3, 23);
const frame = (key, loaded, inView = false) => ({ key, loaded, inView });
const sample = (step, sinceLoad, frames) => ({ step, at: T0 + step * 1000, sinceLoad, frames });
const run = (diagrams) => VIEW_TRIGGERS['diagram-deferred'].run({ probes: { diagrams } });

test('diagram-deferred fires when a diagram out of view stays unloaded after the page settled, then draws', () => {
  const hits = run([sample(1, 9000, [frame('it_a', false), frame('it_b', true, true)]), sample(2, 15000, [frame('it_a', true), frame('it_b', true, true)])]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].at, T0 + 1000);
  assert.match(hits[0].evidence, /it_a/);
});

test('diagram-deferred stays silent when every frame loaded as the room drew (no lazy frames)', () => {
  assert.deepEqual(
    run([sample(1, 9000, [frame('it_a', true), frame('it_b', true, true)]), sample(2, 15000, [frame('it_a', true), frame('it_b', true, true)])]),
    [],
  );
});

test('diagram-deferred stays silent for a frame still loading just after the page opened', () => {
  assert.deepEqual(run([sample(1, 1200, [frame('it_a', false)]), sample(2, 9000, [frame('it_a', true)])]), []);
});

test('diagram-deferred stays silent for a diagram that never drew, and for one unloaded only while in view', () => {
  assert.deepEqual(run([sample(1, 9000, [frame('it_a', false)]), sample(2, 15000, [frame('it_a', false)])]), []);
  assert.deepEqual(run([sample(1, 9000, [frame('it_a', false, true)]), sample(2, 15000, [frame('it_a', true, true)])]), []);
});

test('diagram-deferred says it can’t tell on a run with no diagram probe', () => {
  assert.equal(VIEW_TRIGGERS['diagram-deferred'].recorded({ probes: {} }), false);
  assert.equal(VIEW_TRIGGERS['diagram-deferred'].recorded({ probes: { diagrams: [] } }), true);
});

test('observe records the diagram probe before any screenshot scrolls the page', async () => {
  const { observe } = await import('../tools/uat/observe.mjs');
  const calls = [];
  const item = { key: 'it_a', where: 'conversation', text: 'A diagram', block: null, app: false, diagram: true, math: false, buttons: [], fields: [] };
  const d = {
    kit: {
      ev: async () => {
        calls.push('probe');
        return { sinceLoad: 9000, frames: [{ key: 'it_a', loaded: false, inView: false }] };
      },
    },
    items: async () => [item],
    shotItem: async () => {
      calls.push('shot');
      return null;
    },
  };
  const facts = { probes: {}, state: { threads: {}, sessions: {} }, threads: [] };
  await observe({ d, labels: new Map(), keys: new Map(), seen: new Map(), paths: { shots: '/nowhere' }, timeline: [1, 2], dir: '/', facts });
  assert.deepEqual(calls, ['probe', 'shot']);
  assert.deepEqual(facts.probes.diagrams, [
    { step: 2, at: facts.probes.diagrams[0].at, sinceLoad: 9000, frames: [{ key: 'it_a', loaded: false, inView: false }] },
  ]);
});
