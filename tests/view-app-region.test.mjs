// view_app with an optional review region (#856): validates the region before launching Chromium, passes it to
// capture, saves it under its own filename, and notes when the region was marked on an older version.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { keepAnswer } from '../server/view-app/consent.mjs';
import { ViewApp, viewApp } from '../server/view-app/view-app.mjs';
import { attachViewApp, viewOf } from '../server/view-app/view-of.mjs';
import * as arrange from './arrange.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pb-view-region-'));
  const store = new Store(null);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register({
      name: 'mock',
      async deliver(_s, _m, c) {
        await c.text('ok');
      },
    }),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: dir });
  const a = rt.createPersona({ handle: 'researcher' });
  const t = rt.createThread({ projectId: 'p1', title: 'Prices', personaIds: [a.id] });
  const se = arrange.sessionsIn(rt, t.id)[0];
  const shown = rt.toolsFor(se.id).show_app({ title: 'Price and orders', code: '<p>Orders fall as price rises.</p>' });
  const captures = [];
  const browser = {
    status: () => 'ready',
    installing: null,
    capture: async (at) => {
      captures.push(at);
      return PNG;
    },
    close: async () => {},
  };
  attachViewApp(rt, new ViewApp({ dataDir: dir, origin: () => 'http://127.0.0.1:1', browser: /** @type {any} */ (browser) }));
  keepAnswer(viewOf(rt).dir, 'allowed');
  return { dir, rt, t, se, appId: shown.appId, captures, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('#856 view_app validates an optional region, passes it to capture, and saves it beside the full capture', async () => {
  const s = setup();
  const ctx = { threadId: () => s.t.id, endSegment() {}, images: true };
  try {
    const bad = await viewApp(s.rt, s.se.id, { appId: s.appId, region: { x: 500, y: 0, w: 200, h: 40, width: 600, height: 400 } }, ctx);
    assert.equal(bad.ok, false);
    assert.match(bad.message, /x \+ w is at most width/);
    assert.equal(s.captures.length, 0, 'invalid region never starts a capture');

    const tooWide = await viewApp(s.rt, s.se.id, { appId: s.appId, region: { x: 0, y: 0, w: 100, h: 100, width: 20_000, height: 400 } }, ctx);
    assert.equal(tooWide.ok, false);
    assert.match(tooWide.message, /region\.width must be between 1 and 10000/);
    assert.equal(s.captures.length, 0, 'out-of-bounds region width refused before Chromium starts');

    const badShape = await viewApp(s.rt, s.se.id, { appId: s.appId, region: 'nope' }, ctx);
    assert.equal(badShape.ok, false);
    assert.match(badShape.message, /region must be/);

    const region = { x: 40, y: 120, w: 200, h: 80, width: 640, height: 960, version: 1 };
    const r = await viewApp(s.rt, s.se.id, { appId: s.appId, region }, ctx);
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /x 40, y 120, 200 × 80 px, on v1, in a 640 × 960 px frame/);
    assert.match(r.message, /at its 640 px review width/);
    assert.deepEqual(s.captures[0].region, region);
    const saved = join(s.dir, '.postbox', 'view', `${s.appId}-v1-region-40-120.png`);
    assert.equal(existsSync(saved), true, 'saved under its own filename');
    assert.deepEqual(readFileSync(saved), PNG);

    // A region marked on an earlier version still captures v2 and notes the version difference.
    s.rt.toolsFor(s.se.id).update_app({ id: s.appId, code: '<p>Updated.</p>', summary: 'v2' });
    const older = await viewApp(s.rt, s.se.id, { appId: s.appId, region }, ctx);
    assert.equal(older.ok, true, older.message);
    assert.match(older.message, /marked on v1; this capture shows v2/);
  } finally {
    s.done();
  }
});
