// Run clocks off, as every Postbox but a timed UAT trial’s runs (#1526): nothing of them is installed. The route
// answers 404, Delivery and the turn paths have no clock to ask, a turn’s message carries no line and records no clock
// event, and the state and its stream carry nothing for clocks. With POSTBOX_RUN_CLOCK=1 they are on.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { publicState } from '../server/public-state.mjs';
import { installRunClock, runClockOn } from '../server/run-clock-install.mjs';
import { fakeRequest, NAVIGATION } from './fake-http.mjs';
import { setup } from './stop-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
delete process.env.POSTBOX_RUN_CLOCK;
const { start } = await import('../server/index.mjs');

const PORT = 4441;
let app;
const call = (r) => fakeRequest(app.handle, { host: `127.0.0.1:${PORT}`, ...r });
before(async () => {
  const dir = tempDir('pb-clock-off-');
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: true, quiet: true, claudeHome: dir, listen: false });
});
after(async () => {
  await app.close();
});

/** Lets the scripted turns settle on the event loop’s turns. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

test('only POSTBOX_RUN_CLOCK=1 turns run clocks on', () => {
  assert.equal(runClockOn({}), false);
  assert.equal(runClockOn({ POSTBOX_RUN_CLOCK: '0' }), false);
  assert.equal(runClockOn({ POSTBOX_RUN_CLOCK: 'true' }), false);
  assert.equal(runClockOn({ POSTBOX_RUN_CLOCK: '1' }), true);
});

test('off, the clock’s route isn’t there: a write with the page’s token gets 404', async () => {
  const page = await call({ path: '/', headers: NAVIGATION });
  const cookie = page.headers['set-cookie'].split(';')[0];
  const se = Object.values(app.rt.s.sessions)[0];
  const r = await call({ method: 'POST', path: `/api/sessions/${se.id}/clock`, body: { action: 'start', budgetS: 60 }, cookie });
  assert.equal(r.status, 404, r.text);
  assert.match(r.json.error, /There’s nothing at/);
  assert.equal(app.rt.runClock, undefined, 'nothing installed');
  assert.equal(app.rt.delivery.clockHeld, null);
  assert.equal(Object.hasOwn(app.rt.s, 'clocks'), false, 'no clocks key in the state');
});

test('off, a turn’s message is as it was, and no clock event or key is written', async () => {
  const { rt, store, adapter, t } = setup();
  rt.sendMessage(t.id, { text: 'hello' });
  await settle();
  assert.equal(adapter.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(adapter.calls[0].message), /Run clock/);
  assert.deepEqual(
    store.since(0).filter((e) => e.type.startsWith('clock.')),
    [],
  );
  assert.equal(Object.hasOwn(publicState(store.state), 'clocks'), false);
  assert.equal(adapter.calls[0].ctx?.unkilled, undefined, 'the adapter isn’t handed the clock’s unkilled');
});

test('on, the same runtime holds a clock’s agent: installRunClock is what turns it on', () => {
  const { rt, se } = setup();
  installRunClock(rt);
  assert.equal(typeof rt.runClock.holds, 'function');
  assert.equal(rt.delivery.clockHeld(se.id), false, 'no clock yet, so nothing held');
});
