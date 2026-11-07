// The agent’s quick panel repaints only for what it shows, not for every item in its conversation (Refs #866). It
// rebuilt itself on each item.add and item.patch in the thread, and keepFocus then focused the rebuilt control, which
// forced a layout of the whole page: 60 of them and 1.17 s in the person’s Firefox profile of v1.37.0, while an agent
// streamed. The one part that reads items, the open-asks button, keeps itself up to date (open-asks.mjs). Chromium
// counts the page’s layouts (the DevTools protocol’s Performance.getMetrics, LayoutCount).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

const BURST = 50;
const ask = { id: 'pick', type: 'choice', version: 1, title: 'Which one?', fallback: 'Which one?', options: [{ id: 'a', label: 'A' }] };

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let agent;
test.beforeAll(async () => {
  app = await startPostbox('agent-panel-cost');
  app.rt.adapters.register({
    name: 'mock',
    async deliver(_session, message, ctx) {
      if (message.kind === 'user') ctx.text('Working on it.');
    },
  });
  agent = app.rt.createPersona({ handle: 'streamer' });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

let n = 0;
/** A conversation with one reply from the agent, and the agent’s quick panel open from its row, its body marked. */
async function panelOpen(page) {
  const { rt } = app;
  const thread = rt.createThread({ projectId: Object.values(rt.s.projects)[0].id, title: `Panel ${++n}`, personaIds: [agent.id] });
  rt.sendMessage(thread.id, { text: 'go' });
  await expect.poll(() => rt.turns.size === 0 && rt.store.items(thread.id).some((i) => i.kind === 'agent')).toBe(true);
  const reply = rt.store.items(thread.id).find((i) => i.kind === 'agent');
  const se = rt.sessionsIn(thread.id)[0];
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  await page.locator('.rail .agent-row .agent-btn').first().click();
  const panel = page.locator('.backdrop .dialog.quick');
  await expect(panel).toBeVisible();
  await settled(page);
  // A node a repaint replaces: the marker goes with it.
  await panel
    .locator('.qp > *')
    .first()
    .evaluate((n) => {
      n.dataset.same = 'yes';
    });
  return { rt, thread, reply, se, panel, tools: rt.toolsFor(se.id) };
}
const kept = (panel) => panel.locator('.qp > [data-same="yes"]');

/** Patches the agent’s reply `count` times, as a streaming turn does, each its own event, then waits for the page. */
async function stream(page, s, count = BURST) {
  for (let i = 0; i < count; i++) s.rt.patchItem(s.thread.id, s.reply.id, { probe: i });
  await synced(page, app);
  await settled(page);
}

async function layoutCount(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return metrics.find((m) => m.name === 'LayoutCount').value;
}

test('#866 the panel doesn’t repaint for items streaming in its conversation, and they cost no layout each', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the layout count comes from Chromium’s DevTools protocol');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const s = await panelOpen(page);
  const focused = await page.evaluate(() => document.activeElement?.closest('.qp') !== null);
  expect(focused, 'focus starts in the panel').toBe(true);
  const before = await layoutCount(cdp);
  await stream(page, s);
  const open = (await layoutCount(cdp)) - before;
  const rebuilt = await kept(s.panel).count();
  // The same stream with the panel closed is the baseline: what the transcript itself costs.
  await page.keyboard.press('Escape');
  await expect(s.panel).toHaveCount(0);
  await settled(page);
  const was = await layoutCount(cdp);
  await stream(page, s);
  const closed = (await layoutCount(cdp)) - was;
  test.info().annotations.push({ type: 'layouts', description: `${BURST} item patches: ${open} with the panel open, ${closed} closed` });
  expect.soft(rebuilt, 'the panel wasn’t rebuilt').toBe(1);
  expect.soft(open, `layouts with the panel open (${open}) against closed (${closed})`).toBeLessThanOrEqual(closed + 5);
});

test('#866 an ask from the agent shows on the panel’s button while it’s open, and goes when it’s answered', async ({ page }) => {
  const s = await panelOpen(page);
  const button = s.panel.locator(`[data-open-asks="${s.se.id}"]`);
  await expect(button).toBeHidden();
  s.tools.show_block({ block: ask });
  await expect(button).toBeVisible();
  await expect(button).toHaveText('1 open choice');
  await expect(kept(s.panel), 'by its own repaint, not the panel’s').toHaveCount(1);
  const item = s.rt.store.items(s.thread.id).find((i) => i.kind === 'block');
  s.rt.act(s.thread.id, item.id, 'choose', { selected: ['a'] }, 1);
  await expect(button).toBeHidden();
});

test('#866 the panel still repaints for its session, and keeps focus on the control in use', async ({ page }) => {
  const s = await panelOpen(page);
  const focusedId = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  s.rt.putSession({ ...s.rt.s.sessions[s.se.id], ctx: 42 });
  await expect(s.panel).toContainText('42% of context used');
  await expect(kept(s.panel), 'a session change repaints').toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'focus on the same control').toBe(focusedId);
});

test('#866 items in another conversation don’t repaint the panel, and a reload of the state does', async ({ page }) => {
  const s = await panelOpen(page);
  const other = s.rt.createThread({ projectId: Object.values(s.rt.s.projects)[0].id, title: `Other ${++n}`, personaIds: [agent.id] });
  s.rt.sendMessage(other.id, { text: 'go' });
  await expect.poll(() => s.rt.turns.size === 0 && s.rt.store.items(other.id).some((i) => i.kind === 'agent')).toBe(true);
  await synced(page, app);
  await expect(kept(s.panel), 'another conversation’s items').toHaveCount(1);
  await page.evaluate(() => import('/app/js/client.mjs').then(({ load }) => load()));
  await synced(page, app);
  await expect(kept(s.panel), 'a reload of the state repaints').toHaveCount(0);
});
