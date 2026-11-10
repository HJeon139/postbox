// The UAT runner’s shots leave its window the size it set (#531, B1b-b): tools/uat/driver-shots.mjs shoots with raw
// Page.captureScreenshot on tools/browser.mjs’s page, whose size() sets the window on the same session. A shot that
// shrank the window would move the middle of the view, and so the anchor the page publishes, on every item or app
// shot, and B1b-c’s view-moved would hear each one as the runner’s. A stand-in that shot on a second session did
// shrink on macOS (tests/browser/uat-view.spec.mjs, runnerPage).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { launch } from '../../tools/browser.mjs';
import { shots } from '../../tools/uat/driver-shots.mjs';
import { tempDir } from '../temp-dirs.mjs';
import { chromiumMissing } from './chrome.mjs';

const skip = await chromiumMissing();
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
// A tall page with an item far below the top, as a long room’s first items are far above its end, sized to the
// device as Postbox’s page is.
const PAGE =
  '<meta name="viewport" content="width=device-width"><body style="margin:0"><div style="height:3000px"></div><div data-key="far" style="height:200px">Far</div><div style="height:3000px"></div></body>';
// A shot scrolls through the page’s own jumpTo (#712a), so the page is served beside the real modules it imports.
const MODULES = Object.fromEntries(
  ['view-jump.mjs', 'view-skip.mjs'].map((name) => [`/app/js/${name}`, readFileSync(new URL(`../../app/js/${name}`, import.meta.url))]),
);

/** Serves PAGE at / and the modules at their paths on a free port; resolves to its origin and a close(). */
function servePage() {
  const server = createServer((req, res) => {
    const module = MODULES[req.url ?? ''];
    if (module) return res.writeHead(200, { 'content-type': 'text/javascript' }).end(module);
    res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
  });
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      ok({ origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    }),
  );
}

test('an item shot and a window shot leave the runner’s window the size it set, at 1280 and 375 wide', { skip }, async () => {
  const dir = tempDir('runner-shot-');
  const site = await servePage();
  const page = await launch();
  try {
    for (const [width, height] of [
      [1280, 800],
      [375, 812],
    ]) {
      await page.size(width, height);
      await page.goto(`${site.origin}/`);
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
    await site.close();
  }
});
