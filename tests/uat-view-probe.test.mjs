// #531’s view probe (tools/uat/view-probe.mjs): each step, before any screenshot scrolls the page, where each mounted
// transcript’s view is, read as app/js/view-state.mjs publishes it and measured on the page, twice a frame apart. Its
// page script runs here against a stand-in page.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { recordViews, sampleViews } from '../tools/uat/view-probe.mjs';

const ORIGIN = Date.UTC(2026, 10, 4, 9);

/**
 * A stand-in page: transcripts with items whose tops may change from one frame to the next (top(frame)), #main
 * scrolling the document and a panel scrolling its parent.
 */
function pageWith(transcripts, { frames = true } = {}) {
  let frame = 0;
  const item = (key, top) => ({ dataset: { key }, getBoundingClientRect: () => ({ top: typeof top === 'function' ? top(frame) : top }) });
  const els = transcripts.map((t) => ({
    id: t.where === 'main' ? 'main' : '',
    dataset: { thread: t.thread ?? 't_big', viewMode: t.mode, viewAnchor: t.anchor ?? '', viewOffset: t.offset ?? '' },
    children: Object.entries(t.items ?? {}).map(([key, top]) => item(key, top)),
    parentElement: { getBoundingClientRect: () => ({ top: 100 }), scrollHeight: 5000, scrollTop: 4000, clientHeight: 600 },
  }));
  return {
    performance: { timeOrigin: ORIGIN },
    document: {
      scrollingElement: { scrollHeight: 50_000, scrollTop: 10_000, clientHeight: 1000 },
      querySelectorAll: () => els,
    },
    requestAnimationFrame: (fn) => {
      if (frames) {
        frame++;
        fn();
      }
    },
    setTimeout: (fn) => fn(),
  };
}
// page.evaluate hands back a copy, as JSON, so the stand-in does too.
const evIn = (page) => async (expr) => JSON.parse(JSON.stringify(await runInNewContext(expr, page)));

test('the probe reads each transcript’s mode, anchor and offset, and measures the anchor from the view’s top', async () => {
  const page = pageWith([
    { where: 'main', mode: 'reading', anchor: 'it_b', offset: '220.4', items: { it_a: -300, it_b: 220.4 } },
    { where: 'panel', mode: 'reading', anchor: 'it_p', offset: '40', items: { it_p: 140 } },
  ]);
  assert.deepEqual(await sampleViews(evIn(page), {}), [
    {
      where: 'main',
      thread: 't_big',
      mode: 'reading',
      anchorId: 'it_b',
      expected: 220.4,
      actual: 220.4,
      gap: 39_000,
      origin: ORIGIN,
      prev: null,
      settled: true,
    },
    { where: 'panel', thread: 't_big', mode: 'reading', anchorId: 'it_p', expected: 40, actual: 40, gap: 400, origin: ORIGIN, prev: null, settled: true },
  ]);
});

test('the probe reads a following view with no anchor, and its gap from the end', async () => {
  const [s] = await sampleViews(evIn(pageWith([{ where: 'main', mode: 'following', items: { it_a: 10 } }])), {});
  assert.deepEqual(
    { mode: s.mode, anchorId: s.anchorId, expected: s.expected, actual: s.actual, gap: s.gap },
    { mode: 'following', anchorId: '', expected: null, actual: null, gap: 39_000 },
  );
});

test('the probe measures where the last sample’s anchor is now, by its key, from the same page load and thread', async () => {
  const page = () => pageWith([{ where: 'main', mode: 'reading', anchor: 'it_b', offset: '100', items: { it_a: 880, it_b: 100 } }]);
  const last = (o) => ({ main: { origin: ORIGIN, thread: 't_big', anchorId: 'it_a', ...o } });
  assert.deepEqual((await sampleViews(evIn(page()), last()))[0].prev, { anchorId: 'it_a', actual: 880 });
  assert.equal((await sampleViews(evIn(page()), last({ origin: ORIGIN - 5000 })))[0].prev, null, 'another page load');
  assert.equal((await sampleViews(evIn(page()), last({ thread: 't_other' })))[0].prev, null, 'another thread');
  assert.equal((await sampleViews(evIn(page()), last({ anchorId: 'it_gone' })))[0].prev, null, 'not mounted');
  assert.equal((await sampleViews(evIn(page()), { panel: last().main }))[0].prev, null, 'the panel’s, not main’s');
});

test('the probe marks a sample unsettled when two reads a frame apart differ by more than half a pixel', async () => {
  const at = (moves) => pageWith([{ where: 'main', mode: 'reading', anchor: 'it_b', offset: '100', items: { it_b: (frame) => 100 + frame * moves } }]);
  assert.equal((await sampleViews(evIn(at(0.4)), {}))[0].settled, true);
  assert.equal((await sampleViews(evIn(at(3)), {}))[0].settled, false);
});

test('the probe marks a sample unsettled when no frame came to read it again', async () => {
  const page = pageWith([{ where: 'main', mode: 'reading', anchor: 'it_b', offset: '100', items: { it_b: 100 } }], { frames: false });
  assert.equal((await sampleViews(evIn(page), {}))[0].settled, false);
});

test('recordViews keeps each sample with its step and time, and gives the next one the last anchor of its transcript', async () => {
  const facts = { probes: {} };
  const page = pageWith([{ where: 'main', mode: 'reading', anchor: 'it_b', offset: '100', items: { it_a: 500, it_b: 100 } }]);
  await recordViews(evIn(page), facts, 3);
  assert.equal(facts.probes.views.length, 1);
  assert.equal(facts.probes.views[0].step, 3);
  assert.equal(typeof facts.probes.views[0].at, 'number');
  const seen = [];
  const evSeen = async (expr) => {
    seen.push(expr);
    return [];
  };
  await recordViews(evSeen, facts, 4);
  assert.match(seen[0], /"main":\{"origin":\d+,"thread":"t_big","anchorId":"it_b"\}/);
});

test('recordViews records nothing when the page has no transcript, or the probe fails', async () => {
  const facts = { probes: {} };
  await recordViews(evIn(pageWith([])), facts, 1);
  await recordViews(async () => Promise.reject(new Error('gone')), facts, 2);
  assert.equal(facts.probes.views, undefined);
  assert.equal(facts.probes.viewMisses, 2, 'each miss is counted, so view-moved can say it saw nothing');
});

test('recordViews gives the probe the last settled sample’s anchor, not an unsettled one taken mid-scroll', async () => {
  const settled = { step: 1, at: 1, where: 'main', thread: 't_big', origin: ORIGIN, anchorId: 'it_a', settled: true };
  const midScroll = { ...settled, step: 2, anchorId: 'it_z', settled: false };
  const facts = { probes: { views: [settled, midScroll] } };
  const seen = [];
  await recordViews(
    async (expr) => {
      seen.push(expr);
      return [];
    },
    facts,
    3,
  );
  assert.match(seen[0], /"anchorId":"it_a"/);
  assert.doesNotMatch(seen[0], /it_z/);
});

test('observe records the view probe before any screenshot scrolls the page', async () => {
  const { observe } = await import('../tools/uat/observe.mjs');
  const calls = [];
  const item = { key: 'it_a', where: 'conversation', text: 'A block', block: 'choice', app: false, diagram: false, math: false, buttons: [], fields: [] };
  const d = {
    kit: {
      ev: async (expr) => {
        calls.push(/data-view-mode/.test(expr) ? 'views' : 'diagrams');
        return /data-view-mode/.test(expr)
          ? [{ where: 'main', thread: 't', mode: 'following', anchorId: '', expected: null, actual: null, gap: 0, origin: ORIGIN, prev: null, settled: true }]
          : { frames: [] };
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
  assert.deepEqual(calls, ['diagrams', 'views', 'shot']);
  assert.equal(facts.probes.views.length, 1);
});

test('#531: the last anchor goes into the page code escaped, so a key can’t close a script or break a line', async () => {
  let expr = '';
  await sampleViews(
    async (e) => {
      expr = e;
      return [];
    },
    [{ where: 'main', thread: 't', origin: 1, anchorId: 'it_</script>\u2028x', actual: 0 }],
  );
  assert.ok(!expr.includes('</script>'), 'no raw </script>');
  assert.ok(!expr.includes('\u2028'), 'no raw line separator');
  assert.ok(expr.includes('\\u003c/script\\u003e'), 'the key is escaped, not dropped');
});

test('#531: a reply growing below a reading anchor leaves the sample settled; while following, a changed gap doesn’t', async () => {
  const growing = (mode) => {
    const page = pageWith([{ where: 'main', mode, anchor: mode === 'reading' ? 'it_b' : '', offset: mode === 'reading' ? '100' : '', items: { it_b: 100 } }]);
    let reads = 0;
    Object.defineProperty(page.document.scrollingElement, 'scrollHeight', { get: () => 50_000 + 200 * reads++ });
    return page;
  };
  assert.equal((await sampleViews(evIn(growing('reading')), {}))[0].settled, true);
  assert.equal((await sampleViews(evIn(growing('following')), {}))[0].settled, false);
});
