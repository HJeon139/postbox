// Going to what an agent needs (#285), with real clicks and keys:
// - ⌃J goes to the open conversation's agent first, then the one that has waited longest, and pressing again visits
//   every agent that needs you, a side thread's and a refused step's included.
// - Each jump scrolls the ask into view, focuses it and outlines it, far up a long transcript or in the side panel.
// - Clicking an agent's needs-you ring or row (the rail, the Agents section, the overview, a message, the top bar)
//   goes to that agent's ask. In a room's rail row, a ring goes to its agent and the rest of the row to the oldest.
// - While it needs you, an agent's ⋯ in the Agents section still opens its quick panel; an idle agent's row works as before.
// Moved from tools/checks/needs-nav.mjs (#303).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

const choice = (handle) => ({
  id: `ask-${handle}`,
  type: 'choice',
  version: 1,
  title: `@${handle}: which source first?`,
  fallback: `@${handle}: which source first?`,
  options: [
    { id: 'a', label: 'The papers' },
    { id: 'b', label: 'The notes' },
  ],
});

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** The sessions by handle, the three conversations, and which agent each ask belongs to. */
const S = {};
const T = {};
const handleOfItem = {};

/** Scripted agents: each asks once, on its first turn, a choice, or a refused step for @epsilon. Later turns just reply. */
function scriptAgents() {
  const asked = new Set();
  app.rt.adapters.register({
    name: 'claude-code',
    async folderFor() {
      return app.root;
    },
    async deliver(session, _message, ctx) {
      if (!asked.has(session.handle)) {
        asked.add(session.handle);
        if (session.handle === 'epsilon')
          ctx.denied({ toolUseId: 'tu_eps', tool: 'Bash', input: { command: 'rm -rf build' }, label: 'Run rm -rf build', reason: 'A deny rule.' });
        else if (session.handle !== 'zeta') ctx.tools.show_block({ block: choice(session.handle) });
      }
      ctx.text('Done.');
    },
  });
}

/** Three conversations: Alpha (@alpha, and @beta, who answers @alpha’s wake in a side thread), Room and Refused. */
function conversations() {
  const { rt, store } = app;
  store.emit('project', { id: 'pr_needs', name: 'Needs', folder: app.root });
  const persona = (handle) => rt.createPersona({ handle, backend: 'claude-code', permissionMode: 'auto', tools: [] }).id;
  const [alpha, beta, gamma, delta, epsilon, zeta] = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map(persona);
  T.alpha = rt.createThread({ projectId: 'pr_needs', title: 'Alpha', personaIds: [alpha, beta] });
  T.room = rt.createThread({ projectId: 'pr_needs', title: 'Room', personaIds: [gamma, delta, zeta] });
  T.refused = rt.createThread({ projectId: 'pr_needs', title: 'Refused', personaIds: [epsilon] });
}

/**
 * The asks, oldest first: @alpha, @gamma, @delta, @beta in a side thread of Alpha, then @epsilon’s refused step, each
 * after the clock has moved on, so their order is the order they were made in. Then @zeta speaks once and stays idle.
 */
async function ask() {
  const { rt, store } = app;
  const idle = () => expect.poll(() => rt.turns.size + rt.exiting.size, { message: 'the agents to finish' }).toBe(0);
  const next = async () => {
    await idle();
    const now = Date.now();
    await expect.poll(() => Date.now()).toBeGreaterThan(now);
  };
  const sessionOf = (handle) => Object.values(store.state.sessions).find((x) => x.handle === handle && !x.archived);
  rt.sendMessage(T.alpha.id, { text: '@alpha where do we start?' });
  await next();
  rt.sendMessage(T.room.id, { text: '@gamma where do we start?' });
  await next();
  rt.sendMessage(T.room.id, { text: '@delta and you?' });
  await next();
  rt.agentWake(sessionOf('alpha').id, 'beta', 'Which source should I read first?');
  await next();
  rt.sendMessage(T.refused.id, { text: '@epsilon clean the build.' });
  await next();
  rt.sendMessage(T.room.id, { text: '@zeta anything?' });
  await idle();
  for (const h of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) S[h] = sessionOf(h);
}

test.beforeAll(async () => {
  app = await startPostbox('needs');
  scriptAgents();
  conversations();
  await ask();
  // A long run of @delta’s notes after the asks, so the room's asks are far up its transcript.
  for (let i = 0; i < 30; i++)
    app.rt.addItem(T.room.id, {
      kind: 'agent',
      sessionId: S.delta.id,
      personaId: S.delta.personaId,
      handle: 'delta',
      turnId: 'turn_notes',
      text: `Note ${i + 1}. ${'A long line of reading notes that takes up room. '.repeat(6)}`,
      status: 'done',
    });
  expect(
    ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((h) => S[h].needs?.kind),
    'every agent but @zeta needs you',
  ).toEqual(['block', 'block', 'block', 'block', 'denial']);
  for (const h of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) handleOfItem[S[h].needs.itemId] = h;
});

test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** Opens a place in Postbox and waits for it to have heard everything the server did. */
async function open(page, hash) {
  await page.goto(`${app.origin}/${hash}`);
  await synced(page, app);
  await expect(page.locator('header.topbar')).toBeVisible();
}

/** Where focus is: the agent whose ask it’s in, whether that ask is on screen, and whether it's outlined. */
const landing = (page) =>
  page.evaluate((asks) => {
    const item = document.activeElement?.closest?.('[data-key]');
    const handle = item instanceof HTMLElement ? (asks[item.dataset.key ?? ''] ?? null) : null;
    if (!handle || !item) return { handle: null };
    const b = item.getBoundingClientRect();
    return { handle, onScreen: b.bottom > 0 && b.top < innerHeight && b.height > 0, outlined: item.classList.contains('arrived') };
  }, handleOfItem);

/** Waits for focus to land on that agent’s ask, on screen and outlined. The outline lasts 1.6 s, so it's read often. */
const landsOn = (page, handle) =>
  expect
    .poll(() => landing(page), { message: `focus on @${handle}'s ask, on screen and outlined`, intervals: [50] })
    .toEqual({ handle, onScreen: true, outlined: true });

/** ⌃J, from nowhere in particular, so a press that goes nowhere can't pass for the last one’s landing. */
async function ctrlJ(page) {
  await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
  await page.keyboard.press('Control+j');
}

const ring = (page, scope, h) => page.locator(`${scope} pb-ring[data-session="${S[h].id}"]`);
const agentRow = (page, h) => page.locator('.rail .agent-row').filter({ has: page.locator('.agent-btn', { hasText: `@${h}` }) });
const railRow = (page, t) => page.locator(`.rail a.row[data-thread="${t.id}"]`);
const quickPanel = (page) => page.locator('.backdrop .dialog.quick');

test('the global button counts every agent that needs you, a refused step’s too', async ({ page }) => {
  await open(page, '#/');
  await expect(page.locator('#next-needs')).toContainText(/\b5 need you/);
});

test('⌃J visits every agent that needs you, oldest first, each ask on screen, focused and outlined', async ({ page }) => {
  await open(page, '#/');
  for (const h of ['alpha', 'gamma', 'delta', 'beta', 'epsilon']) {
    await ctrlJ(page);
    await landsOn(page, h);
  }
});

test('⌃J from a conversation whose agent needs you goes to that agent first', async ({ page }) => {
  await open(page, `#/t/${T.room.id}`);
  await ctrlJ(page);
  await landsOn(page, 'gamma');
});

test('a rail row whose agent needs you goes to its ask', async ({ page }) => {
  await open(page, `#/t/${T.refused.id}`);
  await railRow(page, T.alpha).locator('.name').click();
  await landsOn(page, 'alpha');
});

test('a room’s rail row: a ring goes to its agent, the rest of the row to the agent that has waited longest', async ({ page }) => {
  await open(page, `#/t/${T.refused.id}`);
  await railRow(page, T.room).locator(`pb-ring[data-session="${S.delta.id}"]`).click();
  await landsOn(page, 'delta');
  await open(page, `#/t/${T.refused.id}`);
  await railRow(page, T.room).locator('.name').click();
  await landsOn(page, 'gamma');
});

test('a click that opens a new tab or window, on a rail row whose agent needs you, is left to the browser', async ({ page }) => {
  await open(page, `#/t/${T.refused.id}`);
  // A last listener records whether each click was taken, then keeps the browser from opening the tab.
  await page.evaluate(() => {
    window.__taken = [];
    addEventListener('click', (e) => {
      window.__taken.push(e.defaultPrevented);
      e.preventDefault();
    });
  });
  // The platform’s new-tab click (⌘ on macOS, where ⌃-click opens the context menu instead; Ctrl elsewhere), and a
  // Shift-click for a new window.
  for (const key of ['ControlOrMeta', 'Shift'])
    await railRow(page, T.alpha)
      .locator('.name')
      .click({ modifiers: [key] });
  expect(await page.evaluate(() => window.__taken), 'no click was taken to the ask').toEqual([false, false]);
  await expect(page, 'the page stayed where it was').toHaveURL(new RegExp(`#/t/${T.refused.id}$`));
});

test('an agent’s row in the Agents section goes to its ask while it needs you', async ({ page }) => {
  await open(page, `#/t/${T.room.id}`);
  await agentRow(page, 'delta').locator('.agent-btn').click();
  await landsOn(page, 'delta');
  await expect(quickPanel(page), 'no quick panel opened').toHaveCount(0);
});

test('while it needs you, an agent’s ⋯ in the Agents section opens its quick panel', async ({ page }) => {
  await open(page, `#/t/${T.room.id}`);
  await agentRow(page, 'delta').getByRole('button', { name: 'More for @delta' }).click();
  await expect(quickPanel(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(quickPanel(page)).toHaveCount(0);
});

test('an idle agent’s row in the Agents section still opens its quick panel', async ({ page }) => {
  await open(page, `#/t/${T.room.id}`);
  await expect(agentRow(page, 'zeta').getByRole('button', { name: /^More for/ }), 'no ⋯ while idle').toBeHidden();
  await agentRow(page, 'zeta').locator('.agent-btn').click();
  await expect(quickPanel(page)).toBeVisible();
});

test('an overview card’s ring goes to its ask, in the side panel for a side thread’s agent', async ({ page }) => {
  await open(page, '#/');
  await ring(page, '.ov', 'beta').click();
  await landsOn(page, 'beta');
  await expect(page.locator(`.sp-body [data-key="${S.beta.needs.itemId}"]`), '@beta’s ask is in the side panel').toBeVisible();
});

test('the ring beside an agent’s name on a message goes to its ask', async ({ page }) => {
  await open(page, `#/t/${T.room.id}`);
  // @delta’s notes share one sender line, above its ask.
  await page.locator(`#main .who pb-ring[data-session="${S.delta.id}"]`).last().click();
  await landsOn(page, 'delta');
});

test('an agent’s ring in the top bar goes to its ask', async ({ page }) => {
  await open(page, `#/t/${T.room.id}`);
  // Its own button: a folded stack of rings in the top bar holds a second ring for each agent.
  await page.locator(`#top-ring-${S.gamma.id}`).click();
  await landsOn(page, 'gamma');
});

test('where the top bar’s rings fold into a stack, a waiting agent’s ring in it opens the stack’s menu', async ({ page }) => {
  await open(page, `#/t/${T.room.id}`);
  // Folded as fitTopbar (shell.mjs) folds it where the rings don’t fit: this case is about where the click goes.
  await page.locator('header.topbar').evaluate((n) => {
    n.dataset.drop = 'crumb demo rings';
  });
  await page.locator(`#top-ring-stack pb-ring[data-session="${S.gamma.id}"]`).click();
  await expect(page.locator('.menu'), 'the stack’s menu').toBeVisible();
  await expect(page, 'the page stayed where it was').toHaveURL(new RegExp(`#/t/${T.room.id}$`));
});
