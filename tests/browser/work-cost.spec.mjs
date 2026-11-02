// Work’s cost follows what it shows, not the whole ledger (#618). On a seeded conversation of 300 turns, each with a
// reply carrying its turn’s list, a file change, six commands and a read, a change to one entry looks it up once,
// not once per turn list, and full-screen Work draws the newest of its 1,800 commands and the one it opened at.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

test.use({ colorScheme: 'light' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let conv;
const TURNS = 300;
const COMMANDS = 6;

test.beforeAll(async () => {
  app = await startPostbox('work-cost', { demo: false });
  const { rt, store } = app;
  store.emit('project', { id: 'pr_cost', name: 'Cost', folder: app.root });
  const p = rt.createPersona({ handle: 'builder' });
  conv = rt.createThread({ projectId: 'pr_cost', title: 'A long day', personaIds: [p.id] }).id;
  const se = rt.sessionsIn(conv)[0];
  const base = { threadId: conv, sessionId: se.id, handle: se.handle };
  const add = (entry) => store.emit('work.add', { convId: conv, entry: { ...base, at: 1, ...entry } });
  for (let f = 0; f < 30; f++)
    add({
      kind: 'file',
      id: `wf_${f}`,
      path: `${app.root}/src/f${f}.js`,
      rel: `src/f${f}.js`,
      existed: true,
      added: 3,
      deleted: 1,
      handles: [se.handle],
      lastHandle: se.handle,
    });
  for (let t = 0; t < TURNS; t++) {
    const turnId = `tu_${t}`;
    add({ kind: 'turn', id: turnId, turnId, startedAt: 1, status: 'done', ms: 2000, toolCalls: COMMANDS + 2 });
    add({ kind: 'change', id: `wd_${t}`, turnId, fileId: `wf_${t % 30}`, added: 2, deleted: 1 });
    for (let c = 0; c < COMMANDS; c++)
      add({ kind: 'command', id: `wc_${t}_${c}`, turnId, command: `npm test -- part ${c}`, startedAt: 1, state: 'done', exit: 0 });
    add({ kind: 'read', id: `wg_${t}`, turnId, tool: 'Read', what: 'README.md' });
    rt.addItem(conv, {
      kind: 'agent',
      sessionId: se.id,
      personaId: se.personaId,
      handle: se.handle,
      text: `Turn ${t} is done.`,
      status: 'done',
      turnId,
      work: 'Worked',
    });
  }
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const lists = (page) => page.locator(`.transcript[data-thread="${conv}"] .work-list-turn`);

test('#618: a change to one command looks it up once, not once per turn list', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${conv}`);
  await synced(page, app);
  await expect(lists(page)).toHaveCount(TURNS);
  await settled(page);
  // Counts the lookups by id in the conversation’s ledger from here on.
  await page.evaluate(async (c) => {
    const { client } = await import('/app/js/client.mjs');
    const entries = client.state.work[c];
    const find = entries.find;
    /** @type {any} */ (window).__finds = 0;
    entries.find = function (...a) {
      /** @type {any} */ (window).__finds++;
      return find.apply(this, a);
    };
  }, conv);
  const last = `tu_${TURNS - 1}`;
  app.store.emit('work.patch', { convId: conv, id: `wc_${TURNS - 1}_0`, patch: { state: 'failed', exit: 2 } });
  await synced(page, app);
  // The list of the command’s turn still follows it.
  await expect(page.locator(`[id="wl-${last}-wc_${TURNS - 1}_0"]`)).toContainText('exit 2');
  // The store’s own update finds it once; the turn lists don’t look again.
  expect(await page.evaluate(() => /** @type {any} */ (window).__finds)).toBeLessThanOrEqual(1);
});

test('#618: full-screen Work draws 50 of its 1,800 commands, around the one it opened at, and more on asking', async ({ page }) => {
  const at = 'wc_150_3';
  await page.goto(`${app.origin}/#/t/${conv}?work&full=work&at=${at}`);
  await synced(page, app);
  const commands = page.locator('#work-commands details.work-item');
  // The item it opened at is drawn, among the 50 around it, and has focus.
  await expect(page.locator(`[id="wsum-${at}"]`)).toBeFocused();
  await expect(commands).toHaveCount(50);
  // The rest are a button away on each side; focus goes to the first command each drew.
  await page.getByRole('button', { name: /^Show 50 earlier commands · 878 not shown$/ }).click();
  await expect(commands).toHaveCount(100);
  await expect(page.locator('[id="wsum-wc_138_0"]')).toBeFocused();
  await page.getByRole('button', { name: /^Show 50 later commands · 872 not shown$/ }).click();
  await expect(commands).toHaveCount(150);
  await expect(page.locator('[id="wsum-wc_154_4"]')).toBeFocused();

  // Opened at nothing, it draws the newest 50, last as before, and a command that starts now joins them.
  await page.goto(`${app.origin}/#/t/${conv}?work&full=work`);
  await synced(page, app);
  await expect(commands).toHaveCount(50);
  await expect(commands.last()).toContainText(`npm test -- part ${COMMANDS - 1}`);
  app.store.emit('work.add', {
    convId: conv,
    entry: { kind: 'command', id: 'wc_late', turnId: `tu_${TURNS - 1}`, handle: 'builder', command: 'npm run build', startedAt: 2, state: 'running' },
  });
  await synced(page, app);
  await expect(commands).toHaveCount(51);
  await expect(commands.last()).toContainText('npm run build');
  await expect(page.locator('#work-below-commands')).toHaveCount(0);
});
