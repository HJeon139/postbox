// #870: a file over the old 25 MB limit, such as a minute of screen recording, attaches and is sent. Before, the
// server answered 413 and the composer showed “Couldn’t attach … Files are limited to 25 MB.” The drop is
// attachments.spec.mjs’s: a synthetic DragEvent carrying a real DataTransfer with a File, on the element a person
// would drop on, so the upload goes through the app’s own path (POST /api/files).

import { statSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { attachmentPath } from '../../server/message-attachments.mjs';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('attachments-large');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const SIZE = 30 * 1024 * 1024;

test('#870 a 30 MB screen recording dropped on the conversation attaches, and sending it gives the agent the whole file', async ({ page }) => {
  const { rt } = app;
  const t = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title: 'Recording', personaIds: [arrange.persona(rt, 'librarian').id] });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await page.locator('.main .composer textarea').fill('Here’s what happens when I click Send.');
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
  const chip = page.locator('.main .composer .attachments .att', { hasText: 'Screen Recording.mov' });
  await expect(chip, 'the recording attaches').toHaveCount(1);
  await expect(chip, 'and finishes uploading').not.toContainText('uploading', { timeout: 30_000 });
  await expect(page.getByText(/Couldn’t attach/), 'no refusal').toHaveCount(0);
  await page.locator('.main .composer').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.transcript .me-card .attachments', { hasText: 'Screen Recording.mov' }), 'sent with the message').toHaveCount(1);
  const sent = Object.values(rt.store.state.items[t.id] ?? {}).find((it) => it.kind === 'user' && it.attachments?.length);
  const file = sent?.attachments?.[0];
  expect(file, 'the message carries the upload').toMatchObject({ kind: 'file', name: 'Screen Recording.mov', size: SIZE });
  const path = attachmentPath(rt.assets, t.id, file);
  expect(path && statSync(path).size, 'the agent’s path holds the whole file').toBe(SIZE);
});
