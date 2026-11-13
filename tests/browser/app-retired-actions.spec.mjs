// #973: under a retired app’s one line, its reactions and its thread link line up with the message column, as they do
// under every other message. The app’s item is drawn as wide as the transcript, for its frame, and a retired app’s line
// is in the column, so its actions bar sat at the transcript’s left edge, about 350 px left of the line at 1280 px.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

const APP = '<main style="padding:12px"><p>The lab</p></main>';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('app-retired-actions');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

let n = 0;
/** A conversation with an app that has a reaction and a thread, and a reply from its agent after it. */
async function seeded(page, width) {
  await page.setViewportSize({ width, height: 900 });
  const { rt } = app;
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const t = rt.createThread({ projectId, title: `Retired actions ${++n}`, personaIds: [arrange.persona(rt, 'researcher').id] });
  const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
  const id = `lab${n}`;
  tools.show_app({ id, title: 'Practice lab', code: APP });
  const itemId = rt.store.state.apps[id].itemId;
  arrange.react(rt, t.id, itemId, '👍');
  rt.startTopic(t.id, itemId);
  tools.show_block({ block: { id: `note${n}`, type: 'card', version: 1, title: 'A note', fallback: 'A note', body: 'Something after the app.' } });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const item = page.locator(`.transcript > [data-key="${itemId}"]`);
  await expect(item.locator('.msg-actions a.replies')).toBeVisible();
  return { tools, id, item, page };
}

const left = (loc) => loc.evaluate((n) => Math.round(n.getBoundingClientRect().left));

for (const width of [1280, 375]) {
  test(`#973 a retired app’s reactions and thread link line up with its line, at ${width}`, async ({ page }) => {
    const s = await seeded(page, width);
    s.tools.retire_app({ id: s.id, reason: 'Done with it.' });
    await synced(page, app);
    const line = s.item.locator('.app-retired');
    await expect(line).toBeVisible();
    const column = await left(line);
    const note = await left(page.locator('.transcript .col.turn').last());
    expect(column, 'the retired line is in the message column').toBe(note);
    expect.soft(await left(s.item.locator('.react-row')), 'the reactions').toBe(column);
    expect.soft(await left(s.item.locator('a.replies')), 'the thread link, after the reactions').toBeGreaterThan(column);
    const bar = await s.item.locator('.msg-actions').evaluate((b) => b.getBoundingClientRect().right);
    const lineRight = await line.evaluate((l) => l.getBoundingClientRect().right);
    expect.soft(Math.round(bar), 'the bar ends where the column does').toBe(Math.round(lineRight));
  });
}

test('#973 control: a live app’s actions still start at its frame’s left edge', async ({ page }) => {
  const s = await seeded(page, 1280);
  const frame = await left(s.item.locator('.appframe'));
  expect(await left(s.item.locator('.react-row'))).toBe(frame);
});
