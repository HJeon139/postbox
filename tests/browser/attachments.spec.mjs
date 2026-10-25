// Image attachments and dropping files (#48):
// - an image the server shows inline (PNG) gets a thumbnail served by /api/files, which opens the full image by
//   keyboard;
// - an image the server doesn’t show inline (SVG) keeps the file chip;
// - a file dropped on a topic thread’s panel attaches to the panel’s composer, not the conversation’s;
// - a file dropped on the conversation, with the panel open, still attaches to the conversation’s composer.
// Drops are synthetic DragEvents carrying a real DataTransfer with a File, dispatched on the element under the point a
// person would drop on. They bubble through the real DOM to the app’s own listeners, which then upload through the
// app’s own path (POST /api/files); a real drag needs files on disk and a drag the browser started. Each test has a
// conversation of its own. Moved from tools/checks/attachments.mjs (#303).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('attachments');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

/** A conversation of its own with @librarian, and a message of yours to start a topic thread from. */
function conversation(title) {
  const { rt } = app;
  const t = rt.createThread({ projectId: Object.values(rt.s.projects)[0].id, title, personaIds: [rt.personaByHandle('librarian').id] });
  const root = rt.addItem(t.id, { kind: 'user', text: 'Start a thread from here.' });
  return { t, topic: () => rt.startTopic(t.id, root.id).threadId };
}
/** Builds a file in the page and drops it on the element at the middle of what the selector finds. */
const drop = (page, selector, kind, name) =>
  page.evaluate(
    async ({ sel, k, n }) => {
      let file;
      if (k === 'png') {
        const c = document.createElement('canvas');
        c.width = 64;
        c.height = 48;
        const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
        g.fillStyle = 'orange';
        g.fillRect(0, 0, 64, 48);
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        file = new File([/** @type {Blob} */ (blob)], n, { type: 'image/png' });
      } else file = new File(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'], n, { type: 'image/svg+xml' });
      const box = /** @type {Element} */ (document.querySelector(sel)).getBoundingClientRect();
      const target = /** @type {Element} */ (document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
      const dt = new DataTransfer();
      dt.items.add(file);
      const fire = (type) => !target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      return { allowed: fire('dragover'), taken: fire('drop') };
    },
    { sel: selector, k: kind, n: name },
  );
const chips = (page, scope) => page.locator(`${scope} .composer .attachments .att`);

test('#48 a PNG sent gets a thumbnail from /api/files that opens the full image by keyboard, and an SVG keeps its file chip', async ({ page, context }) => {
  const { t } = conversation('Thumbnails');
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  expect(await drop(page, '.main .transcript', 'png', 'shot.png'), 'a drop on the conversation is allowed and taken').toEqual({ allowed: true, taken: true });
  await drop(page, '.main .transcript', 'svg', 'diagram.svg');
  await expect(chips(page, '.main'), 'both files attach to the conversation’s composer').toHaveCount(2);
  await expect(chips(page, '.main').filter({ hasText: 'uploading' }), 'both uploaded').toHaveCount(0);
  await page.locator('.main .composer').getByRole('button', { name: 'Send', exact: true }).click();
  const sent = page.locator('.transcript .me-card .attachments', { hasText: 'diagram.svg' });
  const img = sent.locator('img');
  await expect
    .poll(() => img.evaluate((i) => /** @type {HTMLImageElement} */ (i).complete && /** @type {HTMLImageElement} */ (i).naturalWidth), {
      message: 'the thumbnail loads',
    })
    .toBe(64);
  const thumb = await img.evaluate((i) => {
    const link = /** @type {HTMLAnchorElement} */ (i.closest('a'));
    const r = i.getBoundingClientRect();
    return {
      src: i.getAttribute('src'),
      alt: /** @type {HTMLImageElement} */ (i).alt,
      w: r.width,
      h: r.height,
      href: link.getAttribute('href'),
      target: link.target,
      rel: link.rel,
      name: link.textContent,
    };
  });
  expect.soft(thumb.src, 'served by /api/files').toMatch(/^\/api\/files\/fi/);
  expect.soft(thumb.alt, 'its alt text is the file name').toBe('shot.png');
  expect.soft([thumb.w, thumb.h], 'a fixed size').toEqual([160, 120]);
  expect.soft([thumb.href, thumb.target], 'a link to the full image in a new tab').toEqual([thumb.src, '_blank']);
  expect.soft(thumb.rel).toMatch(/noopener/);
  expect.soft(thumb.name, 'the link shows the name and size').toMatch(/shot\.png · \d+ KB/);
  const res = await fetch(app.origin + thumb.href);
  expect.soft(res.headers.get('content-type'), 'the full image, as a PNG').toBe('image/png');
  expect.soft(res.headers.get('content-disposition'), 'served inline').toMatch(/^inline/);
  // Keyboard: focus the link and press Enter; the full image opens in a new tab.
  const link = sent.locator('a.att-image');
  await link.focus();
  await expect(link, 'the thumbnail link takes keyboard focus').toBeFocused();
  const [tab] = await Promise.all([context.waitForEvent('page'), page.keyboard.press('Enter')]);
  await expect.poll(() => tab.url(), { message: 'Enter opens the full image' }).toMatch(new RegExp(`${thumb.href}$`));
  await tab.close();
  const svg = sent.locator('.att', { hasText: 'diagram.svg' });
  await expect(svg.locator('img'), 'an SVG keeps the file chip').toHaveCount(0);
  await expect(svg.locator('a')).toHaveAttribute('href', /^\/api\/files\//);
});

test('#48 a file dropped on a topic thread’s panel attaches to its composer, and one dropped on the conversation beside it to the conversation’s', async ({
  page,
}) => {
  const { t, topic } = conversation('Drops');
  const side = topic();
  await page.goto(`${app.origin}/#/t/${t.id}/side/${side}`);
  await synced(page, app);
  await expect(page.locator('#side-input')).toBeVisible();
  expect(await drop(page, 'aside.sidepanel .sp-body', 'png', 'panel.png'), 'a drop on the panel is allowed and taken').toEqual({ allowed: true, taken: true });
  await expect(chips(page, 'aside.sidepanel').filter({ hasText: 'panel.png' }), 'it attaches to the panel’s composer').toHaveCount(1);
  await expect(chips(page, '.main'), 'not to the conversation’s').toHaveCount(0);
  await drop(page, '.main .transcript', 'png', 'main.png');
  await expect(chips(page, '.main').filter({ hasText: 'main.png' }), 'a drop on the conversation attaches to its composer').toHaveCount(1);
  await expect(chips(page, 'aside.sidepanel'), '…and not to the panel’s').toHaveCount(1);
  await page.locator('aside.sidepanel').getByRole('button', { name: 'Add a file or a new agent' }).click();
  await expect(page.getByRole('menuitem', { name: /^Upload from computer/ }), 'the panel’s plus menu says where to drop files').toContainText(
    'Or drop files on this thread',
  );
});
