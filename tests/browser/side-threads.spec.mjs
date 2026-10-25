// Side threads as the person sees them (#121, #110):
// - an agent woken into a side thread shows in its conversation (its agent tree, the side-thread line and the
//   conversation’s row) with where it is and who woke it;
// - a wake while it’s busy waits in the side thread’s queue, with no fork (#228);
// - one waiting on a permission prompt counts in the tab title, and ⌃J opens its card;
// - /stop in the conversation reaches the side thread, not a topic thread;
// - a wake for one outside the conversation brings a card, and Add joins it (#228);
// - Copy link and the composer’s # link a thread, whose id the agent then gets; the Threads page lists side threads
//   (#124); Send to conversation and bring_to_conversation (#128); a failed turn’s line, with Retry (#151);
// - and at 375 px the side-thread line fits.
// Each test has a room of its own (tests/browser/side-threads.mjs). Moved from tools/check-side-threads.mjs (#303).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';
import { heldBackend, sideRoom } from './side-threads.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {ReturnType<typeof heldBackend>} */
let held;
test.beforeAll(async () => {
  app = await startPostbox('side-threads');
  held = heldBackend(app);
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

/** A room of its own, stopped at the test’s end, so nothing it left running reaches the next test. */
const rooms = [];
test.afterEach(() => {
  for (const r of rooms.splice(0)) r.stop();
});
function room(title) {
  const r = sideRoom(app, title);
  rooms.push(r);
  return r;
}
/** @researcher answers a wake from @indexer in a new side thread, and both finish. Returns the side thread. */
async function withSide(r) {
  held.scripts.set(r.researcher.id, (ctx) => ctx.text('The 1908 edition drops two chapters.'));
  held.scripts.set(r.indexer.id, (ctx) => ctx.text('Noted.'));
  r.wake(r.indexer.id, 'researcher', 'Which editions differ?');
  await r.idle();
  return r.sideOf();
}

async function open(page, hash) {
  await page.goto(`${app.origin}/${hash}`);
  await synced(page, app);
  await expect(page.locator('header.topbar')).toBeVisible();
}
/** An agent’s row in the sidebar, the li around its button. */
const row = (page, handle) => page.locator('.rail .agent-row').filter({ has: page.locator('.agent-btn b', { hasText: new RegExp(`^@${handle}$`) }) });
const words = async (locator) => (await locator.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
const sideLine = (page) => page.locator('#main .pill', { hasText: 'asked' });

test('an agent woken into a side thread works in its own session, and the conversation shows it and where; another wake waits its turn', async ({ page }) => {
  const { store } = app;
  const r = room('Woken');
  await open(page, `#/t/${r.room.id}`);
  r.wake(r.indexer.id, 'researcher', 'Check the editions on the shelf.');
  await expect.poll(() => r.busy(r.researcher.id), { message: '@researcher’s turn' }).toBe(true);
  const side = r.sideOf();
  expect(Object.values(store.state.sessions).filter((x) => x.handle === 'researcher' && x.threadId === r.room.id).length).toBe(1);
  expect(held.turns.at(-1), 'the wake went to its own session, in the side thread').toMatchObject({ sessionId: r.researcher.id, thread: side.id });
  // The agent tree: under @researcher, one line with its state and who it’s with, and a Stop; the thread and who woke it
  // are on hover and in the link’s name.
  await expect.poll(() => words(row(page, 'researcher').locator('.agent-sub'))).toEqual(['Calling tools with @indexer Stop']);
  const link = row(page, 'researcher').locator('.agent-sub a');
  await expect(link).toHaveAttribute('href', `#/t/${r.room.id}/side/${side.id}`);
  await expect(link).toHaveAttribute('title', `In the side thread “${side.title}”, woken by @indexer`);
  await expect(link).toHaveAttribute('aria-label', `Calling tools with @indexer, in the side thread “${side.title}”, woken by @indexer`);
  // Its words show whole, wrapped if need be: none of it is only in the tooltip.
  expect(await link.locator('.name').evaluate((n) => n.scrollWidth <= n.clientWidth && n.scrollHeight <= n.clientHeight + 1), 'the entry’s text whole').toBe(
    true,
  );
  // The side-thread line, with the ring and state word, and the conversation’s row in the sidebar.
  await expect(sideLine(page)).toContainText(/@indexer asked @researcher · @researcher is calling tools · 1 message · Open/);
  await expect(sideLine(page).locator('pb-ring')).toHaveCount(1);
  await expect(page.locator(`.rail a.row[data-thread="${r.room.id}"]`)).toContainText('calling tools in a side thread');
  // Another wake there while it works waits for its turn: no fork, no second @researcher at the same work.
  held.scripts.set(r.researcher.id, (ctx) => ctx.text('Dates: 1999 and 2004.'));
  r.wake(r.indexer.id, 'researcher', 'And the dates?');
  const here = (x) => x.threadId === r.room.id || store.state.threads[x.threadId]?.parentId === r.room.id;
  expect(Object.values(store.state.sessions).filter((x) => x.handle === 'researcher' && here(x)).length).toBe(1);
  expect(r.sideOf().queue.length).toBe(1);
  held.release(r.researcher.id);
  await expect.poll(() => held.turns.some((t) => t.sessionId === r.researcher.id && t.text === 'And the dates?'), { message: 'the queued wake' }).toBe(true);
});

test('a wake while that session is busy in the conversation waits for its turn: no fork, and no second entry (#228)', async ({ page }) => {
  const { rt, store } = app;
  const r = room('Busy');
  const side = await withSide(r);
  rt.sendMessage(r.room.id, { text: '@researcher start the long job' });
  await expect
    .poll(() => r.busy(r.researcher.id) && !store.state.sessions[r.researcher.id].sideTurn, { message: '@researcher at work in the conversation' })
    .toBe(true);
  const said = r.wake(r.indexer.id, 'researcher', 'One question meanwhile.');
  expect(said.message).toMatch(/it’s busy, so it answers when its current turn ends/);
  expect(Object.values(store.state.sessions).filter((x) => x.forkOf?.sessionId === r.researcher.id).length, 'no fork answered').toBe(0);
  // It waits in the side thread’s queue, as the agent’s message.
  await open(page, `#/t/${r.room.id}/side/${side.id}`);
  const queued = page.locator('.sidepanel .queued');
  await expect(queued).toContainText('@indexer’s message · waits for @researcher to finish');
  await expect(queued.getByRole('button', { name: 'Edit', exact: true }), 'a wake can’t be edited').toHaveCount(0);
  await settled(page);
  await expect(row(page, 'researcher').locator('.agent-sub'), 'its row has no entry of its own').toHaveCount(0);
  await expect(row(page, 'researcher').locator('.agent-btn')).toContainText('calling tools');
});

test('a side-thread agent waiting on a permission prompt counts in the tab title, and ⌃J opens the side thread at its card', async ({ page }) => {
  const { rt, store } = app;
  const r = room('Asks');
  const side = await withSide(r);
  held.scripts.set(r.researcher.id, (ctx) => ctx.askPermission({ tool: 'Bash', summary: 'run the indexer' }));
  r.wake(r.indexer.id, 'researcher', 'Index it.');
  await expect.poll(() => store.state.sessions[r.researcher.id].needs?.kind, { message: 'the permission prompt' }).toBe('permission');
  const card = store.state.sessions[r.researcher.id].needs.itemId;
  expect(store.item(side.id, card), 'the card is in the side thread').toBeTruthy();
  await open(page, `#/t/${r.room.id}`);
  await expect(page, 'the tab title’s count').toHaveTitle(/^\(1\) /);
  await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
  await page.keyboard.press('Control+j');
  await expect(page).toHaveURL(new RegExp(`#/t/${r.room.id}/side/${side.id}$`));
  await expect.poll(() => page.evaluate((k) => !!document.activeElement?.closest(`[data-key="${k}"]`), card), { message: 'focus on the card' }).toBe(true);
  rt.act(side.id, card, 'allow');
  await expect.poll(() => store.state.sessions[r.researcher.id].needs, { message: 'the answer' }).toBe(null);
});

test('/stop in the conversation stops its agents in side threads, and not a topic thread’s', async ({ page }) => {
  const { rt, store } = app;
  const r = room('Stop');
  r.wake(r.indexer.id, 'researcher', 'One more pass.');
  await expect
    .poll(() => r.busy(r.researcher.id) && !!store.state.sessions[r.researcher.id].sideTurn, { message: '@researcher at work in the side thread' })
    .toBe(true);
  // A topic thread off the conversation has a turn running: its agent answers there from its one session (#228).
  const root = rt.addItem(r.room.id, {
    kind: 'agent',
    sessionId: r.indexer.id,
    personaId: r.indexer.personaId,
    handle: 'indexer',
    text: 'A side topic.',
    status: 'done',
  });
  const topic = rt.startTopic(r.room.id, root.id).threadId;
  rt.sendMessage(topic, { text: 'Go on here.' });
  await expect.poll(() => r.busy(r.indexer.id), { message: 'the topic thread’s turn' }).toBe(true);
  await open(page, `#/t/${r.room.id}`);
  await page.locator('#composer-input').focus();
  await page.keyboard.insertText('/stop');
  await page.keyboard.press('Enter');
  await expect.poll(() => r.busy(r.researcher.id), { message: 'the side thread’s session to stop' }).toBe(false);
  expect(r.busy(r.indexer.id), 'Stop didn’t reach the topic thread').toBe(true);
});

test('the composer’s # links a side thread, and the agent that gets the message has its id and title', async ({ page }) => {
  const r = room('Link');
  const side = await withSide(r);
  await open(page, `#/t/${r.room.id}`);
  await page.locator('#composer-input').focus();
  await page.keyboard.insertText('#');
  await expect(page.locator('#mention-list')).toHaveAttribute('aria-label', 'Threads');
  await expect(page.locator('#mention-list')).toContainText(/Link a thread[\s\S]*@indexer ↔ @researcher/i);
  await page.keyboard.insertText('indexer');
  await page.keyboard.press('Enter');
  await expect(page.locator('#composer-input')).toHaveValue(`[@indexer ↔ @researcher](${app.origin}/#/t/${r.room.id}/side/${side.id}) `);
  held.scripts.set(r.indexer.id, (ctx) => ctx.text('Read it.'));
  await page.keyboard.insertText('@indexer read this');
  await page.keyboard.press('Enter');
  await expect.poll(() => held.turns.some((t) => t.sessionId === r.indexer.id && t.text.includes('read this')), { message: '@indexer’s turn' }).toBe(true);
  const got = held.turns.findLast((t) => t.sessionId === r.indexer.id);
  expect(
    got?.context.some((c) => c.includes(`side thread “${side.title}” (thread ${side.id})`) && c.includes('read_conversation')),
    'the message carried the thread',
  ).toBe(true);
});

test('a side thread has Copy link, which gives its whole address', async ({ page, context }) => {
  const r = room('Copy');
  const side = await withSide(r);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.origin });
  await open(page, `#/t/${r.room.id}/side/${side.id}`);
  const button = page.locator('.sidepanel').getByRole('button', { name: 'Copy link to this side thread' });
  await expect(button).toHaveText('Copy link');
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(button).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${app.origin}/#/t/${r.room.id}/side/${side.id}`);
});

test('an agent that wakes one from outside the conversation brings a card; Add joins it with a note on its row (#228)', async ({ page }) => {
  const { rt, store } = app;
  const r = room('Outside');
  await open(page, `#/t/${r.room.id}`);
  const before = Object.keys(store.state.sessions).length;
  expect(r.wake(r.indexer.id, 'critic', 'Read the schema, please.').waiting).toBe(true);
  expect(Object.keys(store.state.sessions).length, 'the wake made no session').toBe(before);
  const card = store.items(r.room.id).find((x) => x.kind === 'hop' && x.join && x.status === 'open');
  const node = page.locator(`#main [data-key="${card.id}"]`);
  await expect(node).toContainText('Add @critic to this conversation?');
  await node.getByRole('button', { name: 'Add @critic', exact: true }).click();
  await expect.poll(() => !!r.sessionIn('critic'), { message: '@critic to join' }).toBe(true);
  await expect(row(page, 'critic').locator('.agent-btn'), 'the row’s note').toContainText('Joined when @indexer woke it');
  // The agents the person added say nothing of the kind.
  await expect(row(page, 'indexer')).not.toContainText('Joined when');
  // The mock @critic’s reply can ask something, which would count as needing you after this test.
  await expect.poll(() => rt.turns.has(r.sessionIn('critic').id), { message: '@critic’s turn to end' }).toBe(false);
  rt.archive(r.sessionIn('critic').id);
});

test('the Threads page lists side threads beside topic threads, with their pair, state, count and last activity (#124)', async ({ page }) => {
  const { rt, store } = app;
  const r = room('Listed');
  const side = await withSide(r);
  const root = rt.addItem(r.room.id, {
    kind: 'agent',
    sessionId: r.indexer.id,
    personaId: r.indexer.personaId,
    handle: 'indexer',
    text: 'A topic.',
    status: 'done',
  });
  rt.startTopic(r.room.id, root.id);
  const link = store.items(r.room.id).find((x) => x.kind === 'sidelink' && x.sideThreadId === side.id);
  await open(page, `#/p/${r.room.projectId}/threads`);
  const card = page.locator(`.thread-list li[data-kind="side"]`).filter({ has: page.locator(`a[href="#/t/${r.room.id}/side/${side.id}"]`) });
  expect((await words(card))[0]).toMatch(new RegExp(`^${side.title} Side thread · in Listed · ${link.count} messages · (idle|@\\w+ [a-z ]+) · `));
  // A topic thread says which kind it is too.
  await expect(page.locator('.thread-list li[data-kind="topic"]', { hasText: /Topic thread · in / }).first()).toBeVisible();
});

test('a side-thread message goes to the conversation by Send to conversation, or by an agent the person asked (#128)', async ({ page }) => {
  const { rt, store } = app;
  const r = room('Shared');
  const side = await withSide(r);
  // The person asks an agent in the side thread, and it posts it with bring_to_conversation.
  held.scripts.set(r.researcher.id, (ctx) => {
    ctx.tools.bring_to_conversation({ text: 'The editions, for the main chat.' });
    ctx.text('Posted it in the conversation.');
  });
  rt.sendMessage(side.id, { text: '@researcher post the editions in the main chat' });
  await expect.poll(() => store.items(r.room.id).some((x) => x.kind === 'shared' && x.agent), { message: 'the agent’s post' }).toBe(true);
  await r.idle();
  const reply = store.items(side.id).findLast((x) => x.kind === 'agent' && x.handle === 'researcher' && x.text && !x.sharedAt);
  await open(page, `#/t/${r.room.id}/side/${side.id}`);
  await page.locator(`.sidepanel [data-key="${reply.id}"]`).getByRole('button', { name: 'Send to conversation' }).click();
  await expect
    .poll(() => store.items(r.room.id).some((x) => x.kind === 'shared' && !x.agent && x.text === reply.text), { message: 'the reply in the conversation' })
    .toBe(true);
  await synced(page, app);
  await expect(page.locator(`.sidepanel [data-key="${reply.id}"]`)).toContainText('Sent to the conversation');
  const cards = await words(page.locator('#main .shared-head'));
  expect(cards).toContain(`From the thread “${side.title}” · shared by @researcher in a turn you started Open thread`);
  expect(cards).toContain(`From the thread “${side.title}” · @researcher Open thread`);
});

test('a failed side-thread turn shows on its line with Retry, and the line’s Open goes to its card (#151)', async ({ page }) => {
  const { store } = app;
  const r = room('Failed');
  const side = await withSide(r);
  held.scripts.set(r.researcher.id, async () => {
    throw new Error('API 500');
  });
  r.wake(r.indexer.id, 'researcher', 'Review the plan.');
  await expect.poll(() => store.state.sessions[r.researcher.id].state, { message: 'the failed turn' }).toBe('failed');
  const card = store.state.sessions[r.researcher.id].needs;
  expect(card.threadId).toBe(side.id);
  await open(page, `#/t/${r.room.id}`);
  const line = page.locator('#main [data-side-sig]').filter({ has: page.locator('.pill', { hasText: '@researcher failed' }) });
  await expect(line.getByRole('button')).toHaveText('Retry');
  // It counts as needing you, in the tab title.
  await expect(page).toHaveTitle(/^\(\d+\) /);
  // Open goes to the side thread, at the card, with its Retry focused.
  await line.locator('.pill').click();
  await expect
    .poll(() => page.evaluate((k) => !!document.activeElement?.closest(`.sidepanel [data-key="${k}"]`), card.itemId), { message: 'focus on the failed card' })
    .toBe(true);
  // Retry on the line answers the wake again.
  await open(page, `#/t/${r.room.id}`);
  const before = held.turns.length;
  await line.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => held.turns.length > before && r.busy(r.researcher.id), { message: 'the retried turn' }).toBe(true);
  expect(held.turns.at(-1)).toMatchObject({ sessionId: r.researcher.id, thread: side.id, text: 'Review the plan.' });
});

test.describe('at 375 px', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test('at 375 px, the side-thread line with its agent’s state fits without scrolling sideways', async ({ page }) => {
    const r = room('Narrow');
    r.wake(r.indexer.id, 'researcher', 'Last look.');
    await expect.poll(() => r.busy(r.researcher.id), { message: '@researcher’s turn' }).toBe(true);
    await open(page, `#/t/${r.room.id}`);
    await expect(page.locator('#main .pill', { hasText: 'is calling tools' }), 'the state on the line').toBeVisible();
    await settled(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the page doesn’t scroll sideways').toBe(true);
  });
});
