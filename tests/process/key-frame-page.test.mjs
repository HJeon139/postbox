// The key-to-frame tool against a real page in Chromium (#508, #777’s review): each run of a size opens the room in a
// document of its own, so no run carries an earlier one’s listener and observer, and a key the page stops from typing
// is refused rather than read as a fast one. The page is a bare composer on a local server, not Postbox.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { openFresh } from '../../tools/bench-key-frame.mjs';
import { launch } from '../../tools/browser.mjs';
import { measureKeys } from '../../tools/key-frame-measure.mjs';
import { chromiumMissing } from './chrome.mjs';

const skip = await chromiumMissing();
const KEYS = { keys: 5, warmup: 1, intervalMs: 20 };

/** Cancels every key, so nothing is typed. */
const DROP = "document.getElementById('composer-input').addEventListener('keydown', (e) => e.preventDefault());";
/**
 * Re-renders the composer after each input: a new textarea with the same id, value and focus takes its place, so the
 * entries Event Timing reports are for an element that is no longer the composer.
 */
const SWAP = `document.addEventListener('input', (e) => {
  const old = e.target, next = old.cloneNode();
  next.value = old.value;
  old.replaceWith(next);
  next.focus();
  next.setSelectionRange(next.value.length, next.value.length);
});`;
/** The page’s own script for each path: /drop cancels keys, /swap re-renders the composer after each input. */
const SCRIPTS = { '/drop': DROP, '/swap': SWAP };
/** A composer, with the script its path asks for. @param {string} url */
const html = (url) => `<!doctype html><textarea id="composer-input" style="width:400px;height:60px"></textarea>
<script>${SCRIPTS[/** @type {keyof SCRIPTS} */ (url)] ?? ''}</script>`;

/** @type {import('node:http').Server} */
let server;
let origin = '';
before(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html(req.url ?? '/'));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(undefined)));
  origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
});
after(() => server?.close());

test('each run opens the room in a new document, so a second run measures with one set of instruments', { skip, timeout: 90_000 }, async () => {
  const page = await launch();
  try {
    await page.size(1280, 900);
    const origins = [];
    for (let run = 0; run < 2; run++) {
      await openFresh(page, `${origin}/#/t/th_keyframe`);
      origins.push(await page.evaluate('performance.timeOrigin'));
      const r = await measureKeys(page, KEYS);
      assert.equal(r.eventTiming.length, KEYS.keys, `run ${run + 1} measured each key once`);
      assert.equal(r.nextFrame.length, KEYS.keys, `run ${run + 1} timed each measured key’s next frame, and no warm-up key`);
    }
    assert.notEqual(origins[1], origins[0], 'the second run’s document is a new one');
  } finally {
    await page.close();
  }
});

test('measuring again in the same document is refused, not counted twice', { skip, timeout: 90_000 }, async () => {
  const page = await launch();
  try {
    await page.size(1280, 900);
    await page.goto(`${origin}/#/t/th_keyframe`);
    await measureKeys(page, KEYS);
    await page.goto(`${origin}/#/t/th_keyframe`);
    await assert.rejects(measureKeys(page, KEYS), /already recording/);
  } finally {
    await page.close();
  }
});

test('a key the page stops from typing is refused, not read as a key under one frame', { skip, timeout: 90_000 }, async () => {
  const page = await launch();
  try {
    await page.size(1280, 900);
    await openFresh(page, `${origin}/drop#/t/th_keyframe`);
    await assert.rejects(measureKeys(page, KEYS), /The composer holds 0 of the 6 characters typed/);
  } finally {
    await page.close();
  }
});

test('a run whose observer sees no entry for this composer is refused, not read as keys under one frame', { skip, timeout: 90_000 }, async () => {
  const page = await launch();
  try {
    await page.size(1280, 900);
    await openFresh(page, `${origin}/swap#/t/th_keyframe`);
    await assert.rejects(measureKeys(page, KEYS), /no entry for the calibration key; the observer isn’t measuring this composer/);
  } finally {
    await page.close();
  }
});
