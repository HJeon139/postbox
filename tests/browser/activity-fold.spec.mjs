// A reply’s folded steps are built only when the list opens (#1028). Every reply with steps used to build its whole
// list while closed: in a long room, two thirds of the page’s elements, which something searching every element on
// each key (a browser extension, in the maintainer’s profile) pays for. A folded list holds its summary and one element
// with the steps’ labels as text, so Find still finds them; its first open builds the list, and it stays built.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, focusIs, openAs, startPostbox } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('activity-fold', { demo: false });
  app.store.emit('project', { id: 'pr_fold', name: 'Fold', folder: app.root });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

/** A turn’s steps, shaped as real ones are: reads, a search, a failed command, thoughts, and a subagent’s own steps. */
const steps = (n) => [
  { id: `th1_${n}`, kind: 'thought', label: 'Plan the change.', detail: 'Read the module first, then its tests.', state: 'done' },
  { id: `rd1_${n}`, label: `Read app/js/module-${n}.mjs`, state: 'done', ms: 12 },
  { id: `gr_${n}`, label: 'grep paintActivity', state: 'done', ms: 30 },
  { id: `rd2_${n}`, label: `Read app/js/module-${n}.test.mjs`, state: 'done', ms: 9 },
  { id: `rd3_${n}`, label: 'Read designs/architecture.md', state: 'done', ms: 15 },
  { id: `gr2_${n}`, label: 'grep stepTree', state: 'done', ms: 22 },
  { id: `tc_${n}`, label: 'npm run typecheck', state: 'done', ms: 6100 },
  { id: `rd4_${n}`, label: 'Read app/workbench.css', state: 'done', ms: 11 },
  { id: `np_${n}`, label: 'npm test', state: 'failed', detail: '2 tests failed', ms: 4100 },
  { id: `ag_${n}`, kind: 'agent', label: 'Task: check the tests', state: 'done', detail: 'All of them pass now.', ms: 9000 },
  { id: `sr_${n}`, parent: `ag_${n}`, who: 'helper', label: 'Read tests/module.test.mjs', state: 'done', ms: 8 },
  { id: `sd_${n}`, parent: `ag_${n}`, who: 'helper', kind: 'said', label: 'Checking now.', detail: 'Checking the tests now, one by one.', state: 'done' },
  { id: `ed_${n}`, label: `Edit app/js/module-${n}.mjs`, state: 'done', ms: 20 },
  { id: `ln_${n}`, label: 'npm run lint', state: 'done', ms: 2400 },
  { id: `th2_${n}`, kind: 'thought', label: 'Check the result.', detail: 'Check the result against the request.', state: 'done' },
];
/** How many steps a seeded reply has. */
const STEPS = steps(0).length;

let rooms = 0;
/**
 * A conversation of `count` items open in the page: every third the person’s, the rest agent replies with steps.
 * Returns the newest reply, and a way to send it a step.
 */
async function seeded(page, count = 3) {
  const { rt, store } = app;
  const p = rt.createPersona({ handle: `folder${++rooms}` });
  const t = rt.createThread({ projectId: 'pr_fold', title: `Fold ${rooms}`, personaIds: [p.id] });
  const se = arrange.agentIn(rt, t.id);
  let last = '';
  for (let i = 0; i < count; i++) {
    if (i % 3 === 0) arrange.post(rt, t.id, { kind: 'user', text: `Message ${i}: carry on.`, status: 'done' });
    else {
      const reply = { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, status: 'done' };
      last = arrange.post(rt, t.id, { ...reply, text: `Reply ${i} says what it found.`, activity: { steps: steps(i) } }).id;
    }
  }
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await expect(page.locator(`.transcript[data-thread="${t.id}"] > [data-key]`)).toHaveCount(count, { timeout: 30_000 });
  // A big room’s last events can reach a slow CI runner after its items have drawn, past synced()’s 5 s (#1028).
  const seq = app.store.state.seq;
  await expect
    .poll(() => page.evaluate(() => import('/app/js/client.mjs').then(({ client }) => client.seq)), {
      message: `the page to hear event ${seq}`,
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(seq);
  const reply = page.locator(`.transcript[data-thread="${t.id}"] [data-key="${last}"]`);
  /** @param {Record<string, any>} step */
  const step = (step) => store.emit('item.patch', { threadId: t.id, id: last, activityStep: { state: 'done', ms: 50, ...step } });
  return { t, last, reply, list: reply.locator(':scope > details.activity'), step };
}

/** The labels of the steps of the reply numbered n. */
const labelsOf = (n) => steps(n).map((s) => s.label);

test('#1028 a folded reply holds its summary and one element with its steps’ labels, and no step list', async ({ page }) => {
  const { list } = await seeded(page);
  await expect(list).not.toHaveAttribute('open', '');
  await expect.soft(list.locator('ul.steps'), 'no step list while folded').toHaveCount(0);
  await expect.soft(list.locator(':scope > *'), 'the summary and one element').toHaveCount(2);
  await expect.soft(list.locator(':scope > :not(summary) *'), 'the text copy holds no elements').toHaveCount(0);
  const text = await list.locator(':scope > :not(summary)').textContent();
  for (const label of labelsOf(2)) expect.soft(text, `the text copy holds “${label}”`).toContain(label);
});

test('#1028 opening a folded reply builds its list once, by click, Enter or Space', async ({ page }) => {
  const { t, list } = await seeded(page, 6);
  await list.locator('> summary').click();
  await expect(list.locator('ul.steps li'), 'one row a step').toHaveCount(STEPS);
  for (const label of labelsOf(5)) await expect.soft(list.locator('ul.steps').getByText(label), label).toBeVisible();
  await list
    .locator('ul.steps')
    .first()
    .evaluate((el) => {
      /** @type {any} */ (el).__built = true;
    });
  await list.locator('> summary').click();
  await expect(list).not.toHaveAttribute('open', '');
  await list.locator('> summary').click();
  await expect(list.locator('ul.steps li'), 'still one row a step').toHaveCount(STEPS);
  const same = await list
    .locator('ul.steps')
    .first()
    .evaluate((el) => /** @type {any} */ (el).__built === true);
  expect.soft(same, 'the same list, not a new one').toBe(true);
  // The other two replies, opened by keyboard.
  for (const [i, key] of ['Enter', 'Space'].entries()) {
    const other = page.locator(`.transcript[data-thread="${t.id}"] details.activity`).nth(i + 1);
    await other.locator('> summary').focus();
    await page.keyboard.press(key);
    await expect.soft(other, `${key} opens it`).toHaveAttribute('open', '');
    await expect.soft(other.locator('ul.steps li'), `${key}: one row a step`).toHaveCount(STEPS);
  }
});

for (const how of ['a click', 'Enter', 'Space'])
  test(`#1028 opening a folded reply by ${how} paints no frame of its text copy`, async ({ page }) => {
    const { list } = await seeded(page, 3);
    const summary = list.locator(':scope > summary');
    // Each frame after the press, before it paints: open with the text copy still in it would show the joined labels.
    await summary.evaluate((s) => {
      const d = /** @type {HTMLDetailsElement} */ (s.parentElement);
      const w = /** @type {any} */ (window);
      w.pbShown = [];
      const look = () => w.pbShown.push(d.open && !!d.querySelector(':scope > .steps-folded'));
      s.addEventListener('click', () => {
        const frame = () => {
          look();
          if (w.pbShown.length < 3) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
    });
    if (how === 'a click') await summary.click();
    else await summary.press(how === 'Enter' ? 'Enter' : ' ');
    await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).pbShown.length)).toBe(3);
    expect(await page.evaluate(() => /** @type {any} */ (window).pbShown), 'no frame open with the text copy').toEqual([false, false, false]);
  });

test('#1028 after opening a reply by keyboard, Tab reaches its steps’ own controls in order', async ({ page }) => {
  const { list } = await seeded(page);
  await list.locator('> summary').focus();
  await page.keyboard.press('Enter');
  await expect(list.locator('ul.steps li')).toHaveCount(STEPS);
  for (const name of ['Plan the change.', 'helper: Checking now.', 'Check the result.']) {
    await page.keyboard.press('Tab');
    await focusIs(page, `summary: ${name}`);
  }
});

test('#1028 a live step updates a folded reply’s summary and text without building its list', async ({ page }) => {
  const { reply, list, step } = await seeded(page);
  await reply.evaluate((el) => {
    /** @type {any} */ (el).__node = true;
  });
  step({ id: 'live_1', label: 'Read the live file.md' });
  await expect(list.locator('> summary'), 'the count includes the new step').toContainText('Used 13 tools');
  await expect.soft(list.locator(':scope > :not(summary)'), 'the text copy has it').toContainText('Read the live file.md');
  await expect.soft(list.locator('ul.steps'), 'still no list').toHaveCount(0);
  expect.soft(await reply.evaluate((el) => /** @type {any} */ (el).__node === true), 'painted in place, not drawn again').toBe(true);
  await list.locator('> summary').click();
  await expect(list.locator('ul.steps li'), 'opened, with the live step').toHaveCount(STEPS + 1);
  await expect(list.locator('ul.steps').getByText('Read the live file.md')).toBeVisible();
});

test('#1028 a live step repaints an open list in place, keeping an expanded thought and its focus', async ({ page }) => {
  const { list, step } = await seeded(page);
  await list.locator('> summary').click();
  const thought = list.locator('details.step-text').filter({ hasText: 'Plan the change.' });
  await thought.locator('> summary').click();
  await expect(thought).toHaveAttribute('open', '');
  await expect(thought.locator('> summary')).toBeFocused();
  step({ id: 'live_2', label: 'Read another file.md' });
  await expect(list.locator('ul.steps li'), 'the new step is listed').toHaveCount(STEPS + 1);
  await expect.soft(list, 'the list stays open').toHaveAttribute('open', '');
  await expect.soft(thought, 'the thought stays expanded').toHaveAttribute('open', '');
  await expect.soft(thought.locator('> summary'), 'and keeps focus').toBeFocused();
});

test('#1028 a reply drawn again keeps an opened list opened and built', async ({ page }) => {
  const { t, last, reply, list } = await seeded(page);
  await list.locator('> summary').click();
  const thought = list.locator('details.step-text').filter({ hasText: 'Check the result.' });
  await thought.locator('> summary').click();
  await expect(thought).toHaveAttribute('open', '');
  await reply.evaluate((el) => {
    /** @type {any} */ (el).__node = true;
  });
  app.store.emit('item.patch', { threadId: t.id, id: last, patch: { text: 'The reply, revised.' } });
  await expect(reply.locator(':scope > .md'), 'the reply drawn again').toContainText('The reply, revised.');
  expect.soft(await reply.evaluate((el) => /** @type {any} */ (el).__node === true), 'a new node').toBe(false);
  await expect.soft(list, 'the list stays open').toHaveAttribute('open', '');
  await expect.soft(list.locator('ul.steps li'), 'and built').toHaveCount(STEPS);
  await expect.soft(thought, 'the thought stays expanded').toHaveAttribute('open', '');
});

/** Elements in the page, and in the folded lists besides their summaries. */
const counts = (page) =>
  page.evaluate(() => ({
    page: document.getElementsByTagName('*').length,
    lists: document.querySelectorAll('details.activity').length,
    steps: document.querySelectorAll('details.activity > :not(summary), details.activity > :not(summary) *').length,
  }));

test('#1028 a 300-item room holds at most a third of the elements it would with every list built', async ({ page }) => {
  test.setTimeout(90_000);
  // The whole room on the page, as the count is per list: with the transcript window on, a room over 240 items mounts
  // only about 40 (#866).
  await openAs(page, 'whole room');
  await seeded(page, 300);
  const folded = await counts(page);
  expect(folded.lists, 'two of three items are replies with steps').toBe(200);
  expect.soft(folded.steps, 'one element a folded list besides its summary').toBe(folded.lists);
  // Building every list, in one task through the page’s own module, gives what main builds folded, give or take one
  // element a list. Opening each one and waiting for its toggle took over 30 s on CI’s runners.
  await page.evaluate(() =>
    import('/app/js/activity-paint.mjs').then(({ buildSteps }) => {
      for (const d of document.querySelectorAll('details.activity')) buildSteps(/** @type {HTMLElement} */ (d));
    }),
  );
  const built = await counts(page);
  test.info().annotations.push({ type: 'measured', description: JSON.stringify({ folded, built }) });
  expect(await page.locator('details.activity > .steps-folded').count(), 'every list built').toBe(0);
  expect(folded.page, `${folded.page} elements folded, ${built.page} built`).toBeLessThanOrEqual(built.page / 3);
});

test('#1028 Find with a step’s text opens its folded reply and shows the step in the built list', async ({ page }) => {
  const { t, list } = await seeded(page, 60);
  // A reply in the middle of the room, which Find scrolls to the middle of the view.
  const reply = page.locator(`.transcript[data-thread="${t.id}"] > [data-key]`).filter({ hasText: 'Reply 31 says' }).locator(':scope > details.activity');
  const label = 'Read app/js/module-31.mjs';
  await expect(reply.locator('ul.steps'), 'not built before Find').toHaveCount(0);
  await expect(list).toBeInViewport();
  await expect(reply, 'the reply starts out of view').not.toBeInViewport();
  // A text fragment uses the browser’s own find-in-page, which opens a closed details around its match (Chromium, and
  // Firefox’s too). Playwright can’t press the browser’s Ctrl+F; window.find opens nothing in Chromium.
  const text = encodeURIComponent(label).replaceAll('-', '%2D');
  await page.goto(`${app.origin}/#/t/${t.id}:~:text=${text}`);
  await expect(reply, 'Find opened the reply').toHaveAttribute('open', '');
  const row = reply.locator('ul.steps').getByText(label, { exact: true });
  await expect(row, 'the step, in the built list').toBeVisible();
  await expect(row, 'and in view').toBeInViewport();
});
