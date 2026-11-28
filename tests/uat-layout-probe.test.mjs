// The layout probe (#681, tools/uat/layout-probe.mjs): every whole-window screenshot the UAT runner takes
// (tools/uat/driver-shots.mjs, shotScreen) is followed by the layout check (tools/text-layout.mjs), and what it found is
// recorded at the step it’s in, with the person’s view put back after. Run against a page that answers each expression
// the way the real page would, and notes what reached it; tests/browser/text-layout.spec.mjs runs the check in Chromium.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { TEXT_LAYOUT } from '../tools/text-layout.mjs';
import { driver } from '../tools/uat/driver.mjs';
import { recordLayout, sampleLayout } from '../tools/uat/layout-probe.mjs';
import { tempDir } from './temp-dirs.mjs';

const FOUND = [{ code: 'mid-word-break', message: 'At 375 px, “Configuration” (section.mono) breaks mid-word, leaving “Con” on a line by itself.' }];
const FOLLOWING = { where: 'main', mode: 'following', anchor: '', offset: null, at: null, gap: 0 };

/** A page 375 px wide that notes, in order, what reaches it: the layout check, a screenshot, and the view’s reads. */
function scriptedPage({ check = async () => FOUND } = {}) {
  /** @type {string[]} */
  const calls = [];
  const page = {
    evaluate: async (/** @type {string} */ expr) => {
      if (expr === TEXT_LAYOUT) {
        calls.push('layout');
        return check();
      }
      if (expr === 'innerWidth') return 375;
      if (expr.includes('viewMode')) {
        calls.push('read');
        return [FOLLOWING];
      }
      if (expr.includes('const before =')) return calls.push('restore');
      return null;
    },
    send: async (/** @type {string} */ method) => {
      calls.push(method);
      return { data: '' };
    },
  };
  return { calls, page };
}

test('sampleLayout gives the window’s width and what the check found there', async () => {
  const { page } = scriptedPage();
  assert.deepEqual(await sampleLayout(page.evaluate), { width: 375, problems: FOUND });
});

test('sampleLayout gives the error of a check that couldn’t run, and doesn’t throw it', async () => {
  const { page } = scriptedPage({
    check: async () => {
      throw new Error('Execution context was destroyed');
    },
  });
  assert.deepEqual(await sampleLayout(page.evaluate), { error: 'Execution context was destroyed' });
});

test('a whole-window shot through the driver is followed by the layout check, recorded at its step, with the view kept', async () => {
  const probes = {};
  const { calls, page } = scriptedPage();
  const d = driver(page, { layout: recordLayout(probes, () => 6) });
  const file = join(tempDir('uat-layout-probe'), 'look-6.png');
  assert.equal(await d.shotScreen(file), file);
  assert.deepEqual(calls, ['Page.captureScreenshot', 'read', 'layout', 'restore', 'read']);
  assert.deepEqual(
    probes.layout.map(({ step, width, problems }) => ({ step, width, problems })),
    [{ step: 6, width: 375, problems: FOUND }],
  );
});

test('a driver with no layout hook takes the shot without running the check', async () => {
  const { calls, page } = scriptedPage();
  const d = driver(page);
  await d.shotScreen(join(tempDir('uat-layout-probe'), 'look-1.png'));
  assert.deepEqual(calls, ['Page.captureScreenshot']);
});
