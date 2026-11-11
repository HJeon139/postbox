// The sidebar’s Agents section (#105), driven with real key presses and clicks:
// - the rows in the sidebar, and a topic thread’s line of who is in it (#228);
// - an agent’s name opens its persona sheet, and a change there applies from its next turn (designs/rooms-at-scale.md,
//   “Settings: one scope”); what an agent does is a command to it, `@indexer /compact`, `@indexer /delete`;
// - the subagents at work in the tree, with their step and not their narration (#476), and the working row, from a
//   recorded stream (#73), with End on each, by keyboard (#229);
// - and at 375 px, a top bar with no agent rings whose menu names each agent (#320).
// On the demo’s conversations, with @indexer and @researcher moved to Claude Code and the Agent SDK. Those backends
// are fakes that only record what they’re sent, so no real agent runs. Each test starts from @indexer as the demo
// left it. Moved from tools/check-agents.mjs (#303).

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createStreamMapper } from '../../server/adapters/claude-stream.mjs';
import { failOnPageErrors, PHONE, startPostbox, synced } from './postbox.mjs';

// Light, as the old check ran it; the narrow tests below run in both.
test.use({ colorScheme: 'light' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** What the real backends were sent: a turn each, recorded, never run. */
const turns = [];
/**
 * Recorded streams the next turns replay through the real stream mapper, each as far as its `pause`, then the rest
 * once `go` is called.
 * @type {{ lines: any[], pause: number, go: () => void, wait: Promise<void>, held: boolean }[]}
 */
const replays = [];
/** The demo’s conversations, @indexer’s session in Corpus planning, the topic thread from its reply, and how it began. */
let planning;
let shelf;
let indexer;
let topic;
let initial;

const personaNamed = (handle) => Object.values(app.store.state.personas).find((p) => p.handle === handle);
const threadNamed = (title) => Object.values(app.store.state.threads).find((t) => t.title === title);
const sessionIn = (t, handle) => app.rt.sessionsIn(t.id).find((x) => x.handle === handle);
/**
 * Real backends aren’t registered here (POSTBOX_BACKENDS=mock), so a persona is changed in the store, as an edit in the
 * persona sheet would on a computer with Claude Code.
 */
const real = (handle, patch) => app.store.emit('persona', { ...personaNamed(handle), ...patch, version: (personaNamed(handle).version ?? 1) + 1 });

test.beforeAll(async () => {
  app = await startPostbox('agents');
  const { rt, store } = app;
  for (const name of ['claude-code', 'agent-sdk'])
    rt.adapters.register({
      name,
      async folderFor() {
        return app.root;
      },
      async deliver(session, message, ctx) {
        turns.push({ handle: session.handle, text: message.text, effort: ctx.persona?.effort });
        const r = replays.shift();
        if (!r) return ctx.text('Done.');
        const m = createStreamMapper(ctx);
        for (const e of r.lines.slice(0, r.pause)) m.push(e);
        r.held = true;
        await r.wait;
        for (const e of r.lines.slice(r.pause)) m.push(e);
      },
    });
  planning = threadNamed('Corpus planning');
  shelf = threadNamed('Index the shelf');
  indexer = sessionIn(planning, 'indexer');
  // A topic thread from a reply of @indexer’s, answered there by its one session in the conversation (#228).
  const root = rt.addItem(planning.id, {
    kind: 'agent',
    sessionId: indexer.id,
    personaId: indexer.personaId,
    handle: 'indexer',
    text: 'The shelf has 40 books.',
    status: 'done',
  });
  topic = store.state.threads[rt.startTopic(planning.id, root.id).threadId];
  real('indexer', { backend: 'claude-code', model: 'claude-opus-5-5', effort: 'medium', permissionMode: 'auto' });
  real('researcher', { backend: 'agent-sdk', model: 'claude-opus-5-5', effort: 'high', permissionMode: 'auto' });
  initial = { persona: structuredClone(personaNamed('indexer')) };
});
test.afterAll(async () => {
  for (const r of replays.splice(0)) r.go();
  await app?.stop();
});
test.beforeEach(async () => {
  const { rt, store } = app;
  await expect.poll(() => store.state.sessions[indexer.id].state, { message: 'indexer idle' }).toBe('idle');
  store.emit('persona', { ...initial.persona, version: personaNamed('indexer').version + 1 });
  rt.updateSession(indexer.id, { lastModel: null, lastEffort: null });
});
failOnPageErrors(test);

/** A recorded stream for the next turn to replay, held after the first line `pauseWhen` matches, until `go()`. */
function replayNext(name, pauseWhen) {
  const lines = readFileSync(new URL(`../fixtures/claude-code/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  let go = () => {};
  const wait = new Promise((r) => {
    go = () => r(undefined);
  });
  const r = { lines, pause: lines.findIndex(pauseWhen) + 1, go, wait, held: false };
  replays.push(r);
  return r;
}
/** Held once the Reader has started its own subagent: tests/fixtures/claude-code/subagent-tree.jsonl. */
const NESTED = 'toolu_014cQVtisPCNL6gRibMij5jM';
const atNested = (e) => e.type === 'user' && e.message?.content?.some?.((b) => b.tool_use_id === NESTED);

/** Opens a place in Postbox and waits for it to have heard everything the server did. */
async function open(page, hash) {
  await page.goto(`${app.origin}/${hash}`);
  await synced(page, app);
  await expect(page.locator('header.topbar')).toBeVisible();
}

/** An agent’s row in the sidebar, and its button. */
const agentRow = (page, handle) => page.locator('.rail .agent-row').filter({ has: page.locator('.agent-btn b', { hasText: new RegExp(`^${handle}$`) }) });
const row = (page, handle) => agentRow(page, handle).locator('.agent-btn');
const sheet = (page) => page.getByRole('dialog', { name: 'Settings' });
const composer = (page) => page.locator('#composer-input');
/** Sends a line from the composer, as a person types it. @param {import('@playwright/test').Page} page @param {string} line */
async function send(page, line) {
  await composer(page).focus();
  await page.keyboard.type(line);
  await page.keyboard.press('Escape'); // closes the / menu, if it opened, without picking
  await composer(page).focus();
  await page.keyboard.press('Enter');
}

// ── The sidebar’s Agents section ────────────────────────────────────────────────────────

test('a conversation’s agents are a section in the sidebar, above Direct messages, one row each', async ({ page }) => {
  await open(page, `#/t/${planning.id}`);
  const order = await page.evaluate(() =>
    [...document.querySelectorAll('.rail .label')].map((l) => l.textContent).filter((t) => ['Agents', 'Direct messages', 'Rooms'].includes(t ?? '')),
  );
  expect(order).toEqual(['Agents', 'Direct messages', 'Rooms']);
  const rows = (await page.locator('.rail .agent-row .agent-btn').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  expect(rows.length).toBe(2);
  expect(rows[0]).toBe('indexer · idle Opus 5.5 · medium effort');
  expect(rows[1]).toMatch(/^researcher · idle Opus 5\.5 · \w+ effort$/);
  // The list is named by its heading, and each row says it opens a dialog.
  await expect(page.locator('.rail .agent-rows')).toHaveAccessibleName('Agents');
  await expect(row(page, 'indexer')).toHaveAttribute('aria-haspopup', 'dialog');
});

test('an agent’s name opens its persona sheet, the one place its settings change, and Escape returns focus to it', async ({ page }) => {
  await open(page, `#/t/${planning.id}`);
  await row(page, 'indexer').focus();
  await page.keyboard.press('Enter');
  await expect(sheet(page)).toBeVisible();
  await expect.soft(sheet(page).locator('[role=tab][aria-selected=true]'), 'Settings › Personas').toHaveText('Personas');
  await expect.soft(sheet(page).locator('b', { hasText: /^indexer$/ })).toBeVisible();
  await expect.soft(page.locator('.dialog.quick'), 'no quick panel').toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
  await expect(row(page, 'indexer')).toBeFocused();
});

// One rule for every setting: a change applies from the agent’s next turn, in every conversation it’s in.
test('a change in the sheet applies from the agent’s next turn', async ({ page }) => {
  const ran = (text) => turns.find((x) => x.handle === 'indexer' && x.text === text)?.effort;
  await open(page, `#/t/${planning.id}`);
  app.rt.sendMessage(planning.id, { text: '@indexer first' });
  await expect.poll(() => ran('@indexer first')).toBe('medium');
  await expect.poll(() => app.store.state.sessions[indexer.id].state).toBe('idle');
  await row(page, 'indexer').click();
  await sheet(page).getByLabel('Effort', { exact: true }).selectOption('high');
  await sheet(page).getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => personaNamed('indexer').effort).toBe('high');
  app.rt.sendMessage(planning.id, { text: '@indexer second' });
  await expect.poll(() => ran('@indexer second'), { message: 'its next turn runs at the new effort' }).toBe('high');
  await expect.poll(() => app.store.state.sessions[indexer.id].state).toBe('idle');
});

// ── Actions are commands to the agent ───────────────────────────────────────────────────

test('@agent /compact compacts that agent, and @agent /delete opens its delete confirm; there’s no Archive (#320)', async ({ page }) => {
  await open(page, `#/t/${planning.id}`);
  await send(page, '@indexer /compact');
  await expect.poll(() => turns.some((x) => x.handle === 'indexer' && x.text === '/compact'), { message: 'the /compact turn' }).toBe(true);
  await expect.poll(() => app.store.state.sessions[indexer.id].state).toBe('idle');
  await open(page, `#/t/${shelf.id}`);
  await send(page, '@indexer /delete');
  const ask = page.getByRole('alertdialog', { name: 'Delete indexer’s session?' });
  await expect(ask, 'the confirmation').toBeVisible();
  await expect.soft(ask.getByRole('button', { name: 'Archive' }), 'no Archive').toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(ask).toHaveCount(0);
  expect(app.store.state.sessions[sessionIn(shelf, 'indexer').id], 'Escape didn’t delete it').toBeTruthy();
});

// ── A topic thread ──────────────────────────────────────────────────────────────────────

test('a topic thread is answered by the conversation’s own session; its panel names it in a line, with no list (#228)', async ({ page }) => {
  const { rt, store } = app;
  await open(page, `#/t/${planning.id}/side/${topic.id}`);
  await expect(page.locator('.sp-agents p')).toHaveText('indexer is in this thread.');
  await expect(page.locator('.sidepanel .agent-row, .sidepanel .agents-sec'), 'the thread lists no agents').toHaveCount(0);
  const n = turns.length;
  rt.sendMessage(topic.id, { text: 'Which shelf?' });
  await expect.poll(() => turns.length, { message: 'the reply' }).toBeGreaterThan(n);
  expect(turns.at(-1)).toMatchObject({ handle: 'indexer', text: 'Which shelf?' });
  expect(rt.sessionsIn(topic.id).length, 'the thread has no session of its own').toBe(0);
  await expect.poll(() => store.state.sessions[indexer.id].state, { message: 'the turn to end' }).toBe('idle');
  await synced(page, app);
  await expect(page.locator('.rail .agent-row'), 'a row for each of the conversation’s agents, and no other').toHaveCount(rt.sessionsIn(planning.id).length);
});

// ── Subagents (#73) ─────────────────────────────────────────────────────────────────────

test('a subagent at work is a child in the agent tree, with what it was asked and what it’s doing now, without hover', async ({ page }) => {
  const { rt, store } = app;
  const r = replayNext('subagent-tree', atNested);
  await open(page, `#/t/${planning.id}`);
  try {
    rt.sendMessage(planning.id, { text: '@indexer count the words, with a subagent' });
    await expect.poll(() => r.held, { message: 'the replay to reach its pause' }).toBe(true);
    await synced(page, app);
    await agentRow(page, 'indexer').getByRole('button', { name: 'Show indexer’s 2 subagents' }).click();
    const subs = agentRow(page, 'indexer').locator('.agent-sub.subagent');
    // Opened (#477): the Reader, then its nested subagent; each with what it was asked and its plain step (#476).
    await expect(subs.locator('.sub-head')).toHaveText(['general-purpose · subagent: Reader', 'general-purpose · subagent in the background: Nested checker']);
    await expect(subs.nth(0)).toHaveAttribute('data-depth', '0');
    await expect(subs.nth(1)).toHaveAttribute('data-depth', '1');
    await expect(subs.locator('.sub-now')).toHaveText(['Subagent: Nested checker', 'Nested checker']);
    // On screen, not in a tooltip.
    for (const li of await subs.all()) {
      await expect(li.locator('.sub-now')).toBeVisible();
      await expect(li.locator('[title]')).toHaveCount(0);
    }
    // The working row says it too, attributed.
    await expect(page.locator('.working .work-row')).toContainText(/general-purpose: “The word count came back as 3\.”/);
    r.go();
    // The turn ends: its subagents leave the tree, and its activity list nests each subagent’s steps under it.
    await expect.poll(() => store.state.sessions[indexer.id].state, { message: 'the turn to end' }).toBe('idle');
    await synced(page, app);
    await expect(subs, 'the subagents left the tree').toHaveCount(0);
    const list = page.locator('.turn details.activity').last();
    await list.locator('> summary').click();
    await expect(list.locator(':scope > ul.steps'), 'a folded list’s steps, built when it opens (#1028)').toHaveCount(1);
    const tree = await list.evaluate((reply) => {
      const top = reply.querySelector(':scope > ul.steps');
      const reader = [...(top?.children ?? [])].find((li) => li.querySelector(':scope > .step-text')?.textContent?.includes('Subagent: Reader'));
      return {
        said: [...(reader?.querySelectorAll(':scope > ul.steps > li.said') ?? [])].map(
          (li) => li.querySelector('.step-text > summary, .step-text')?.textContent,
        ),
        nested: !!reader?.querySelector(':scope > ul.steps > li > ul.steps li.said'),
      };
    });
    expect(tree.said[0]).toBe("general-purpose: I'll count the words in the test string with Bash to get the first result.");
    expect(tree.nested, 'the nested subagent’s narration is nested under it').toBe(true);
  } finally {
    r.go();
  }
});

test('End on a subagent’s row, by keyboard, tells its agent and reads “ending”; focus moves to the next row (#229)', async ({ page }) => {
  const { rt, store } = app;
  const r = replayNext('subagent-tree', atNested);
  await open(page, `#/t/${planning.id}`);
  try {
    rt.sendMessage(planning.id, { text: '@indexer count the words, with a subagent' });
    await expect.poll(() => r.held, { message: 'the replay to reach its pause' }).toBe(true);
    await synced(page, app);
    await agentRow(page, 'indexer').getByRole('button', { name: 'Show indexer’s 2 subagents' }).click();
    const subs = agentRow(page, 'indexer').locator('.agent-sub.subagent');
    const ends = subs.locator('.sub-end');
    await expect(ends, 'End on each subagent').toHaveCount(2);
    await expect(ends.nth(0)).toHaveAttribute('aria-label', 'End indexer’s subagent ‘Reader’');
    const first = store.state.sessions[indexer.id].subagents[0].id;
    await ends.nth(0).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => store.state.sessions[indexer.id].endingSubagents ?? [], { message: 'the subagent to be ending' }).toContain(first);
    expect(store.state.sessions[indexer.id].context.some((x) => x.startsWith('[Postbox] URGENT: the person ended your subagent'))).toBe(true);
    await expect(page.getByRole('button', { name: 'End indexer’s subagent ‘Nested checker’' }), 'focus on the next End').toBeFocused();
    await synced(page, app);
    await expect(subs.first().locator('.sub-now'), 'the row reads ending').toHaveText('Ending: indexer was told to stop it');
  } finally {
    r.go();
  }
});

// ── A narrow window ─────────────────────────────────────────────────────────────────────

for (const theme of /** @type {const} */ (['light', 'dark']))
  test.describe(`at 375 px (${theme})`, () => {
    test.use({ viewport: { width: 375, height: 812 }, ...PHONE, colorScheme: theme });

    test(`at 375 px (${theme}), the top bar fits a long title with no agent rings, and its menu names each agent (#320)`, async ({ page }) => {
      app.rt.renameThread(shelf.id, 'Index every book on the shelf, then check the index against the catalog');
      try {
        await open(page, `#/t/${shelf.id}`);
        expect(await page.locator('header.topbar').evaluate((t) => t.scrollWidth <= t.clientWidth), 'the top bar fits').toBe(true);
        await expect(page.locator('header.topbar pb-ring'), 'the top bar has no agent rings').toHaveCount(0);
        // Where the sidebar is hidden, the conversation’s menu names its agents, each leading to its persona.
        await page.locator('header.topbar #conversation-actions').click();
        await expect(page.locator('.menu button.mi', { hasText: 'indexer' }), 'the menu names indexer').toBeVisible();
      } finally {
        app.rt.renameThread(shelf.id, 'Index the shelf');
      }
    });
  });
