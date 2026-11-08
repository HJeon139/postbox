// A press in an agent’s quick panel isn’t lost to a repaint (#898). The panel repaints on any change to its session,
// such as the context it has used, and the repaint replaced the button under a press that had started: the click
// then landed on nothing. Here the repaint comes while the press is held: the test holds the mouse (or Space) down on
// the control, changes what the panel shows on the server, waits until the page has heard it, then lets go.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, focusIs, frames, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {any} */
let room;
/** @type {any} */
let coder;
/** Lets the held turn end. */
let release = () => {};

test.beforeAll(async () => {
  app = await startPostbox('agent-panel-press');
  const { rt, store } = app;
  // A Codex-like backend: a running turn keeps its mode, so a pick says so. Its turn holds until released or stopped.
  rt.adapters.register({
    name: 'codex',
    async folderFor() {
      return app.root;
    },
    async deliver(_session, _message, ctx) {
      ctx.status({ state: 'tool', currentStep: 'Running the tests' });
      await new Promise((r) => {
        release = () => r(undefined);
        ctx.signal.addEventListener('abort', () => r(undefined));
      });
    },
  });
  store.emit('project', { id: 'pr_press', name: 'Presses', folder: app.root });
  coder = rt.createPersona({ handle: 'coder', backend: 'codex', model: 'gpt-6-sol', permissionMode: 'bypass', tools: ['shell'] });
  room = rt.createThread({ projectId: 'pr_press', title: 'Presses', personaIds: [coder.id] });
});
test.afterAll(async () => {
  release();
  await app?.stop();
});
failOnPageErrors(test);

const session = () => app.rt.sessionsIn(room.id)[0];
const modeOnServer = () => app.rt.persona(coder.id)?.permissionMode;
const panel = (page) => page.locator('.backdrop .dialog.quick');
const sub = (page) => panel(page).locator('.d-head p');
const modes = (page) => panel(page).locator('[role=radiogroup][aria-label^="Permission mode"]');
const askMe = (page) => modes(page).getByRole('radio', { name: 'Ask me', exact: true });

let ctx = 10;
/** Changes the context the panel shows, on the server, and waits until the page has heard it. Returns its new text. */
async function repaint(page) {
  const n = ++ctx;
  app.rt.updateSession(session().id, { ctx: n });
  await synced(page, app);
  return `${n}% of context used`;
}

/**
 * coder in Run everything with a turn running, and its quick panel open: from its row at 1280 px; at 375 px, where
 * the sidebar doesn’t show and the panel is a sheet, as its row opens it.
 */
async function panelOpen(page) {
  await app.rt.setPermissionMode(coder.id, 'bypass');
  if (!app.rt.turns.has(session()?.id)) app.rt.sendMessage(room.id, { text: '@coder run the tests' });
  await expect.poll(() => app.rt.turns.has(session()?.id), { message: 'coder at work' }).toBe(true);
  await page.goto(`${app.origin}/#/t/${room.id}`);
  await synced(page, app);
  if ((page.viewportSize()?.width ?? 0) > 767) await page.locator('.rail .agent-row .agent-btn', { hasText: 'coder' }).click();
  else await page.evaluate((id) => import('/app/js/agents.mjs').then((m) => m.openAgentPanel(id)), session().id);
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
}

const PICKED =
  'Permission mode: Ask me for coder in every conversation, from their next turns. Its running turn here keeps the mode it started with until it ends: Stop it to apply this now.';

for (const width of [375, 1280]) {
  test.describe(`at ${width} px`, () => {
    test.use(width === 375 ? { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {});

    test(`a press held on Ask me while the panel repaints picks it, at ${width} px`, async ({ page }) => {
      await panelOpen(page);
      await askMe(page).hover();
      await page.mouse.down();
      const text = await repaint(page);
      await page.mouse.up();
      await expect.soft(panel(page).locator('.perm-status')).toHaveText(PICKED);
      await expect.soft.poll(modeOnServer, { message: 'the persona in Ask me' }).toBe('ask');
      await expect.soft(sub(page), 'the repaint it held landed').toContainText(text, { timeout: 1500 });
      await focusIs(page, 'radio: Ask me');
    });

    test(`a press held on Stop while the panel repaints stops the turn, at ${width} px`, async ({ page }) => {
      await panelOpen(page);
      await panel(page).getByRole('button', { name: 'Stop', exact: true }).hover();
      await page.mouse.down();
      await repaint(page);
      await page.mouse.up();
      await expect.poll(() => app.rt.turns.has(session().id), { message: 'coder stopped' }).toBe(false);
    });

    test(`Space held on Ask me while the panel repaints picks it, at ${width} px`, async ({ page }) => {
      await panelOpen(page);
      await askMe(page).focus();
      await page.keyboard.down('Space');
      const text = await repaint(page);
      await page.keyboard.up('Space');
      await expect.soft(panel(page).locator('.perm-status')).toHaveText(PICKED);
      await expect.soft.poll(modeOnServer, { message: 'the persona in Ask me' }).toBe('ask');
      await expect.soft(sub(page), 'the repaint it held landed').toContainText(text, { timeout: 1500 });
    });

    test(`a press dragged off Ask me and let go picks nothing, and the repaint lands, at ${width} px`, async ({ page }) => {
      await panelOpen(page);
      await askMe(page).hover();
      await page.mouse.down();
      const text = await repaint(page);
      // Off the panel to the backdrop where there’s room for it; at 375 px, where the sheet fills the width, to a heading.
      const box = width === 1280 ? { x: 1270, y: 890 } : await centerOf(panel(page).locator('.qp-head').first());
      await page.mouse.move(box.x, box.y, { steps: 4 });
      await page.mouse.up();
      await expect.soft(sub(page), 'the repaint it held landed').toContainText(text, { timeout: 1500 });
      await expect.soft(panel(page), 'the panel stayed open').toBeVisible();
      await expect.soft(panel(page).locator('.perm-status')).toHaveCount(0);
      expect.soft(modeOnServer(), 'the mode unchanged').toBe('bypass');
    });
  });
}

/** @param {import('@playwright/test').Locator} l */
async function centerOf(l) {
  const b = await l.boundingBox();
  if (!b) throw new Error('no box');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

test('a press held past 3 s lets the repaint land while it’s still held', async ({ page }) => {
  await panelOpen(page);
  await askMe(page).hover();
  await page.mouse.down();
  const text = await repaint(page);
  expect.soft(await sub(page).textContent(), 'held at first').not.toContain(text);
  await expect.soft(sub(page), 'it lands with the press still held').toContainText(text, { timeout: 5000 });
  await page.mouse.up();
});

test('a second press while one is held doesn’t start the 3 s again', async ({ page }) => {
  // The page’s own clock, ticking as usual, so the test can move it on by exact amounts.
  await page.clock.install();
  await panelOpen(page);
  // Space on the model’s choice the panel opened on, then the mouse on a heading: two holds that overlap.
  await page.keyboard.down('Space');
  const text = await repaint(page);
  expect.soft(await sub(page).textContent(), 'held at first').not.toContain(text);
  await page.clock.runFor(2000);
  await panel(page).locator('.qp-head').first().hover();
  await page.mouse.down();
  await page.clock.runFor(1100);
  expect(await sub(page).textContent(), 'landed 3 s after the first hold began, not the second').toContain(text);
  await page.mouse.up();
  await page.keyboard.up('Space');
});

test('a panel closed while a press is held paints nothing when it’s let go', async ({ page }) => {
  await panelOpen(page);
  await panel(page)
    .locator('.qp')
    .evaluate((qp) => {
      /** @type {any} */ (window).pbPanelBody = qp;
    });
  await panel(page).locator('.qp-head').first().hover();
  await page.mouse.down();
  await repaint(page);
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.pbPainted = 0;
    new MutationObserver(() => w.pbPainted++).observe(w.pbPanelBody, { childList: true, subtree: true });
  });
  await page.mouse.up();
  await frames(page);
  await frames(page);
  expect(await page.evaluate(() => /** @type {any} */ (window).pbPainted), 'the closed panel repainted nothing').toBe(0);
});

test.describe('by touch at 375 px', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  // The finger below goes through Chromium’s DevTools protocol, which other browsers don’t have.
  test.skip(({ browserName }) => browserName !== 'chromium', 'a held touch needs Chromium’s DevTools protocol');

  /** A finger on the page, through the DevTools protocol, so it stays down between the events it sends. */
  const finger = async (page) => {
    const cdp = await page.context().newCDPSession(page);
    return (type, at) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: at ? [at] : [] });
  };

  test('a tap held on Ask me while the panel repaints picks it', async ({ page }) => {
    await panelOpen(page);
    const touch = await finger(page);
    await touch('touchStart', await centerOf(askMe(page)));
    const text = await repaint(page);
    await touch('touchEnd');
    await expect.soft(panel(page).locator('.perm-status')).toHaveText(PICKED);
    await expect.soft.poll(modeOnServer, { message: 'the persona in Ask me' }).toBe('ask');
    await expect.soft(sub(page), 'the repaint it held landed').toContainText(text, { timeout: 1500 });
  });

  test('a touch the browser cancels lets the repaint land', async ({ page }) => {
    await panelOpen(page);
    const touch = await finger(page);
    await touch('touchStart', await centerOf(askMe(page)));
    const text = await repaint(page);
    expect.soft(await sub(page).textContent(), 'held at first').not.toContain(text);
    await touch('touchCancel');
    await expect.soft(sub(page), 'the repaint it held landed').toContainText(text, { timeout: 1500 });
    expect.soft(modeOnServer(), 'the mode unchanged').toBe('bypass');
  });
});

test('Space typed in a text field doesn’t hold a repaint', async ({ page }) => {
  // The panel has no text field today; a root that holds one, painted the way the panel is.
  await page.goto(`${app.origin}/#/t/${room.id}`);
  await synced(page, app);
  await page.evaluate(() =>
    import('/app/js/dom.mjs').then(({ h, heldPaint }) => {
      const w = /** @type {any} */ (window);
      const root = h('div', h('textarea', { 'aria-label': 'Draft' }));
      document.body.append(root);
      w.pbPaints = 0;
      w.pbPaint = heldPaint(root, () => w.pbPaints++);
    }),
  );
  await page.getByRole('textbox', { name: 'Draft' }).focus();
  await page.keyboard.down('Space');
  const painted = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.pbPaint();
    return w.pbPaints;
  });
  expect(painted, 'painted at once').toBe(1);
  await page.keyboard.up('Space');
});
