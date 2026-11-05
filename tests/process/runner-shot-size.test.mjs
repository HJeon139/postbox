// The UAT runner’s shots leave its window the size it set (#531, B1b-b): tools/uat/driver-shots.mjs shoots with raw
// Page.captureScreenshot on tools/browser.mjs’s page, whose size() sets the window on the same session. A shot that
// shrank the window would move the middle of the view, and so the anchor the page publishes, on every item or app
// shot, and B1b-c’s view-moved would hear each one as the runner’s. A stand-in that shot on a second session did
// shrink on macOS (tests/browser/uat-view.spec.mjs, runnerPage).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { launch } from '../../tools/browser.mjs';
import { shots } from '../../tools/uat/driver-shots.mjs';
import { chromiumMissing } from './chrome.mjs';

const skip = await chromiumMissing();
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
// A tall page with an item far below the top, as a long room’s first items are far above its end, sized to the
// device as Postbox’s page is.
const PAGE = `data:text/html,${encodeURIComponent(
  '<meta name="viewport" content="width=device-width"><body style="margin:0"><div style="height:3000px"></div><div data-key="far" style="height:200px">Far</div><div style="height:3000px"></div></body>',
)}`;

test('an item shot and a window shot leave the runner’s window the size it set, at 1280 and 375 wide', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-shot-'));
  const page = await launch();
  try {
    for (const [width, height] of [
      [1280, 800],
      [375, 812],
    ]) {
      await page.size(width, height);
      await page.goto(PAGE);
      await page.evaluate('scrollTo(0, document.scrollingElement.scrollHeight)');
      const size = () => page.evaluate('[innerWidth, innerHeight]');
      assert.deepEqual(await size(), [width, height], 'size() set the window');
      const { shotItem, shotScreen } = shots({ ev: page.evaluate, page, sleep });
      assert.equal(await shotItem('far', join(dir, `far-${width}.png`)), join(dir, `far-${width}.png`), 'the item was shot');
      assert.deepEqual(await size(), [width, height], 'after the item shot');
      await shotScreen(join(dir, `screen-${width}.png`));
      assert.deepEqual(await size(), [width, height], 'after the window shot');
    }
  } finally {
    await page.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
