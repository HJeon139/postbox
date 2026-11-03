// #701’s UAT trigger: the page deferred a diagram out of view, and loaded it once it neared the view
// (tools/uat/view-triggers.mjs). It reads the diagram probe tools/uat/observe.mjs records each step before any screenshot
// scrolls the page. The eager cases are what Chromium shows without #701: every frame’s page requested, and the frames out
// of view still not drawn.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VIEW_TRIGGERS } from '../tools/uat/view-triggers.mjs';

const T0 = Date.UTC(2026, 10, 3, 23);
const frame = (key, loaded, inView = false) => ({ key, loaded, inView });
const sample = (step, sinceLoad, requested, frames, full = false) => ({ step, at: T0 + step * 1000, sinceLoad, requested, full, frames });
const run = (diagrams) => VIEW_TRIGGERS['diagram-deferred'].run({ probes: { diagrams } });
const lazyRoom = [
  sample(1, 9000, 1, [frame('it_a', false), frame('it_b', false), frame('it_c', true, true)]),
  sample(2, 15000, 2, [frame('it_a', true), frame('it_b', false), frame('it_c', true, true)]),
];

test('diagram-deferred fires when fewer pages were asked for than frames, and a frame out of view loaded later', () => {
  const hits = run(lazyRoom);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].at, T0 + 1000);
  assert.match(hits[0].evidence, /asked for 1 of its 3[\s\S]*it_a[\s\S]*asked for 2/);
});

test('diagram-deferred stays silent on eager frames: every page asked for, though those out of view never drew', () => {
  assert.deepEqual(
    run([
      sample(1, 9000, 3, [frame('it_a', false), frame('it_b', false), frame('it_c', true, true)]),
      sample(2, 15000, 3, [frame('it_a', true), frame('it_b', false), frame('it_c', true, true)]),
    ]),
    [],
  );
});

test('diagram-deferred stays silent on eager frames when a new reply with a diagram adds a request', () => {
  assert.deepEqual(
    run([
      sample(1, 9000, 3, [frame('it_a', false), frame('it_b', false), frame('it_c', true, true)]),
      sample(2, 15000, 4, [frame('it_a', true), frame('it_b', false), frame('it_c', true), frame('it_d', true, true)]),
    ]),
    [],
  );
});

test('diagram-deferred stays silent when only a frame that had already drawn is out of view and drawn later', () => {
  const frames = [frame('it_x', true), frame('it_b', false), frame('it_c', true, true)];
  assert.deepEqual(run([sample(1, 9000, 2, frames), sample(2, 15000, 3, frames)]), []);
});

test('diagram-deferred stays silent when the later draw came with no new request, or after a reload', () => {
  assert.deepEqual(run([lazyRoom[0], { ...lazyRoom[1], requested: 1 }]), []);
  assert.deepEqual(run([lazyRoom[0], { ...lazyRoom[1], sinceLoad: 2000 }]), []);
});

test('diagram-deferred stays silent for a frame unloaded only while in view, or one that never drew', () => {
  assert.deepEqual(
    run([
      sample(1, 9000, 1, [frame('it_a', false, true), frame('it_c', true, true)]),
      sample(2, 15000, 2, [frame('it_a', true, true), frame('it_c', true, true)]),
    ]),
    [],
  );
  assert.deepEqual(run([lazyRoom[0], { ...lazyRoom[1], frames: lazyRoom[0].frames }]), []);
});

test('diagram-deferred skips a sample whose timing buffer was full, and can’t tell on a run with no diagram probe', () => {
  assert.deepEqual(run([{ ...lazyRoom[0], full: true }, lazyRoom[1]]), []);
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
        return { sinceLoad: 9000, requested: 0, full: false, frames: [{ key: 'it_a', loaded: false, inView: false }] };
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
    { step: 2, at: facts.probes.diagrams[0].at, sinceLoad: 9000, requested: 0, full: false, frames: [{ key: 'it_a', loaded: false, inView: false }] },
  ]);
});
