// The UAT runner’s scroll while an agent works (tools/uat/scroll-mid-turn.mjs, #805): an interrupt {do: scroll} pages
// a long room back and forth while a reply streams into it, and the view probe samples the view after each move,
// all before the turn ends. The runner’s own code, its driver and its interrupt, through a stand-in for its page.
// The turn here ends only once the interrupt has returned, so a scroll that waited for the turn to end never returns.

import { expect, test } from '@playwright/test';
import { driver } from '../../tools/uat/driver.mjs';
import { newProbes } from '../../tools/uat/probes.mjs';
import { VIEW_CHECKS } from '../../tools/uat/room-checks-view.mjs';
import { interruptAct } from '../../tools/uat/steps.mjs';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, frames, startPostbox } from './postbox.mjs';
import { runnerPage } from './runner-page.mjs';
import { LONG, open as openIn, room as roomIn } from './view-read-fixture.mjs';

test.use({ colorScheme: 'light' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('uat-scroll-mid-turn');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const viewMoved = /** @type {any} */ (VIEW_CHECKS.find((c) => c.id === 'view-moved'));

/** A turn of @researcher’s that streams a word a frame into a new reply until it’s ended. @param {any} page @param {any} t */
function streamingTurn(page, t) {
  const { rt, store } = app;
  const se = arrange.agentIn(rt, t.id);
  const it = arrange.post(rt, t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: '', status: 'streaming' });
  arrange.setSession(rt, se.id, { state: 'gen' });
  const words =
    Array.from({ length: 400 }, (_, i) => LONG(100 + i))
      .join(' ')
      .match(/\S+\s*/g) ?? [];
  let ended = false;
  const streamed = (async () => {
    for (let w = 0; !ended; w = (w + 1) % words.length) {
      store.emit('item.text', { threadId: t.id, id: it.id, text: words[w] });
      await frames(page);
    }
  })();
  return {
    item: it,
    async end() {
      ended = true;
      await streamed;
      arrange.setItem(rt, t.id, it.id, { status: 'done' });
      arrange.setSession(rt, se.id, { state: 'idle' });
    },
  };
}

test('a scroll interrupt pages back and forth while a reply streams, and view-moved compares two samples a move before the turn ends', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'the UAT driver works the page through Chromium’s DevTools protocol');
  test.setTimeout(60_000);
  const { t } = roomIn(app, 'Runner scroll mid-turn');
  await openIn(app, page, t);
  const turn = streamingTurn(page, t);
  try {
    await expect(page.getByRole('button', { name: 'Stop researcher’s reply' }), 'the turn is running').toBeVisible();
    const facts = { probes: newProbes() };
    const d = driver(await runnerPage(page));
    const interrupt = { after: 1, do: 'scroll', moves: ['up', 'up', 'down', 'end'] };
    const mid = interruptAct(interrupt, { fault: async () => '', answer: async () => '', ctx: { d, facts, step: 3 } });
    /** @type {string | null} */
    let said = null;
    d.interrupt({ ...interrupt, do: mid.do }, { answer: mid.answer }).then(
      (s) => {
        said = s;
      },
      (e) => {
        said = `The interrupt failed: ${e.message}`;
      },
    );
    // With the turn still running: a scroll that waited for its end would never get here.
    await expect.poll(() => said, { message: 'the scroll returned while the reply streamed', timeout: 30_000 }).not.toBeNull();
    expect(app.store.state.items[t.id].find((x) => x.id === turn.item.id)?.status, 'the reply is still streaming').toBe('streaming');
    await expect(page.getByRole('button', { name: 'Stop researcher’s reply' }), 'the turn is still running').toBeVisible();
    expect(said).toMatch(
      /^Scrolled: PageUp \(reading, at it_\w+, while the agent worked\); PageUp \(reading, at it_\w+, while the agent worked\); PageDown \(reading, at it_\w+, while the agent worked\); End \(following, while the agent worked\)\./,
    );
    const views = /** @type {any[]} */ (facts.probes.views ?? []).filter((v) => v.where === 'main');
    const reading = views.filter((v) => v.mode === 'reading');
    expect(views.length, 'two samples a move, mid-turn').toBe(8);
    expect(
      reading.map((v) => v.settled),
      'each reading sample settled, so view-moved reads it',
    ).toEqual([true, true, true, true, true, true]);
    expect(reading[2].anchorId, 'the second page up went further back').not.toBe(reading[0].anchorId);
    expect(facts.probes.inputs.filter((x) => x.kind === 'scroll').length, 'each move recorded as an input').toBe(4);
    // While the reply still streams: view-moved compared the pairs with no input between, each move’s two samples, and
    // found the view held. With nothing compared it would say so, and not be silent.
    expect(viewMoved.run(facts), 'view-moved compared mid-stream pairs and stayed silent').toEqual([]);
    await turn.end();
  } finally {
    await turn.end();
  }
});
