// #1748: an agent shows a form and keeps working in the same turn. On 25 Nov the sidebar said “1 open form” while the
// top bar said “Nothing needs you” for over an hour, until the turn ended. Now the form is the agent's need from when
// it's shown: the top bar counts it at once, the sidebar's open-form button goes (the form is the need), and the ring
// doesn't pulse, since the agent is still working. Answering it mid-turn clears the count. #1868: a tool request
// raised mid-turn counts the same way, and its ring pulses once the turn ends. #1928: once you stop the turn, its form
// stops counting, and stays quiet when you answer another card of the agent's, such as a wake request.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let thread;
let toolThread;
let se;
let stopThread;
/** Lets each agent’s held turn end, by handle. */
const releases = new Map();
const release = (/** @type {string} */ handle) => releases.get(handle)?.();

const form = {
  id: 'mid-window',
  type: 'form',
  version: 1,
  title: 'Which window should I compare?',
  fallback: 'Which window should I compare?',
  fields: [{ id: 'w', label: 'Window', kind: 'text' }],
};

test.beforeAll(async () => {
  app = await startPostbox('needs-mid-turn');
  const { rt, store } = app;
  // @alpha shows the form on its turn, and @beta asks for shell, then each keeps working until the test lets it go.
  // Each agent’s later turns, which the person’s answers start, do nothing.
  arrange.withAdapter(rt, {
    name: 'claude-code',
    async folderFor() {
      return app.root;
    },
    async deliver(session, _message, ctx) {
      if (releases.has(session.handle)) return;
      ctx.text('Looking at the account.');
      if (session.handle === 'beta') ctx.tools.ask_for_tool({ tool: 'shell', why: 'To run the tests.' });
      else ctx.tools.show_block({ block: form });
      ctx.text('Reading the last 90 days while you choose.');
      await new Promise((res) => {
        releases.set(session.handle, res);
      });
      ctx.text('Done.');
    },
  });
  store.emit('project', { id: 'pr_mid', name: 'Mid-turn', folder: app.root });
  const alpha = rt.createPersona({ handle: 'alpha', backend: 'claude-code', permissionMode: 'auto', tools: [] }).id;
  const beta = rt.createPersona({ handle: 'beta', backend: 'claude-code', permissionMode: 'auto', tools: [] }).id;
  thread = rt.createThread({ projectId: 'pr_mid', title: 'Mid-turn form', personaIds: [alpha] });
  toolThread = rt.createThread({ projectId: 'pr_mid', title: 'Mid-turn tool request', personaIds: [beta] });
  // @gamma shows the form as @alpha does; @delta isn't in its conversation, so @gamma's wake of it asks you to add it.
  const gamma = rt.createPersona({ handle: 'gamma', backend: 'claude-code', permissionMode: 'auto', tools: [] }).id;
  rt.createPersona({ handle: 'delta', backend: 'claude-code', permissionMode: 'auto', tools: [] });
  stopThread = rt.createThread({ projectId: 'pr_mid', title: 'Stopped mid-turn form', personaIds: [gamma] });
  se = Object.values(store.state.sessions).find((x) => x.handle === 'alpha');
});
test.afterAll(async () => {
  for (const done of releases.values()) done();
  await app?.stop();
});
failOnPageErrors(test);

test('#1748 a form shown mid-turn is counted at once, without a pulse, and the sidebar stops calling it open', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  const next = page.locator('#next-needs');
  await expect(next, 'nothing needs you before the turn').toBeDisabled();

  app.rt.sendMessage(thread.id, { text: '@alpha which window should we compare?' });
  await expect(page.getByText('Which window should I compare?').first()).toBeVisible();
  await expect.poll(() => arrange.liveTurns(app.rt), { message: 'the turn is still running' }).toBe(1);

  // The top bar counts it while the turn runs on.
  await expect(next, 'the top bar counts the form').toBeEnabled();
  await expect(next).toContainText('Next that needs you');
  // The form is the need, so the agent's row has no “1 open form” button beside it.
  await expect(page.locator(`[data-open-asks="${se.id}"]`).first(), 'no open-form button: the form is the need').toBeHidden();
  // The agent is still working, so its ring doesn't pulse.
  await expect(page.locator('.rail pb-ring[name="alpha"]').first(), 'the ring shows work, not a need').not.toHaveAttribute('state', 'needs');

  // Answering it mid-turn clears the count, with the turn still running.
  await page.getByRole('textbox', { name: 'Window' }).fill('30 days');
  await page.getByRole('button', { name: 'Send form' }).click();
  await expect(next, 'answered: nothing needs you').toBeDisabled();
  expect(arrange.liveTurns(app.rt), 'and the turn runs on').toBe(1);
  release('alpha');
});

test('#1928 a stopped turn’s form stays quiet when you decline the agent’s wake request', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${stopThread.id}`);
  await synced(page, app);
  const next = page.locator('#next-needs');
  const ring = page.locator('.rail pb-ring[name="gamma"]').first();
  const shownForm = page.getByText('Which window should I compare?').first();
  await expect(next, 'nothing needs you before the turn').toBeDisabled();

  // @gamma shows the form mid-turn, then asks to wake @delta, which the conversation doesn't have.
  app.rt.sendMessage(stopThread.id, { text: '@gamma which window should we compare?' });
  await expect(shownForm).toBeVisible();
  const gamma = Object.values(app.store.state.sessions).find((x) => x.handle === 'gamma');
  await expect.poll(() => app.rt.turns.has(gamma.id), { message: 'the turn is still running' }).toBe(true);
  arrange.wake(app.rt, gamma.id, 'delta', 'Check the 30-day numbers.');
  const decline = page.getByRole('button', { name: 'Don’t add delta' });
  await expect(decline, 'the wake request is open').toBeVisible();
  // The form ranks before the wake request, so it is the need, and the top bar counts it.
  await expect.poll(() => app.store.state.sessions[gamma.id].needs?.kind, { message: 'the form is the need' }).toBe('block');
  await expect(next, 'the top bar counts the form').toBeEnabled();

  // You stop the turn, and its stand-in harness exits, as a stopped CLI does.
  await page.getByRole('button', { name: 'Stop gamma’s reply' }).click();
  release('gamma');
  await expect.poll(() => app.rt.turns.has(gamma.id), { message: 'the turn stopped' }).toBe(false);
  // The form no longer counts: the wake request, which waits until answered, is the need now.
  await expect.poll(() => app.store.state.sessions[gamma.id].needs?.kind, { message: 'the wake request is the need' }).toBe('hop');
  await expect(next, 'the top bar counts the wake request').toBeEnabled();
  await expect(shownForm, 'the form is still there to answer').toBeVisible();

  // You decline the wake request: nothing else needs you, and the stopped turn's form stays quiet.
  await decline.click();
  await expect(decline, 'the wake request is answered').toBeHidden();
  await expect(next, 'declined: nothing needs you').toBeDisabled();
  await expect(ring, 'the agent’s ring is in the rail').toBeVisible();
  await expect(ring, 'the ring doesn’t ask for you').not.toHaveAttribute('state', 'needs');
  await expect(shownForm, 'the form is still there to answer').toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Window' })).toBeEditable();
});

test('#1868 a tool request raised mid-turn is counted at once, without a pulse until the turn ends', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${toolThread.id}`);
  await synced(page, app);
  const next = page.locator('#next-needs');
  await expect(next, 'nothing needs you before the turn').toBeDisabled();

  app.rt.sendMessage(toolThread.id, { text: '@beta run the tests' });
  await expect(page.getByRole('button', { name: 'Turn on for beta' })).toBeVisible();
  await expect.poll(() => arrange.liveTurns(app.rt), { message: 'the turn is still running' }).toBe(1);

  // The top bar counts it while the turn runs on, and the ring shows work, not a need.
  await expect(next, 'the top bar counts the tool request').toBeEnabled();
  await expect(next).toContainText('Next that needs you');
  const ring = page.locator('.rail pb-ring[name="beta"]').first();
  await expect(ring, 'the ring shows work, not a need').not.toHaveAttribute('state', 'needs');

  // Once the turn ends, the ring pulses, and the top bar still counts it.
  release('beta');
  await expect.poll(() => arrange.liveTurns(app.rt), { message: 'the turn ended' }).toBe(0);
  await expect(ring, 'the ring pulses once the turn ends').toHaveAttribute('state', 'needs');
  await expect(next).toBeEnabled();
});
