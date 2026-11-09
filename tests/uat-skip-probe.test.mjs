// The skipped-items probe (#712a, tools/uat/skip-probe.mjs): its page script run against a stand-in page, and observe
// recording it before any screenshot draws an item (tools/uat/observe.mjs). tests/browser/skip-probe.spec.mjs runs it
// in Chromium.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { recordSkipped, sampleSkipped } from '../tools/uat/skip-probe.mjs';

const T0 = Date.UTC(2026, 10, 4, 9);

/**
 * A stand-in page whose #main transcript holds items, each skipped or drawn, as Chromium’s checkVisibility reports
 * them: an item’s own box is never hidden by its content-visibility, only what’s in it. option: whether the browser
 * reads the contentVisibilityAuto option; one that doesn’t calls everything visible. frames: whether it draws frames.
 */
function pageWith({ items = [], cls = ['transcript', 'cv-skip'], option = true, frames = true, transcript = true } = {}) {
  const visible = (skipped) => (opts) => {
    const auto = option ? opts?.contentVisibilityAuto : undefined;
    return !(auto && skipped);
  };
  const children = items.map((skipped) => ({
    classList: { contains: (c) => c === 'item' },
    checkVisibility: visible(false),
    firstElementChild: { checkVisibility: visible(skipped) },
  }));
  children.push({ classList: { contains: () => false }, firstElementChild: null });
  const el = { children, dataset: { thread: 'th_a' }, classList: { contains: (c) => cls.includes(c) }, checkVisibility: visible(false) };
  return {
    performance: { timeOrigin: T0 + 0.4 },
    requestAnimationFrame: (f) => (frames ? setImmediate(() => f(0)) : 0),
    // The probe’s one-second fallback, at once when no frame will come, and never when one does.
    setTimeout: (f) => (frames ? 0 : setImmediate(f)),
    Promise,
    document: { querySelector: (s) => (s === '#main.transcript' && transcript ? el : null) },
  };
}
// page.evaluate hands back a copy, as JSON, so the stand-in does too.
const evIn = (page) => async (expr) => JSON.parse(JSON.stringify(await runInNewContext(expr, page)));

test('the probe counts the items whose content is skipped, not their own boxes, and only .item children', async () => {
  assert.deepEqual(await sampleSkipped(evIn(pageWith({ items: [true, true, false] }))), {
    origin: T0,
    thread: 'th_a',
    items: 3,
    skipped: 2,
    supported: true,
    gated: true,
    settled: true,
  });
});

test('the probe says whether the transcript has the cv-skip class', async () => {
  const s = await sampleSkipped(evIn(pageWith({ items: [false], cls: ['transcript'] })));
  assert.equal(s.gated, false);
});

test('the probe marks a browser that ignores contentVisibilityAuto as unsupported, with no count', async () => {
  const s = await sampleSkipped(evIn(pageWith({ items: [true, true], option: false })));
  assert.deepEqual([s.supported, s.skipped, s.items], [false, null, 2]);
});

test('the probe marks a sample unsettled when the page draws no frames', async () => {
  const s = await sampleSkipped(evIn(pageWith({ items: [true], frames: false })));
  assert.equal(s.settled, false);
});

test('the probe records nothing when the page shows no conversation', async () => {
  const facts = { probes: {} };
  await recordSkipped(evIn(pageWith({ transcript: false })), facts, 1);
  assert.equal(facts.probes.skipped, undefined, 'no probe, so rows-skipped stays silent');
  await recordSkipped(evIn(pageWith({ items: [true] })), facts, 2);
  assert.deepEqual(
    facts.probes.skipped.map(({ step, items, skipped }) => ({ step, items, skipped })),
    [{ step: 2, items: 1, skipped: 1 }],
  );
});

test('observe records the skipped-items probe before any screenshot draws an item', async () => {
  const { observe } = await import('../tools/uat/observe.mjs');
  const calls = [];
  const item = { key: 'it_a', where: 'conversation', text: 'A block', block: 'choice', app: false, diagram: false, math: false, buttons: [], fields: [] };
  const sample = { origin: T0, thread: 'th_a', items: 1200, skipped: 1176, supported: true, gated: true, settled: true };
  const d = {
    kit: {
      ev: async (expr) => {
        if (!expr.includes('contentVisibilityAuto')) return null;
        calls.push('probe');
        return sample;
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
  assert.deepEqual(facts.probes.skipped, [{ step: 2, at: facts.probes.skipped[0].at, ...sample }]);
});
