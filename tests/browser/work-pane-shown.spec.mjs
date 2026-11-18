// The Work pane lists the apps and reviews the agents showed in the conversation (#1503), newest first: an app once, at its
// latest version, however often it was updated, and each row leads back to it in the conversation. Other blocks (a
// question, a chart) aren’t listed: they’re read where they are.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

let app;
let conv;
/** @type {Record<string, any>} */
const items = {};

test.beforeAll(async () => {
  app = await startPostbox('work-pane-shown');
  const { rt } = app;
  conv = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title: 'Shown', personaIds: [arrange.persona(rt, 'librarian').id] });
  const se = arrange.agentIn(rt, conv.id);
  const tools = rt.toolsFor(se.id);
  tools.show_app({ id: 'budget', title: 'Budget planner', code: '<p>Budget</p>', permissions: [] });
  for (const block of [
    { id: 'readme', type: 'review', version: 1, fallback: 'The README.', title: 'README draft', format: 'markdown', content: '# README' },
    { id: 'go', type: 'confirm', version: 1, fallback: 'Go?', title: 'Ship it?', statement: 'Ship it?', confirmLabel: 'Ship' },
  ]) {
    const said = await tools.show_block({ block });
    if (!said.ok) throw new Error(said.message);
  }
  for (const it of app.store.items(conv.id)) if (it.kind === 'block') items[it.block.id] = it;
  const turn = { kind: 'turn', handle: se.handle, startedAt: Date.now(), status: 'done' };
  arrange.addWork(rt, conv.id, { ...turn, id: 'wt_s' });
  const shown = (id, at, what, type, title, version) =>
    arrange.addWork(rt, conv.id, {
      id,
      kind: 'publish',
      turnId: 'wt_s',
      handle: se.handle,
      at,
      threadId: conv.id,
      itemId: items[type === 'app' ? 'budget' : what].id,
      what: type === 'app' ? 'app' : 'block',
      type,
      blockId: what,
      title,
      version,
    });
  shown('wu_a1', 1, 'budget', 'app', 'Budget planner', 1);
  shown('wu_r', 2, 'readme', 'review', 'README draft', null);
  shown('wu_c', 3, 'go', 'confirm', 'Ship it?', null);
  shown('wu_a2', 4, 'budget', 'app', 'Budget planner', 2);
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('the pane lists the apps and reviews shown, newest first, an app once at its latest version, and leads back to each', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${conv.id}?work`);
  await synced(page, app);
  const rows = page.locator('#wc-shown-h').locator('..').locator('.wc-row');
  await expect(rows, 'the app updated last comes first; the confirm isn’t listed').toHaveText([/Budget planner.*app v2/, /README draft.*review/]);
  await rows.nth(1).click();
  await expect(page.locator(`.transcript [data-key="${items.readme.id}"]`)).toBeFocused();
});
