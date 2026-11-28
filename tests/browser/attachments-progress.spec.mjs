// #870: a large upload shows its progress. The chip said only “uploading…” until the server answered, so a large
// file looked stuck. Now it says how much has gone, as a percentage. The upload is slowed through Chromium’s own network
// emulation (CDP Network.emulateNetworkConditions), so the progress is there to see without a large file; the drop is
// attachments.spec.mjs’s, a synthetic DragEvent carrying a real File, through the app’s own upload path.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { allowPageError, failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('attachments-progress');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const SIZE = 6 * 1024 * 1024;

test('#870 a large upload shows how much has gone, then the file’s size once it’s attached', async ({ page }) => {
  const { rt } = app;
  const t = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title: 'Progress', personaIds: [arrange.persona(rt, 'librarian').id] });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  // About 2 MB a second up: the 6 MB file takes a few seconds, long enough to read its progress.
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 2 * 1024 * 1024 });
  /** Every text the chip shows while it uploads, in order. */
  const seen = page.evaluate(
    () =>
      new Promise((done) => {
        /** @type {string[]} */
        const texts = [];
        const watch = new MutationObserver(() => {
          const chip = document.querySelector('.main .composer .attachments .att');
          const text = chip?.textContent ?? '';
          if (text && texts.at(-1) !== text) texts.push(text);
          if (chip && !/uploading/.test(text)) {
            watch.disconnect();
            done(texts);
          }
        });
        watch.observe(document.body, { subtree: true, childList: true, characterData: true });
      }),
  );
  await page.evaluate(
    ({ size }) => {
      const file = new File([new Uint8Array(size).fill(7)], 'Screen Recording.mov', { type: 'video/quicktime' });
      const box = /** @type {Element} */ (document.querySelector('.main .transcript')).getBoundingClientRect();
      const target = /** @type {Element} */ (document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
      const dt = new DataTransfer();
      dt.items.add(file);
      for (const type of ['dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    { size: SIZE },
  );
  const texts = /** @type {string[]} */ (await seen);
  const percents = texts.map((x) => Number(x.match(/uploading… (\d+)%/)?.[1] ?? Number.NaN)).filter((n) => !Number.isNaN(n));
  expect(percents.length, `the chip showed its progress: ${JSON.stringify(texts)}`).toBeGreaterThan(1);
  expect(percents, 'the progress only goes up').toEqual([...percents].sort((a, b) => a - b));
  expect(percents.every((n) => n >= 0 && n <= 100)).toBe(true);
  await expect(page.locator('.main .composer .attachments .att'), 'once attached, its size').toContainText(/Screen Recording\.mov · \d+(\.\d)? MB/);
});

test('#870 an upload with a stale page token gets a fresh one and goes through, as the API’s writes do', async ({ page, context }) => {
  const { rt } = app;
  const t = rt.createThread({
    projectId: Object.values(rt.store.state.projects)[0].id,
    title: 'Stale token',
    personaIds: [arrange.persona(rt, 'librarian').id],
  });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  // The token a page held before Postbox restarted with a new one.
  const cookie = (await context.cookies()).find((c) => c.name.startsWith('pb_token_'));
  expect(cookie, 'the page holds a token').toBeTruthy();
  await context.addCookies([{ .../** @type {any} */ (cookie), value: 'stale' }]);
  // The refusal of the stale token, which Chromium logs as a failed resource.
  allowPageError(page, /status of 403/);
  const answers = [];
  page.on('response', (r) => {
    if (r.url().endsWith('/api/files')) answers.push(r.status());
  });
  await page.evaluate(() => {
    const file = new File(['a,b\n1,2\n'], 'pairs.csv', { type: 'text/csv' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const target = /** @type {Element} */ (document.querySelector('.main .transcript'));
    for (const type of ['dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await expect(page.locator('.main .composer .attachments .att', { hasText: 'pairs.csv' }), 'attached').not.toContainText('uploading');
  expect(answers, 'refused once for the token, then stored').toEqual([403, 201]);
  const kept = await page.evaluate((id) => localStorage.getItem(`pb-draft-files-${id}`), t.id);
  expect(kept, 'the draft keeps the upload (draft-attachments.mjs)').toContain('pairs.csv');
  expect(kept, 'a finished upload keeps no progress in the saved draft').not.toContain('percent');
});
