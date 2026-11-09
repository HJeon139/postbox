// A press on the Work pane or the Threads page isn’t lost to a refill (#1010), as in an agent’s quick panel (#898).
// Each of the three views rebuilds every button in it when it repaints: the Work pane’s list and a turn’s view on each
// work.add or work.patch of their conversation, the Threads page on each thread, session or item.patch event. A refill
// between mousedown and mouseup put a new button under the mouseup, so the browser fired no click. Here the refill
// comes while the press is held: the test holds the mouse down on the control, changes what the view shows on the
// server, waits until the page has heard it and drawn, then lets go.

import { expect, test } from '@playwright/test';
import { turnLine } from '../../shared/work.mjs';
import { failOnPageErrors, frames, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {any} */
let conv;
/** @type {any} */
let se;
/** @type {string} */
let topic;
const TURN = 'wt_press';
const COMMAND = 'wc_press';

test.beforeAll(async () => {
  app = await startPostbox('work-threads-press');
  const { rt, store } = app;
  conv = Object.values(store.state.threads).find((t) => t.title === 'Citation fixes');
  se = rt.sessionsIn(conv.id)[0];
  // A turn of work with one command, as the ledger records it (server/ledger.mjs).
  const at = Date.now() - 60_000;
  const base = { turnId: TURN, threadId: conv.id, sessionId: se.id, handle: se.handle, at };
  rt.ledger.add(conv.id, { ...base, kind: 'turn', id: TURN, startedAt: at, status: 'done', toolCalls: 1, ms: 4000 });
  rt.ledger.add(conv.id, {
    ...base,
    kind: 'command',
    id: COMMAND,
    command: 'npm test',
    description: 'Ran the tests',
    startedAt: at,
    state: 'done',
    exit: 0,
    ms: 900,
  });
  const root = store.items(conv.id).find((i) => i.kind === 'agent') ?? rt.addItem(conv.id, { kind: 'agent', handle: se.handle, text: 'Done.' });
  topic = rt.startTopic(conv.id, root.id).threadId;
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

let n = 0;
/** Refills the Work pane: a patch to the turn’s work, heard by the page and drawn. Returns its new line. */
async function refillWork(page) {
  app.rt.ledger.patch(conv.id, TURN, { ms: 4000 + ++n * 1000 });
  await synced(page, app);
  await frames(page);
  return turnLine(app.store.state.work[conv.id], TURN);
}
/** Refills the Threads page: a change to a session of the conversation, heard by the page. */
async function refillThreads(page) {
  app.rt.updateSession(se.id, { ctx: ++n });
  await synced(page, app);
  await frames(page);
}

/** The pane’s list, open at the turn. */
async function paneAtTurn(page) {
  await page.goto(`${app.origin}/#/t/${conv.id}?work&turn=${TURN}`);
  await synced(page, app);
  await expect(page.locator(`#wturn-${TURN}[open]`), 'the turn, opened in the list').toBeVisible();
}

for (const width of [375, 1280]) {
  test.describe(`at ${width} px`, () => {
    test.use(width === 375 ? { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {});

    test(`a press held on Open this turn while the Work list refills opens the turn, at ${width} px`, async ({ page }) => {
      await paneAtTurn(page);
      await page.locator(`#wc-open-${TURN}`).hover();
      await page.mouse.down();
      const line = await refillWork(page);
      await page.mouse.up();
      await expect.soft(page.locator('.pane-full .work-turn'), 'one turn, full screen').toBeVisible();
      // The refill it held landed: back in the list, the turn’s line is the new one.
      await page.keyboard.press('Escape');
      await expect.soft(page.locator(`#wturn-s-${TURN} .wc-turn-line`), 'the refill it held landed').toHaveText(line);
    });

    test(`a press held on a command in a turn’s view while it refills opens the command, at ${width} px`, async ({ page }) => {
      await paneAtTurn(page);
      await page.locator(`#wc-open-${TURN}`).click();
      const summary = page.locator(`.pane-full #wsum-${COMMAND}`);
      await expect(summary).toBeVisible();
      await summary.hover();
      await page.mouse.down();
      await refillWork(page);
      await page.mouse.up();
      await expect.soft(page.locator(`.pane-full details.work-item:has(#wsum-${COMMAND})`), 'the command, opened').toHaveAttribute('open', '');
      await expect.soft(page.locator('.pane-full .work-cmd-full'), 'its command line').toHaveText('npm test');
    });

    test(`a press held on a thread’s card while the Threads page refills opens the thread, at ${width} px`, async ({ page }) => {
      await page.goto(`${app.origin}/#/p/${conv.projectId}/threads`);
      await synced(page, app);
      const title = app.store.state.threads[topic].title;
      const card = page.locator('a.thread-card', { hasText: title });
      await expect(card).toBeVisible();
      await card.hover();
      await page.mouse.down();
      await refillThreads(page);
      await page.mouse.up();
      await expect(page, 'the topic thread, opened').toHaveURL(new RegExp(`#/t/${conv.id}/side/${topic}$`));
    });
  });
}

// #1101: closing is the other direction of the same press. The held refill rebuilt an open item open before its old
// toggle ran, so the press left it open.
for (const width of [375, 1280]) {
  test.describe(`closing, at ${width} px`, () => {
    test.use(width === 375 ? { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {});

    test(`a press held on an open turn’s row while the Work list refills closes the turn, at ${width} px`, async ({ page }) => {
      await paneAtTurn(page);
      await page.locator(`#wturn-s-${TURN}`).hover();
      await page.mouse.down();
      await refillWork(page);
      await page.mouse.up();
      await expect(page.locator(`#wturn-${TURN}`), 'the turn, closed').not.toHaveAttribute('open', '');
      await refillWork(page);
      await expect(page.locator(`#wturn-${TURN}`), 'and it stays closed through the next refill').not.toHaveAttribute('open', '');
    });

    test(`a press held on an open command in a turn’s view while it refills closes the command, at ${width} px`, async ({ page }) => {
      await paneAtTurn(page);
      await page.locator(`#wc-open-${TURN}`).click();
      const summary = page.locator(`.pane-full #wsum-${COMMAND}`);
      const item = page.locator(`.pane-full details.work-item:has(#wsum-${COMMAND})`);
      await summary.click();
      await expect(item, 'the command, opened first').toHaveAttribute('open', '');
      await summary.hover();
      await page.mouse.down();
      await refillWork(page);
      await page.mouse.up();
      await expect(item, 'the command, closed').not.toHaveAttribute('open', '');
      await refillWork(page);
      await expect(item, 'and it stays closed through the next refill').not.toHaveAttribute('open', '');
    });
  });
}
