// The run’s own key-to-frame measurement (#508, tools/uat/key-frame-run.mjs): it measures the seeded room on the
// run’s page and leaves the tester an empty composer, whether or not the measurement finished.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { keyFrameOut, measuredProbe, measureRunRoom, seededNote } from '../tools/uat/key-frame-run.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';

const scenario = (name) => parseScenario(readFileSync(new URL(`uat/e2e/scenarios/${name}.md`, import.meta.url), 'utf8'));

/**
 * A page whose composer is on screen and that fails on its third key, as one does when the browser goes away
 * mid-measurement. It records what it was asked to run.
 */
function failingPage() {
  const ran = [];
  let keys = 0;
  const page = {
    ran,
    waitFor: async () => true,
    evaluate: async (expr) => {
      ran.push(expr);
      if (expr.includes('rect:')) return { rect: { top: 500, bottom: 560, left: 0, right: 800 }, window: { width: 1280, height: 800 } };
      if (expr.includes('getBoundingClientRect')) return { x: 400, y: 530 };
      return undefined;
    },
    send: async (method) => {
      if (method === 'Browser.getWindowForTarget') return { windowId: 1 };
      if (method === 'Browser.getWindowBounds') return { bounds: { left: 0, top: 0, width: 1280, height: 800 } };
      if (method === 'Input.dispatchKeyEvent' && ++keys > 4) throw new Error('Target closed.');
      return {};
    },
  };
  return page;
}

test('a measurement that fails partway still empties the composer of the keys it typed', async () => {
  const page = failingPage();
  const probes = { keyFrame: [] };
  const lines = [];
  await measureRunRoom({ page, root: '/repo', threadId: 'th_big', items: 1000, out: '/tmp/kf.md', probes, log: (l) => lines.push(l) });
  assert.equal(probes.keyFrame.length, 1);
  assert.equal(probes.keyFrame[0].report, null);
  assert.match(probes.keyFrame[0].error, /Target closed/);
  const typedAt = page.ran.findIndex((e) => e.includes('__keyFrame ='));
  assert.ok(typedAt >= 0, 'the measurement started recording');
  const clearedAfter = page.ran.slice(typedAt + 1).some((e) => e.includes("ta.value = ''"));
  assert.ok(clearedAfter, 'the draft was emptied after the keys were typed');
});

test('the big-room scenario turns the measurement on, and its first phase waits for it', () => {
  const bigroom = scenario('bigroom');
  assert.equal(bigroom.measureKeyFrame, true);
  assert.ok(bigroom.phases[0].triggers.includes('key-frame-measured'), bigroom.phases[0].triggers.join(', '));
  assert.equal(scenario('delivery').measureKeyFrame, false, 'another scenario in the seeded room doesn’t measure');
});

test('the report goes where --measure-key-frame says, else to the run’s folder when the scenario asks, else nowhere', () => {
  const dir = join('/runs', '2026-11-04-bigroom');
  assert.equal(keyFrameOut({ 'measure-key-frame': 'kf.md' }, { measureKeyFrame: true }, dir), 'kf.md');
  assert.equal(keyFrameOut({}, { measureKeyFrame: true }, dir), join(dir, 'key-frame-report.md'));
  assert.equal(keyFrameOut({}, { measureKeyFrame: false }, dir), null);
});

test('a finished measurement records how many of its keys had no Event Timing entry, for the trigger to judge', () => {
  const r = { eventTiming: [16, 16, 24], nextFrame: [10, 11, 12], below: 2 };
  const probe = measuredProbe({ threadId: 'th_big', items: 1000, report: 'kf.md', at: 5 }, r);
  assert.deepEqual(probe, { threadId: 'th_big', items: 1000, keys: 3, below: 2, report: 'kf.md', at: 5 });
});

test('a scenario with no big-room seed adds nothing to its summary, and seeds and measures nothing', async () => {
  assert.equal(await seededNote({}, { opt: { 'measure-key-frame': 'out.md' }, dir: '.' }), '');
  assert.equal(await seededNote({ seed: 'other' }, { opt: {}, dir: '.' }), '');
});
