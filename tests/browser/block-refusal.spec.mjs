// #1319: an agent’s malformed show_block leaves nothing in the conversation. Before, it posted an item showing the
// fallback text and the raw block, and the agent’s retry under a new id added a second card beside it.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let thread;
/** What each show_block call answered, in order. @type {{ ok: boolean, message: string }[]} */
const replies = [];

test.beforeAll(async () => {
  app = await startPostbox('block-refusal');
  arrange.withAdapter(app.rt, {
    name: 'mock',
    async deliver(_session, _message, ctx) {
      // As the UAT streams show it: a form whose select options are strings, with no fallback, then a retry under a
      // new id once it’s fixed.
      const fields = [{ id: 'region', label: 'Region', kind: 'select', options: ['US East', 'EU West'] }];
      replies.push(ctx.tools.show_block({ block: { id: 'deploy-1', type: 'form', version: 1, title: 'Deploy', fields } }));
      const options = [
        { id: 'us-east', label: 'US East' },
        { id: 'eu-west', label: 'EU West' },
      ];
      const fixed = { id: 'deploy-2', type: 'form', version: 1, title: 'Deploy', fallback: 'Which region?', fields: [{ ...fields[0], options }] };
      replies.push(ctx.tools.show_block({ block: fixed }));
      ctx.text('Asked where to deploy.');
    },
  });
  const persona = app.rt.createPersona({ handle: 'worker' });
  thread = app.rt.createThread({ projectId: Object.values(app.store.state.projects)[0].id, title: 'Refused block', personaIds: [persona.id] });
});

test.afterAll(async () => {
  await app?.stop();
});

failOnPageErrors(test);

test('#1319 a malformed show_block leaves no card, and only the fixed block shows', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  app.rt.sendMessage(thread.id, { text: 'Where should this deploy?' });
  await expect.poll(() => arrange.liveTurns(app.rt), { message: 'the turn to finish' }).toBe(0);
  await synced(page, app);

  expect(replies.map((r) => r.ok)).toEqual([false, true]);
  expect(replies[0].message).toMatch(/^The block wasn’t shown: fallback is required\./);
  const blocks = app.store.items(thread.id).filter((it) => it.kind === 'block');
  expect(
    blocks.map((it) => it.block?.id ?? it.raw?.id),
    'one item: the fixed block',
  ).toEqual(['deploy-2']);
  await expect(page.getByRole('combobox', { name: 'Region' }), 'the fixed form shows').toBeVisible();
  await expect(page.locator('details.raw'), 'no raw block').toHaveCount(0);
  await expect(page.getByText('Show the raw block'), 'no broken card').toHaveCount(0);
});
