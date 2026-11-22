// #518: the person approves a review, the agent reads the approval and revises the draft, and the block asks again.
// Before, the approval vanished: the block showed only “Changes since you looked”, with Approve back, and nothing said
// whether the approval counted. Now the revised block keeps a receipt of what they answered, for which revision and
// when, and says this revision needs its own answer. Answering it clears the receipt. At 375 and 1280 px.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

const DRAFT = {
  id: 'notes',
  type: 'review',
  version: 1,
  title: 'Release notes',
  fallback: 'Review the release notes',
  format: 'markdown',
  content: '# Release notes\n\nFaster search.',
};

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('review-answer-receipt');
  // The agent’s turn takes the answer and ends at once, so the answer is read, and an update can reopen the block.
  arrange.withAdapter(app.rt, { name: 'mock', async deliver() {} });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

for (const width of [375, 1280])
  test(`#518 a review revised after the person approved it says what they approved, and that this revision needs its own answer (${width} px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { rt, store } = app;
    const t = rt.createThread({
      projectId: Object.values(store.state.projects)[0].id,
      title: `Receipt ${width}`,
      personaIds: [arrange.persona(rt, 'researcher').id],
    });
    const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
    tools.show_block({ block: DRAFT });
    const item = store.items(t.id).find((i) => i.kind === 'block' && i.block.id === 'notes');
    await page.goto(`${app.origin}/#/t/${t.id}`);
    await synced(page, app);
    const block = page.locator(`#main [data-key="${item.id}"]`);
    const approve = async (by) => {
      const radio = block.getByRole('radio', { name: 'Approve', exact: true });
      if (by === 'pointer') await radio.click();
      else {
        await radio.focus();
        await page.keyboard.press('Space');
      }
      await expect(radio).toHaveAttribute('aria-checked', 'true');
      await block.getByRole('button', { name: 'Submit review', exact: true }).click();
    };
    await approve('pointer');
    await expect.poll(() => store.item(t.id, item.id).answer?.read, { message: 'the agent read the approval' }).toBe(true);
    const at = store.item(t.id, item.id).answer.at;
    const said = tools.update_block({ block: { ...DRAFT, content: `${DRAFT.content}\n\nA new export button.` } });
    expect(said.ok, said.message).toBe(true);
    await synced(page, app);
    const receipt = block.locator('.rv-receipt');
    const time = await page.evaluate(async (ms) => (await import('/app/js/dom.mjs')).timeOf(ms), at);
    await expect(receipt).toHaveText(`You approved revision 1 at ${time}. The agent revised it since: answer revision 2.`);
    await expect(receipt, 'it reports, and asks nothing').toHaveAttribute('role', 'status');
    await expect(block.getByRole('button', { name: 'Submit review', exact: true }), 'revision 2 takes its own answer').toBeEnabled();
    // By keyboard: right after the revised block moves to the newest point, a pointer’s click there can land on the
    // verdict beside Approve (1 run in 4 with no stream lag, none with 300 ms). That’s the move’s, filed on its own.
    await approve('keyboard');
    await expect(receipt, 'answering revision 2 clears the receipt').toHaveCount(0);
  });

test('#518 a receipt whose saved verdict is a name every object inherits says “answered”, not what it inherits', async ({ page }) => {
  const { rt, store } = app;
  const t = rt.createThread({
    projectId: Object.values(store.state.projects)[0].id,
    title: 'Receipt inherited',
    personaIds: [arrange.persona(rt, 'researcher').id],
  });
  const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
  tools.show_block({ block: { ...DRAFT, id: 'inherited' } });
  const item = store.items(t.id).find((i) => i.kind === 'block' && i.block.id === 'inherited');
  const at = Date.now();
  rt.threads.patchItem(t.id, item.id, { revision: 2, priorAnswer: { action: 'submit', verdict: 'constructor', revision: 1, at } });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const time = await page.evaluate(async (ms) => (await import('/app/js/dom.mjs')).timeOf(ms), at);
  await expect(page.locator(`#main [data-key="${item.id}"] .rv-receipt`)).toHaveText(
    `You answered revision 1 at ${time}. The agent revised it since: answer revision 2.`,
  );
});
