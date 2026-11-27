// #1616: a press on a running reply’s live steps or job rows was lost to the next frame’s refill. Each frame with new
// steps replaces the live block and the job rows (paintLive, app/js/activity-paint.mjs), so a press held across one
// ended on a new node, and the browser fired no click. Each case holds the mouse down on a control, lets the agent land
// a new step, which refills the block, then lets go: the click lands, and the refill it held lands after it.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { scriptedRoom } from './live-scripts.mjs';
import { allowPageError, synced } from './postbox.mjs';

const scripted = scriptedRoom(test, 'live-press');
const { scripts, hold, go, at, room } = scripted;

const step = (emit, id, command) => {
  emit({ kind: 'tool_call', id, name: 'Bash', input: { command }, final: true });
  emit({ kind: 'tool_result', id, text: `${command} ok` });
};

/**
 * Opens a room of `handles`, sends them a message, and waits until each script has reached its first hold.
 * @param {import('@playwright/test').Page} page @param {string[]} handles
 */
async function running(page, handles) {
  const t = room(`Press ${handles.join(' ')}`, handles);
  if (page.url().startsWith(scripted.app.origin)) await synced(page, scripted.app);
  await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
  await synced(page, scripted.app);
  scripted.app.rt.sendMessage(t.id, { text: `${handles.map((w) => `@${w}`).join(' ')} build` });
  await expect.poll(() => handles.map((w) => at(w)).join(' ')).toBe(handles.map(() => '1').join(' '));
  await synced(page, scripted.app);
  return t;
}

/** Holds the mouse down on a control while `who` lands its next step, and the page has heard it, then lets go. */
async function pressAcrossRefill(page, control, who) {
  await control.scrollIntoViewIfNeeded();
  await control.hover();
  await page.mouse.down();
  go(who);
  await expect.poll(() => at(who)).toBe(2);
  await synced(page, scripted.app);
  // Two frames: the one the step was queued for, and one more.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.mouse.up();
}

/** Lets each agent finish its turn, from whichever hold it waits at. */
async function finish(handles) {
  await expect
    .poll(() => {
      for (const w of handles) go(w);
      return arrange.liveTurns(scripted.app.rt);
    })
    .toBe(0);
}

test('#1616 a press held on “N earlier steps” while a step lands opens them, and the step lands after', async ({ page }) => {
  scripts.set('stepper', async ({ emit, who }) => {
    for (let i = 1; i <= 40; i++) step(emit, `e${i}`, `make part-${i}`);
    await hold(who, 1);
    step(emit, 'e41', 'make part-41');
    await hold(who, 2);
    step(emit, 'e42', 'make part-42');
    await hold(who, 3);
  });
  await running(page, ['stepper']);
  await pressAcrossRefill(page, page.locator('.live-steps details.earlier > summary'), 'stepper');
  await expect(page.locator('.live-steps details.earlier'), 'opened by the click').toHaveAttribute('open', '');
  await expect(page.locator('.live-steps li.step-full'), 'the held refill landed').toContainText('make part-41');
  // The press is over, so the reply is let go: the next step lands without another press.
  go('stepper');
  await expect.poll(() => at('stepper')).toBe(3);
  await expect(page.locator('.live-steps li.step-full'), 'a step after the press ended lands too').toContainText('make part-42');
  await finish(['stepper']);
});

test('#1616 a press held on “Show the whole thought” while a step lands shows it whole', async ({ page }) => {
  scripts.set('thinker', async ({ emit, who }) => {
    emit({ kind: 'thinking', text: 'The sum is wrong because the operator is a minus. '.repeat(40), block: 'th1' });
    emit({ kind: 'thinking_end', block: 'th1' });
    await hold(who, 1);
    step(emit, 't1', 'python -m pytest -q');
    await hold(who, 2);
  });
  await running(page, ['thinker']);
  await pressAcrossRefill(page, page.getByRole('button', { name: 'Show the whole thought' }), 'thinker');
  await expect(page.locator('.live-steps .live-thought'), 'shown whole').not.toHaveClass(/clamped/);
  await finish(['thinker']);
});

test('#1616 a press held on “Show the whole reply” in a crowded room while a step lands shows it whole', async ({ page }) => {
  const eight = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
  for (const who of eight)
    scripts.set(who, async ({ emit }) => {
      for (let i = 1; i <= 4; i++) step(emit, `${who}-${i}`, `make ${who}-${i}`);
      await hold(who, 1);
      step(emit, `${who}-5`, `make ${who}-5`);
      await hold(who, 2);
    });
  await running(page, eight);
  const block = page.locator('.live-steps.crowded').first();
  const who = /** @type {string} */ (await block.evaluate((b) => b.closest('[data-key]')?.querySelector('.who')?.textContent ?? ''));
  const handle = /** @type {string} */ (eight.find((w) => who.includes(w)));
  expect(handle, 'the crowded block names its agent').toBeTruthy();
  await pressAcrossRefill(page, block.getByRole('button', { name: 'Show the whole reply' }), handle);
  await expect(page.locator('.live-steps.crowded.whole'), 'shown whole').toHaveCount(1);
  await finish(eight);
});

test('#1616 a press held on a background job’s Stop while a step lands sends the stop', async ({ page }) => {
  scripts.set('jobber', async ({ emit, who }) => {
    emit({ kind: 'tool_call', id: 'bg1', name: 'Bash', input: { command: 'npm run watch', run_in_background: true }, final: true });
    emit({ kind: 'tool_result', id: 'bg1', text: 'Command running in background with ID: bash_1', background: { job: 'bash_1' } });
    await hold(who, 1);
    step(emit, 'j2', 'npm test');
    await hold(who, 2);
  });
  await running(page, ['jobber']);
  const stop = page.locator('.bg-jobs').getByRole('button', { name: /^Stop the background job/ });
  await expect(stop).toBeVisible();
  // The scripted backend has no process to stop, so the server refuses the stop, here twice; what’s checked is that the
  // click, held across the refill, sent it, and that Stop sends again once refused.
  allowPageError(page, /status of 409/, { times: 2 });
  const sent = page.waitForRequest((r) => r.method() === 'POST' && /\/jobs\/bash_1\/stop$/.test(r.url()), { timeout: 5000 });
  await pressAcrossRefill(page, stop, 'jobber');
  await sent;
  // Refused, Stop can be pressed again (#1837).
  await expect(stop, 'pressable again once the stop is refused').not.toHaveAttribute('aria-disabled', 'true');
  const again = page.waitForRequest((r) => r.method() === 'POST' && /\/jobs\/bash_1\/stop$/.test(r.url()), { timeout: 5000 });
  await stop.click();
  await again;
  await finish(['jobber']);
});

test('#1616 Space held on “N earlier steps” while a step lands opens them on its keyup', async ({ page }) => {
  scripts.set('keyer', async ({ emit, who }) => {
    for (let i = 1; i <= 40; i++) step(emit, `k${i}`, `make piece-${i}`);
    await hold(who, 1);
    step(emit, 'k41', 'make piece-41');
    await hold(who, 2);
  });
  await running(page, ['keyer']);
  const summary = page.locator('.live-steps details.earlier > summary');
  await summary.focus();
  await page.keyboard.down(' ');
  go('keyer');
  await expect.poll(() => at('keyer')).toBe(2);
  await synced(page, scripted.app);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.keyboard.up(' ');
  await expect(page.locator('.live-steps details.earlier'), 'opened by Space’s keyup').toHaveAttribute('open', '');
  await expect(page.locator('.live-steps li.step-full'), 'the held refill landed').toContainText('make piece-41');
  await finish(['keyer']);
});

// #1837: a refill replaced the job rows with a fresh, enabled Stop while the first stop was in flight, so a second press
// sent a second stop, and focus on Stop went to the page.
test('#1837 a job’s Stop pressed by keyboard stays pressed and focused across a refill, and a second press sends nothing', async ({ page }) => {
  scripts.set('stopper', async ({ emit, who }) => {
    emit({ kind: 'tool_call', id: 'bg2', name: 'Bash', input: { command: 'npm run serve', run_in_background: true }, final: true });
    emit({ kind: 'tool_result', id: 'bg2', text: 'Command running in background with ID: bash_2', background: { job: 'bash_2' } });
    await hold(who, 1);
    step(emit, 's2', 'npm test');
    await hold(who, 2);
  });
  await running(page, ['stopper']);
  const stop = page.locator('.bg-jobs').getByRole('button', { name: /^Stop the background job/ });
  await expect(stop).toBeVisible();
  // The stop waits at the server until the test lets it go, so it’s in flight across the refill.
  let stops = 0;
  /** @type {() => void} */
  let letGo = () => {};
  await page.route('**/jobs/bash_2/stop', async (route) => {
    stops++;
    await new Promise((r) => {
      letGo = () => r(undefined);
    });
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await stop.focus();
  await page.keyboard.press(' ');
  await expect.poll(() => stops, { message: 'the stop sent' }).toBe(1);
  go('stopper');
  await expect.poll(() => at('stopper')).toBe(2);
  await synced(page, scripted.app);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await expect(page.locator('.live-steps li.step-full'), 'the refill landed').toContainText('npm test');
  await expect(stop, 'still focused after the refill').toBeFocused();
  await expect(stop, 'still shown as pressed').toHaveAttribute('aria-disabled', 'true');
  // Pressed again, by mouse and by keyboard: forced, since Playwright won’t click what says it’s disabled, but a person can.
  await stop.click({ force: true });
  await page.keyboard.press(' ');
  // A request the page makes after both presses: a stop either sent would have reached its route first.
  let marked = false;
  await page.route('**/pb-test-marker', (route) => {
    marked = true;
    return route.fulfill({ status: 204 });
  });
  await page.evaluate(() => fetch('/pb-test-marker'));
  await expect.poll(() => marked).toBe(true);
  expect(stops, 'one stop, though pressed again').toBe(1);
  letGo();
  await finish(['stopper']);
});

// A stop that went through is kept for its reply: the next turn’s reply, whose process numbers its jobs afresh, has its
// own Stop for a job of the same id (#1837).
test('#1837 a later turn’s job with the id of one stopped before has a Stop that can be pressed', async ({ page }) => {
  scripts.set('again', async ({ emit, who }) => {
    emit({ kind: 'tool_call', id: 'bg3', name: 'Bash', input: { command: 'npm run watch', run_in_background: true }, final: true });
    emit({ kind: 'tool_result', id: 'bg3', text: 'Command running in background with ID: bash_3', background: { job: 'bash_3' } });
    await hold(who, 1);
  });
  const t = await running(page, ['again']);
  await page.route('**/jobs/bash_3/stop', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  const stop = page.locator('.bg-jobs').getByRole('button', { name: /^Stop the background job/ });
  await stop.click();
  await expect(stop).toHaveAttribute('aria-disabled', 'true');
  await finish(['again']);
  // The next turn starts a job the CLI numbers the same.
  scripted.app.rt.sendMessage(t.id, { text: '@again once more' });
  await expect.poll(() => at('again')).toBe(1);
  await synced(page, scripted.app);
  const fresh = page
    .locator('.transcript > [data-key]')
    .last()
    .locator('.bg-jobs')
    .getByRole('button', { name: /^Stop the background job/ });
  await expect(fresh).toBeVisible();
  await expect(fresh, 'the new turn’s Stop isn’t drawn pressed').not.toHaveAttribute('aria-disabled', 'true');
  await finish(['again']);
});
