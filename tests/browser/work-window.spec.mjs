// Full-screen Work’s long lists keep their place (#618). They draw 50 at a time. Choosing one agent’s work draws that
// agent’s list again, around the item Work opened at or from its newest, not an empty stretch past its end: on a room
// where @alpha ran 80 commands and @beta 10. And the file Work opened at stays drawn when git’s answer moves flagged
// files above it: on a conversation of 120 files, half of them existing files outside git.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

test.use({ colorScheme: 'light' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let room;
let files;

test.beforeAll(async () => {
  app = await startPostbox('work-window', { demo: false });
  const { rt, store } = app;
  store.emit('project', { id: 'pr_win', name: 'Window', folder: app.root });
  const alpha = rt.createPersona({ handle: 'alpha' });
  const beta = rt.createPersona({ handle: 'beta' });
  room = rt.createThread({ projectId: 'pr_win', title: 'Two agents', personaIds: [alpha.id, beta.id] }).id;
  const add = (entry) => store.emit('work.add', { convId: room, entry: { threadId: room, at: 1, ...entry } });
  const turn = (handle, t, n) => {
    const turnId = `tu_${handle}_${t}`;
    add({ kind: 'turn', id: turnId, turnId, handle, startedAt: 1, status: 'done', ms: 1000, toolCalls: n });
    for (let c = 0; c < n; c++)
      add({ kind: 'command', id: `wc_${handle}_${t}_${c}`, turnId, handle, command: `echo ${handle} ${t} ${c}`, startedAt: 1, state: 'done', exit: 0 });
  };
  for (let t = 0; t < 10; t++) turn('alpha', t, 8);
  for (let t = 0; t < 2; t++) turn('beta', t, 5);

  files = rt.createThread({ projectId: 'pr_win', title: 'Many files', personaIds: [alpha.id] }).id;
  // Newest first: the 60 new files, then the 60 that existed, which git flags once it says it doesn’t follow them.
  for (let f = 0; f < 120; f++) {
    const existed = f >= 60;
    store.emit('work.add', {
      convId: files,
      entry: {
        kind: 'file',
        id: `wf_${f}`,
        path: `${app.root}/src/f${f}.txt`,
        rel: `src/f${f}.txt`,
        existed,
        tracked: null,
        before: { exists: existed, sha256: existed ? 'a' : null },
        after: { exists: true, sha256: `b${f}`, binary: true }, // binary, so its diff needs no copy
        added: 1,
        deleted: 0,
        handles: ['alpha'],
        lastHandle: 'alpha',
        lastAt: 1000 - f,
      },
    });
  }
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const commands = (page) => page.locator('#work-commands details.work-item');
const more = (page) => page.locator('#work-commands .work-more');

test('#618: choosing one agent draws its commands, not a stretch past their end', async ({ page }) => {
  // Opened at a late command of @alpha’s, so the window starts past where @beta’s list ends.
  await page.goto(`${app.origin}/#/t/${room}?work&full=work&at=wc_alpha_8_0`);
  await synced(page, app);
  await expect(page.locator('[id="wsum-wc_alpha_8_0"]')).toBeFocused();
  await expect(commands(page)).toHaveCount(50);

  await page.getByRole('button', { name: '@beta' }).click();
  await expect(commands(page)).toHaveCount(10);
  await expect(commands(page).last()).toContainText('echo beta 1 4');
  await expect(more(page)).toHaveCount(0);

  await page.getByRole('button', { name: '@alpha' }).click();
  await expect(commands(page)).toHaveCount(50);
  await expect(commands(page).last()).toContainText('echo alpha 9 7');
  await expect(page.getByRole('button', { name: /^Show 30 earlier commands · 30 not shown$/ })).toBeVisible();

  // All of them again, around the command it opened at.
  await page.getByRole('button', { name: 'All agents' }).click();
  await expect(commands(page)).toHaveCount(50);
  await expect(page.locator('[id="wsum-wc_alpha_8_0"]')).toBeVisible();
});

test('#618: the file Work opened at stays drawn when git’s answer moves flagged files above it', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${files}?work&full=work&at=wf_29`);
  await synced(page, app);
  // Git has answered: the files that existed are flagged, and sorted first.
  await expect(page.locator('.work-flag-note')).toContainText('60 changes to review');
  await expect(page.locator('#work-files details.work-item')).toHaveCount(50);
  await expect(page.locator('[id="wsum-wf_29"]')).toBeFocused();
});
