// #701’s UAT trigger: the page deferred a diagram out of view, and loaded it once it neared the view
// (tools/uat/view-triggers.mjs). It reads the diagram probe tools/uat/observe.mjs records each step before any screenshot
// scrolls the page. The eager cases are what Chromium shows without #701: every frame’s page requested, and the frames out
// of view still not drawn.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { RESOURCE_BUFFER, recordDiagrams, sampleDiagrams } from '../tools/uat/diagram-probe.mjs';
import { VIEW_TRIGGERS } from '../tools/uat/view-triggers.mjs';

const T0 = Date.UTC(2026, 10, 3, 23);
const frame = (key, loaded, inView = false) => ({ key, loaded, inView });
const sample = (step, sinceLoad, requested, frames, full = false) => ({ step, at: T0 + step * 1000, origin: T0, sinceLoad, requested, full, frames });
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
  assert.deepEqual(run([lazyRoom[0], { ...lazyRoom[1], origin: T0 + 60000 }]), []);
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

test('observe records the diagram and document-query probes before any screenshot scrolls the page', async () => {
  const { observe } = await import('../tools/uat/observe.mjs');
  const calls = [];
  const item = { key: 'it_a', where: 'conversation', text: 'A diagram', block: null, app: false, diagram: true, math: false, buttons: [], fields: [] };
  const d = {
    kit: {
      // The view probe (#531) runs here too; this test follows the diagram and document-query probes only.
      ev: async (/** @type {string} */ expr) => {
        if (/data-view-mode/.test(expr)) return [];
        if (expr.includes('/app/js/client.mjs')) {
          calls.push('queries');
          return { origin: 1, sessionEvents: 0, scanCount: 0, scans: [], byId: 0, items: 1 };
        }
        // The skipped-items probe also runs (tests/uat-skip-probe.test.mjs); this stand-in shows it no conversation.
        if (!expr.includes('/sandbox/mermaid')) return null;
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
  assert.deepEqual(calls, ['probe', 'queries', 'shot']);
  assert.deepEqual(
    facts.probes.docQueries.map((x) => x.step),
    [2],
  );
  assert.deepEqual(facts.probes.diagrams, [
    { step: 2, at: facts.probes.diagrams[0].at, sinceLoad: 9000, requested: 0, full: false, frames: [{ key: 'it_a', loaded: false, inView: false }] },
  ]);
});

// The probe’s page script, run against a stand-in page: what it counts and what it calls drawn.
const pageWith = ({ resources, frames }) => ({
  performance: { timeOrigin: T0, now: () => 9000.4, getEntriesByType: () => resources.map((name) => ({ name })) },
  innerHeight: 800,
  URL,
  document: {
    querySelectorAll: () =>
      frames.map(({ key, sized, failed, top }) => ({
        dataset: { ...(sized ? { sized: '1' } : {}), ...(failed ? { failed: '1' } : {}) },
        getBoundingClientRect: () => ({ top, bottom: top + 300 }),
        closest: () => ({ dataset: { key } }),
      })),
  },
});
// page.evaluate hands back a copy, as JSON, so the stand-in does too.
const evIn = (page) => async (expr) => JSON.parse(JSON.stringify(runInNewContext(expr, page)));
const MERMAID_PAGE = 'http://127.0.0.1:4310/sandbox/mermaid?theme=dark';

test('the probe counts only /sandbox/mermaid pages, and calls a frame drawn once it’s sized or has failed', async () => {
  const page = pageWith({
    resources: [MERMAID_PAGE, 'http://127.0.0.1:4310/sandbox/mermaid-lib.js', 'http://127.0.0.1:4310/app/js/main.mjs'],
    frames: [
      { key: 'it_a', sized: true, top: 100 },
      { key: 'it_b', failed: true, top: -2000 },
      { key: 'it_c', top: 5000 },
    ],
  });
  assert.deepEqual(await sampleDiagrams(evIn(page)), {
    origin: T0,
    sinceLoad: 9000,
    requested: 1,
    full: false,
    frames: [
      { key: 'it_a', loaded: true, inView: true },
      { key: 'it_b', loaded: true, inView: false },
      { key: 'it_c', loaded: false, inView: false },
    ],
  });
});

test('the probe marks a sample whose timing buffer is full, and records nothing for a conversation with no diagram', async () => {
  const at = (n) => pageWith({ resources: Array.from({ length: n }, () => MERMAID_PAGE), frames: [{ key: 'it_a', top: 100 }] });
  assert.equal((await sampleDiagrams(evIn(at(RESOURCE_BUFFER - 1)))).full, false);
  assert.equal((await sampleDiagrams(evIn(at(RESOURCE_BUFFER)))).full, true);
  const facts = { probes: {} };
  await recordDiagrams(evIn(pageWith({ resources: [], frames: [] })), facts, 1);
  assert.equal(facts.probes.diagrams, undefined, 'no probe, so the trigger can’t tell');
});

test('on samples recorded in Chromium, diagram-deferred fires on #701’s lazy frames and stays silent on eager ones', () => {
  const recorded = JSON.parse(readFileSync(new URL('fixtures/uat/diagram-probe-samples.json', import.meta.url), 'utf8'));
  assert.equal(run(recorded.lazy).length, 1);
  assert.deepEqual(run(recorded.eager), []);
});

// items-skipped (#712a): the run read a long room with most of its items skipped, on Chromium samples.
const skipSamples = JSON.parse(readFileSync(new URL('./fixtures/uat/skip-probe-samples.json', import.meta.url), 'utf8'));
const skippedRun = (skipped) => VIEW_TRIGGERS['items-skipped'].run({ probes: { skipped } });

test('items-skipped fires on a long room with most of its items skipped, and says how many', () => {
  const [hit] = skippedRun(skipSamples.on);
  assert.match(hit.evidence, /1176 of the conversation’s 1200 items/);
});

test('items-skipped stays silent with the rule off, on a room of 1,000 or fewer, unsettled, or unsupported', () => {
  assert.deepEqual(skippedRun(skipSamples.off), []);
  const on = skipSamples.on[0];
  assert.deepEqual(skippedRun([{ ...on, items: 1000, skipped: 990 }]), [], 'a room of 1,000 is not long');
  assert.deepEqual(skippedRun([{ ...on, items: 1001, skipped: 500 }]), [], 'half or fewer is not most');
  assert.deepEqual(skippedRun([{ ...on, settled: false }]), [], 'unsettled');
  assert.deepEqual(skippedRun([{ ...on, supported: false, skipped: null }]), [], 'the browser can’t say');
  assert.deepEqual(skippedRun([]), []);
});

test('items-skipped can tell only from a run that recorded the probe', () => {
  assert.equal(VIEW_TRIGGERS['items-skipped'].recorded({ probes: {} }), false);
  assert.equal(VIEW_TRIGGERS['items-skipped'].recorded({ probes: { skipped: [] } }), true);
});
