// view-moved while a reply streams (#531, B1b-c): the UAT’s view probe (tools/uat/view-probe.mjs) samples a real page
// each step, and view-moved (tools/uat/room-checks-view.mjs) must stay silent while a reply streams into a view that is
// following the end, or below a view that is reading. A steady stream could hold the gap above 2 px across the probe’s
// two reads, so the sample would count as settled and drift would fire: this spec is the guard against that.

import { expect, test } from '@playwright/test';
import { VIEW_CHECKS } from '../../tools/uat/room-checks-view.mjs';
import { recordViews } from '../../tools/uat/view-probe.mjs';
import { failOnPageErrors, settled, startPostbox } from './postbox.mjs';
import { holds, open as openIn, room as roomIn } from './view-read-fixture.mjs';

test.use({ colorScheme: 'light' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('view-moved-stream');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const viewMoved = VIEW_CHECKS.find((c) => c.id === 'view-moved');
const WORDS = 'The plan stays grounded while the agent reads each result in turn and says what it changed. '.repeat(6).split(' ');

/**
 * Streams a reply into the conversation, a few words between each of eight probe samples, as a UAT run’s steps would.
 * @param {any} page @param {any} t @param {any} se
 */
async function streamWhileSampling(page, t, se) {
  const { rt, store } = app;
  const it = rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: '', status: 'streaming' });
  const facts = { probes: { inputs: [] } };
  const ev = (/** @type {string} */ expr) => page.evaluate(expr);
  let w = 0;
  for (let step = 0; step < 8; step++) {
    for (let k = 0; k < 8 && w < WORDS.length; k++, w++) {
      store.emit('item.text', { threadId: t.id, id: it.id, text: `${WORDS[w]} ` });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
    }
    await recordViews(ev, facts, step);
  }
  return facts;
}

for (const width of [1280, 375]) {
  test(`#531: view-moved stays silent while a reply streams into a following view, at ${width} px`, async ({ page }) => {
    const { t } = roomIn(app, `Stream following ${width}`);
    await openIn(app, page, t, width);
    expect((await holds(page, t, 'mounted')).mode).toBe('following');
    const facts = await streamWhileSampling(page, t, app.rt.sessionsIn(t.id)[0]);
    const views = /** @type {any[]} */ (facts.probes.views ?? []);
    expect(views.length, 'the probe read the page each step').toBeGreaterThanOrEqual(8);
    expect(views.filter((s) => s.settled).length, 'some samples settled, so the check compared them').toBeGreaterThan(1);
    expect(viewMoved.run(facts)).toEqual([]);
  });

  test(`#531: view-moved stays silent while a reply streams below a reading view, at ${width} px`, async ({ page }) => {
    const { t } = roomIn(app, `Stream reading ${width}`);
    await openIn(app, page, t, width);
    await page.mouse.move(width / 2, 400);
    await page.mouse.wheel(0, -1200);
    await settled(page);
    expect((await holds(page, t, 'after a wheel up')).mode).toBe('reading');
    const facts = await streamWhileSampling(page, t, app.rt.sessionsIn(t.id)[0]);
    const views = /** @type {any[]} */ (facts.probes.views ?? []);
    expect(views.filter((s) => s.settled).length, 'some samples settled, so the check compared them').toBeGreaterThan(1);
    expect(viewMoved.run(facts)).toEqual([]);
  });
}
