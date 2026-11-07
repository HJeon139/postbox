// Reply in thread on a message with no thread yet (#887): the button starts the topic thread and goes to its address,
// and the panel opens there, with focus in its composer, whether the thread’s event reaches the page before the
// address changes or after. When it arrives late, the panel opens as it lands: unless the person has gone to another
// conversation or closed the address, and focus moves to the composer only if it was still on the page or on the
// message. To make the late case happen on every run, the page holds topic threads’ events back until the test lets
// them go (holdTopics, below); POSTBOX_STREAM_LAG makes it happen by itself, some of the time.

import { expect, test } from '@playwright/test';
import { heldCount, holdTopics, release } from './hold-threads.mjs';
import { failOnPageErrors, keptListeners, startPostbox, synced } from './postbox.mjs';
import { sideRoom } from './side-threads.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('reply-in-thread');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light', viewport: { width: 1280, height: 800 } });

/**
 * Where focus is in the page, by id. Checked through `document.activeElement`, not Playwright’s `toBeFocused`, which
 * also needs the window itself to have focus: on a loaded machine another window can take it, and the page reads
 * inactive though its focus is where it should be.
 * @param {import('@playwright/test').Page} page  @param {string} id
 */
const focusIsOn = (page, id) => expect.poll(() => page.evaluate(() => document.activeElement?.id ?? null)).toBe(id);

/** A room of its own with one message from @indexer and no thread on it, open in the page. */
async function openRoom(page, title) {
  const r = sideRoom(app, title);
  const message = app.rt.addItem(r.room.id, {
    ...{ kind: 'agent', sessionId: r.indexer.id, personaId: r.indexer.personaId, handle: 'indexer' },
    ...{ text: 'The 1908 edition drops two chapters.', status: 'done' },
  });
  await page.goto(`${app.origin}/#/t/${r.room.id}`);
  await synced(page, app);
  return { ...r, message, item: page.locator(`#main [data-key="${message.id}"]`) };
}
/** Clicks the message’s Reply in thread, waits for the address to name its new thread, and returns that thread’s id. */
async function replyInThread(page, { room, item }) {
  await item.getByRole('button', { name: 'Reply in thread' }).click();
  await expect(page).toHaveURL(new RegExp(`#/t/${room.id}/side/th_`));
  return new URL(page.url()).hash.split('/side/')[1].split('/')[0];
}
/** Waits until the page has heard the topic thread’s event and is holding it. */
const heard = (page) => expect.poll(() => heldCount(page), { message: 'the topic thread’s event, held' }).toBeGreaterThan(0);
/** Lets the held events go, and waits until the page has the topic thread. */
async function arrived(page, topicId) {
  await release(page);
  const has = () => page.evaluate((id) => import('/app/js/client.mjs').then(({ client }) => !!client.state.threads[id]), topicId);
  await expect.poll(has, { message: `the page to have ${topicId}` }).toBe(true);
}

for (const width of [375, 1280]) {
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: 800 } });

    test('Reply in thread opens the thread with focus in its composer', async ({ page }) => {
      const r = await openRoom(page, `Reply quick ${width}`);
      await replyInThread(page, r);
      await expect(page.locator('#side-input')).toBeVisible();
      await focusIsOn(page, 'side-input');
    });

    test('Reply in thread opens the thread when its event arrives after the address changed', async ({ page }) => {
      await holdTopics(page);
      const r = await openRoom(page, `Reply late ${width}`);
      const topicId = await replyInThread(page, r);
      await heard(page);
      await expect(page.locator('.sidepanel'), 'no panel before the thread’s event').toHaveCount(0);
      await arrived(page, topicId);
      await expect(page.locator('#side-input')).toBeVisible();
      await focusIsOn(page, 'side-input');
    });
  });
}

// When the thread arrives late, at 1280 px.

test('a room that redraws meanwhile still gets the panel, with focus in its composer', async ({ page }) => {
  await holdTopics(page);
  const r = await openRoom(page, 'Reply late redraw');
  const topicId = await replyInThread(page, r);
  await heard(page);
  app.rt.addItem(r.room.id, {
    ...{ kind: 'agent', sessionId: r.researcher.id, personaId: r.researcher.personaId, handle: 'researcher' },
    ...{ text: 'And the 1912 one adds a preface.', status: 'done' },
  });
  await expect(page.locator('#main').getByText('And the 1912 one adds a preface.')).toBeVisible();
  await arrived(page, topicId);
  await focusIsOn(page, 'side-input');
});

test('focus the person moved elsewhere stays there', async ({ page }) => {
  await holdTopics(page);
  const r = await openRoom(page, 'Reply late moved');
  const topicId = await replyInThread(page, r);
  await heard(page);
  await page.locator('#composer-input').click();
  await focusIsOn(page, 'composer-input');
  await arrived(page, topicId);
  await expect(page.locator('#side-input')).toBeVisible();
  await focusIsOn(page, 'composer-input'); // focus stayed in the conversation’s composer
});

test('going to another conversation first opens nothing there', async ({ page }) => {
  await holdTopics(page);
  const other = sideRoom(app, 'Reply late elsewhere');
  const r = await openRoom(page, 'Reply late left');
  const topicId = await replyInThread(page, r);
  await heard(page);
  const listeners = () => keptListeners(page);
  const goTo = async (room) => {
    await page.locator(`.rail a[href="#/t/${room.id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`#/t/${room.id}$`));
  };
  await goTo(other.room);
  const once = await listeners();
  await goTo(r.room);
  await goTo(other.room);
  expect(await listeners(), 'leaving the room again leaves no listener behind').toBe(once);
  await arrived(page, topicId);
  await expect(page.locator('.sidepanel')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#/t/${other.room.id}$`));
});

test('closing the thread’s address first opens nothing', async ({ page }) => {
  await holdTopics(page);
  const r = await openRoom(page, 'Reply late closed');
  const topicId = await replyInThread(page, r);
  await heard(page);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#/t/${r.room.id}$`));
  await arrived(page, topicId);
  await expect(page.locator('.sidepanel')).toHaveCount(0);
});

// When the thread is already on the page.

/**
 * Has the page count the timers that move focus to the thread’s composer once they’ve run, as Reply in thread’s does,
 * so a test can wait for that one rather than for a fixed time.
 * @param {import('@playwright/test').Page} page
 */
const countFocusTimers = (page) =>
  page.evaluate(() => {
    const w = /** @type {any} */ (window);
    const set = w.setTimeout;
    w.focusTimersRun = 0;
    w.setTimeout = (fn, ms, ...args) => {
      if (typeof fn !== 'function' || !String(fn).includes('side-input')) return set(fn, ms, ...args);
      return set(() => {
        fn(...args);
        w.focusTimersRun += 1;
      }, ms);
    };
  });
/** Whether nothing in the page has focus. */
const focusIsOff = (page) => expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);

test('focus the person moves as the address changes stays there, when the thread is already on the page', async ({ page }) => {
  const r = await openRoom(page, 'Reply quick moved');
  // The person moves to the conversation’s composer as the address changes: before Reply in thread’s own 150 ms timer.
  await page.evaluate(() => addEventListener('hashchange', () => document.getElementById('composer-input')?.focus(), { once: true }));
  await countFocusTimers(page);
  await replyInThread(page, r);
  await expect(page.locator('#side-input')).toBeVisible();
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).focusTimersRun), { message: 'that timer, run' }).toBe(1);
  await focusIsOn(page, 'composer-input');
});

test('a thread already open that changes doesn’t take focus', async ({ page }) => {
  const r = await openRoom(page, 'Reply open renamed');
  await countFocusTimers(page);
  const topicId = await replyInThread(page, r);
  await focusIsOn(page, 'side-input');
  // The thread can land before Reply in thread’s own 150 ms timer, so wait for that timer before moving focus.
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).focusTimersRun), { message: 'that timer, run' }).toBe(1);
  await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement).blur());
  await focusIsOff(page);
  app.rt.renameThread(topicId, 'The 1908 edition');
  const renamed = () => page.evaluate((id) => import('/app/js/client.mjs').then(({ client }) => client.state.threads[id]?.title), topicId);
  await expect.poll(renamed).toBe('The 1908 edition');
  await focusIsOff(page);
});

test('a thread’s address opens its panel on a fresh load', async ({ page }) => {
  const r = sideRoom(app, 'Reply reload');
  const message = app.rt.addItem(r.room.id, {
    ...{ kind: 'agent', sessionId: r.indexer.id, personaId: r.indexer.personaId, handle: 'indexer' },
    ...{ text: 'The 1908 edition drops two chapters.', status: 'done' },
  });
  const topicId = app.rt.startTopic(r.room.id, message.id).threadId;
  await page.goto(`${app.origin}/#/t/${r.room.id}/side/${topicId}`);
  await synced(page, app);
  await expect(page.locator(`.sidepanel .transcript[data-thread="${topicId}"]`)).toBeVisible();
});

test('a thread that comes with the state loaded again, not its own event, opens too', async ({ page }) => {
  await holdTopics(page);
  const r = await openRoom(page, 'Reply late resync');
  const topicId = await replyInThread(page, r);
  await heard(page);
  // The page loads its state again, as it does on a resync; the thread’s own event stays held.
  await page.evaluate(() => import('/app/js/client.mjs').then(({ load }) => load()));
  await expect(page.locator(`.sidepanel .transcript[data-thread="${topicId}"]`)).toBeVisible();
  await focusIsOn(page, 'side-input');
});
