// An agent’s “1 open choice” goes to its block when the block is in a side thread of the conversation (#543): the side
// panel opens on that thread, and the block is scrolled into view, focused and outlined, as ⌃J does for a need there.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('open-asks-side');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

test('#543 an agent’s open choice in a side thread: its button opens the side thread and goes to the block', async ({ page }) => {
  const { rt } = app;
  const projectId = /** @type {any} */ (Object.values(rt.store.state.projects)[0]).id;
  const room = rt.createThread({
    projectId,
    title: 'Side asks',
    personaIds: [arrange.persona(rt, 'researcher').id, arrange.persona(rt, 'critic').id],
  });
  const critic = arrange.agentIn(rt, room.id, 'critic');
  // A side thread of the conversation, built as one was before #372, where @critic asked and the person left it open.
  const side = arrange.putThread(rt, {
    id: `th_side_${room.id.slice(-6)}`,
    projectId,
    title: 'researcher ↔ critic',
    kind: 'side',
    parentId: room.id,
    pair: 'critic|researcher',
    woke: 'critic',
  });
  arrange.post(rt, room.id, { kind: 'sidelink', sideThreadId: side.id, from: 'researcher', to: 'critic', count: 1 });
  const ask = arrange.post(rt, side.id, {
    kind: 'block',
    handle: 'critic',
    sessionId: critic.id,
    personaId: critic.personaId,
    valid: true,
    block: {
      id: 'which-first',
      type: 'choice',
      version: 1,
      title: 'Which source first?',
      fallback: 'Which source first?',
      options: [
        { id: 'a', label: 'The papers' },
        { id: 'b', label: 'The notes' },
      ],
    },
  });
  arrange.setSession(rt, critic.id, { state: 'idle', needs: null });

  await page.goto(`${app.origin}/#/t/${room.id}`);
  await synced(page, app);
  await settled(page);
  const button = page.locator(`button[data-open-asks="${critic.id}"]`).first();
  await expect(button).toHaveText('1 open choice');
  await button.click();
  // The side panel opens on the thread the block is in, and the block is the one focused.
  await expect(page).toHaveURL(new RegExp(`side/${side.id}`));
  const block = page.locator(`.sidepanel [data-key="${ask.id}"]`);
  await expect(block).toBeInViewport();
  await expect(block).toHaveClass(/arrived/);
});
