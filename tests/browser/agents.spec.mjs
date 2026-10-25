// The sidebar’s Agents section and each agent’s quick panel (#105), driven with real key presses and clicks:
// - the rows in the sidebar, and a topic thread’s line of who is in it (#228);
// - changing the model, effort, permission mode and shell in two clicks, and the scope each control says;
// - the links, Stop, Compact and Delete session;
// - the subagents at work in the tree and the working row, from a recorded stream (#73), with End on each, by keyboard
//   (#229);
// - and at 375 px, a top bar with no agent rings whose menu names each agent (#320).
// On the demo’s conversations, with @indexer and @researcher moved to Claude Code and the Agent SDK. Those backends
// are fakes that only record what they’re sent, so no real agent runs. Each test starts from @indexer as the demo
// left it. Moved from tools/check-agents.mjs (#303).

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createStreamMapper } from '../../server/adapters/claude-stream.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

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
        turns.push({ handle: session.handle, text: message.text });
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
  initial = { persona: structuredClone(personaNamed('indexer')), snapshot: structuredClone(store.state.sessions[indexer.id].personaSnapshot) };
});
test.afterAll(async () => {
  for (const r of replays.splice(0)) r.go();
  await app?.stop();
});
test.beforeEach(async () => {
  const { rt, store } = app;
  await expect.poll(() => store.state.sessions[indexer.id].state, { message: '@indexer idle' }).toBe('idle');
  store.emit('persona', { ...initial.persona, version: personaNamed('indexer').version + 1 });
  rt.updateSession(indexer.id, { personaSnapshot: initial.snapshot });
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

/** The focused element’s role or tag, and its accessible name (its label, else its text). */
const focused = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return 'body';
    return `${a.getAttribute('role') ?? a.tagName.toLowerCase()}: ${(a.getAttribute('aria-label') ?? a.textContent?.trim().replace(/\s+/g, ' ') ?? '').slice(0, 80)}`;
  });
const focusIs = (page, want) => expect.poll(() => focused(page), { message: 'where focus is' }).toEqual(want);

/** An agent’s row in the sidebar, and its button. */
const agentRow = (page, handle) => page.locator('.rail .agent-row').filter({ has: page.locator('.agent-btn b', { hasText: new RegExp(`^@${handle}$`) }) });
const row = (page, handle) => agentRow(page, handle).locator('.agent-btn');
const panel = (page) => page.locator('.backdrop .dialog.quick');
const status = (page) => page.locator('.qp .perm-status');
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A button in the quick panel whose text starts with these words. */
const button = (page, text) =>
  panel(page)
    .locator('button')
    .filter({ hasText: new RegExp(`^\\s*${literal(text)}`) });
const group = (page, name) => panel(page).locator(`[role=radiogroup][aria-label^="${name}"]`);
const radio = (page, name, label) =>
  group(page, name)
    .locator('[role=radio]')
    .filter({ hasText: new RegExp(`^\\s*${literal(label)}`) });
const shellSwitch = (page) => panel(page).locator('[role=switch][aria-label^="Shell"]');

/** Opens an agent’s quick panel from its row, with a click. */
async function quick(page, handle) {
  await row(page, handle).click();
  await expect(panel(page)).toBeVisible();
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
  expect(rows[0]).toBe('@indexer · idle Opus 5.5 · medium effort');
  expect(rows[1]).toMatch(/^@researcher · idle Opus 5\.5 · \w+ effort$/);
  // The list is named by its heading, and each row says it opens a dialog.
  await expect(page.locator('.rail .agent-rows')).toHaveAccessibleName('Agents');
  await expect(row(page, 'indexer')).toHaveAttribute('aria-haspopup', 'dialog');
});

test('Enter on a row opens its quick panel, labeled with the agent, with focus on its model', async ({ page }) => {
  await open(page, `#/t/${planning.id}`);
  await row(page, 'indexer').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: '@indexer' })).toBeVisible();
  await expect(row(page, 'indexer')).toHaveAttribute('aria-expanded', 'true');
  await focusIs(page, 'radio: Opus 5.5');
  const fits = await panel(page).evaluate((p) => {
    const b = p.getBoundingClientRect();
    return b.left >= 0 && b.right <= innerWidth && b.top >= 0 && document.documentElement.scrollWidth <= innerWidth;
  });
  expect(fits, 'the panel is on screen whole').toBe(true);
  // Beside the row, not over it.
  const rowRight = await row(page, 'indexer').evaluate((r) => r.getBoundingClientRect().right);
  expect(await panel(page).evaluate((p) => p.getBoundingClientRect().left), 'the panel is beside its row').toBeGreaterThanOrEqual(rowRight);
});

test('every control says whether it’s for this conversation or for the persona everywhere', async ({ page }) => {
  await open(page, `#/t/${planning.id}`);
  await quick(page, 'indexer');
  await expect(panel(page).locator('.qp-head')).toHaveText(['In this conversation', 'For @indexer everywhere']);
  // Each control’s own name carries its scope, so it’s heard on the control too.
  const names = await panel(page)
    .locator('[role=radiogroup], [role=switch]')
    .evaluateAll((xs) => xs.map((x) => x.getAttribute('aria-label')));
  expect(names).toEqual([
    'Model, in this conversation',
    'Effort, in this conversation',
    'Permission mode, in every conversation @indexer is in',
    'Shell, for @indexer everywhere',
    'Web, for @indexer everywhere',
    'Agents outside Postbox, for @indexer everywhere',
  ]);
  // Each switch says what turning it off means (#104).
  const help = await panel(page)
    .locator('[role=switch]')
    .evaluateAll((ss) => ss.map((s) => document.getElementById(s.getAttribute('aria-describedby') ?? '')?.textContent));
  expect(help).toEqual([
    'Off: it can’t run commands. It can still read and search files.',
    'Off: it can’t fetch pages or search the web.',
    'Off: it can’t message, schedule or start agents outside Postbox.',
  ]);
});

// ── Two clicks, without a command ───────────────────────────────────────────────────────

test('from the sidebar, two clicks change the model, for this conversation only', async ({ page }) => {
  await open(page, `#/t/${planning.id}`);
  // The row, then Sonnet 5.5.
  await quick(page, 'indexer');
  await radio(page, 'Model', 'Sonnet 5.5').click();
  await expect(status(page)).toContainText('Sonnet 5.5');
  // The panel says it as soon as the server answers; what follows reads the change the server sends after.
  await synced(page, app);
  expect(app.store.state.sessions[indexer.id].personaSnapshot.model).toBe('claude-sonnet-5-5');
  expect(personaNamed('indexer').model, 'the persona’s model stayed').toBe('claude-opus-5-5');
  await expect(status(page)).toHaveText('Model: Sonnet 5.5 for @indexer in this conversation, from its next turn.');
  await expect(group(page, 'Model').locator('[aria-checked="true"]')).toHaveText('Sonnet 5.5');
  await page.keyboard.press('Escape');
  // The row says the new setting at once.
  await expect(row(page, 'indexer')).toContainText('Sonnet 5.5');
});

test('from the sidebar, two clicks change the effort', async ({ page }) => {
  await open(page, `#/t/${planning.id}`);
  await quick(page, 'indexer');
  await radio(page, 'Effort', 'High').click();
  await expect(status(page)).toContainText('Effort: high');
  expect(app.store.state.sessions[indexer.id].personaSnapshot.effort).toBe('high');
});

test('from the sidebar, two clicks change the permission mode, for the persona everywhere', async ({ page }) => {
  await open(page, `#/t/${planning.id}`);
  await quick(page, 'indexer');
  await radio(page, 'Permission mode', 'Ask me').click();
  await expect(status(page)).toContainText('Ask me');
  expect(personaNamed('indexer').permissionMode).toBe('ask');
  await expect(status(page)).toContainText(/in every conversation/);
});

test('from the sidebar, two clicks turn the shell off, for the persona everywhere', async ({ page }) => {
  await open(page, `#/t/${planning.id}`);
  expect(personaNamed('indexer').tools).toContain('shell');
  await quick(page, 'indexer');
  await shellSwitch(page).click();
  await expect(shellSwitch(page), 'the switch turns off').toHaveAttribute('aria-checked', 'false');
  expect(personaNamed('indexer').tools).not.toContain('shell');
  await expect(status(page)).toHaveText('Shell: off for @indexer in every conversation, from their next turns.');
  // The switch says “Off” in words, not only by its look.
  await expect(shellSwitch(page)).toContainText('Off');
});

test('by keyboard: Tab moves through the panel, Space switches, and Escape returns focus to the row', async ({ page }) => {
  // As the clicks above left it: Sonnet 5.5 at high effort, asking first, with the shell off.
  await app.rt.setSessionRun(indexer.id, { model: 'claude-sonnet-5-5', effort: 'high' });
  real('indexer', { permissionMode: 'ask', tools: personaNamed('indexer').tools.filter((t) => t !== 'shell') });
  await open(page, `#/t/${planning.id}`);
  await row(page, 'indexer').focus();
  await page.keyboard.press('Enter');
  await expect(panel(page)).toBeVisible();
  await focusIs(page, 'radio: Sonnet 5.5');
  // One Tab stop per group: the model, the effort, the mode, then the shell switch.
  await page.keyboard.press('Tab');
  await focusIs(page, 'radio: High');
  await page.keyboard.press('Tab');
  await focusIs(page, 'radio: Ask me');
  // Arrow keys move within a group without picking.
  await page.keyboard.press('ArrowDown');
  await focusIs(page, 'radio: Accept edits');
  expect(personaNamed('indexer').permissionMode).toBe('ask');
  const seen = [];
  for (let i = 0; i < 12 && !(await focused(page)).startsWith('switch: Shell'); i++) {
    await page.keyboard.press('Tab');
    seen.push(await focused(page));
  }
  expect(await focused(page), `Tab went: ${seen.join(' › ')}`).toBe('switch: Shell, for @indexer everywhere');
  await page.keyboard.press('Space');
  await expect(shellSwitch(page), 'Space turns the shell back on').toHaveAttribute('aria-checked', 'true');
  expect(personaNamed('indexer').tools).toContain('shell');
  // Focus stays on the switch after the panel repaints.
  await focusIs(page, 'switch: Shell, for @indexer everywhere');
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  // The row’s name is its words: the ring beside them is hidden from screen readers, so it isn’t read twice.
  await expect(row(page, 'indexer')).toBeFocused();
  await expect(row(page, 'indexer')).toHaveAccessibleName('@indexer · idle Sonnet 5.5 · high effort');
  await expect(row(page, 'indexer')).toHaveAttribute('aria-expanded', 'false');
});

test('a change made elsewhere reaches the open panel', async ({ page }) => {
  await open(page, `#/t/${planning.id}`);
  await quick(page, 'indexer');
  await app.rt.setSessionRun(indexer.id, { model: 'claude-haiku-5-5' });
  await expect(group(page, 'Model').locator('[aria-checked="true"]')).toHaveText('Haiku 5.5');
});

// ── Links and actions ───────────────────────────────────────────────────────────────────

test('“Rules, folders and MCP…” opens the permissions panel on the agent; Escape returns to its row', async ({ page }) => {
  await open(page, `#/t/${planning.id}`);
  await row(page, 'indexer').focus();
  await page.keyboard.press('Enter');
  await expect(panel(page)).toBeVisible();
  await button(page, 'Rules, folders and MCP…').focus();
  await page.keyboard.press('Enter');
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator('.backdrop .dialog'), 'the permissions panel').toContainText('@indexer');
  await page.keyboard.press('Escape');
  await expect.poll(() => focused(page)).toMatch(/^button: @indexer/);
});

test('“Edit persona…” opens Settings › Personas on the agent', async ({ page }) => {
  await open(page, `#/t/${planning.id}`);
  await quick(page, 'researcher');
  await button(page, 'Edit persona…').click();
  await expect(page.locator('.backdrop .dialog [role=tab][aria-selected=true]'), 'Settings › Personas').toHaveText('Personas');
  await expect(page.locator('.backdrop .dialog')).toContainText('@researcher');
});

test('Stop is there only while it works, Compact only on a real backend, and a mock agent has no model to change', async ({ page }) => {
  const { rt } = app;
  await open(page, `#/t/${planning.id}`);
  await quick(page, 'indexer');
  await expect(button(page, 'Stop')).toBeDisabled();
  await expect(button(page, 'Compact')).toBeEnabled();
  rt.updateSession(indexer.id, { state: 'tool' });
  await expect(button(page, 'Stop'), 'Stop turns on while it works').toBeEnabled();
  await expect(button(page, 'Compact')).toBeDisabled();
  await button(page, 'Stop').click();
  await expect(status(page)).toHaveText('Stopping @indexer.');
  // While its process exits it reads “stopping” (#126), in the panel and its row, and Stop isn’t offered again.
  rt.updateSession(indexer.id, { state: 'stopping' });
  await expect(button(page, 'Stop'), 'Stop turns off while it stops').toBeDisabled();
  await expect(row(page, 'indexer')).toContainText('· stopping');
  await expect(panel(page).locator('.d-head')).toContainText('Stopping');
  rt.updateSession(indexer.id, { state: 'idle' });
  // Compact runs Claude Code’s /compact as the agent’s turn, as the composer’s /compact does, and closes the panel.
  await expect(button(page, 'Compact')).toBeEnabled();
  await button(page, 'Compact').click();
  await expect(panel(page), 'the panel closes').toHaveCount(0);
  await expect.poll(() => turns.some((x) => x.handle === 'indexer' && x.text === '/compact'), { message: 'the /compact turn' }).toBe(true);
  // A mock agent: no model, effort or mode; its tools still show, on its persona.
  await open(page, `#/t/${threadNamed('Corpus schema spec').id}`);
  await quick(page, 'critic');
  await expect(panel(page)).toContainText('A mock agent runs scripted replies, so it has no model, effort or permission mode to change.');
  await expect(panel(page).locator('[role=radiogroup]')).toHaveCount(0);
  await expect(button(page, 'Compact')).toHaveCount(0);
  await expect(panel(page).locator('[role=switch]')).toHaveCount(3);
});

test('Delete session… in the panel opens its confirmation, and there’s no Archive (#320)', async ({ page }) => {
  await open(page, `#/t/${shelf.id}`);
  await quick(page, 'indexer');
  await expect(button(page, 'Archive'), 'the panel offers no Archive').toHaveCount(0);
  await button(page, 'Delete session').click();
  await expect(page.locator('.dialog', { hasText: 'Delete @indexer’s session?' }), 'the confirmation').toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog', { hasText: 'Delete @indexer’s session?' })).toHaveCount(0);
  expect(app.store.state.sessions[sessionIn(shelf, 'indexer').id].deleting ?? false, 'Escape didn’t delete it').toBe(false);
});

// ── A topic thread ──────────────────────────────────────────────────────────────────────

test('a topic thread is answered by the conversation’s own session; its panel names it in a line, with no list (#228)', async ({ page }) => {
  const { rt, store } = app;
  await open(page, `#/t/${planning.id}/side/${topic.id}`);
  await expect(page.locator('.sp-agents p')).toHaveText('@indexer is in this thread.');
  await expect(page.locator('.sidepanel .agent-row, .sidepanel .agents-sec'), 'the thread lists no agents').toHaveCount(0);
  const n = turns.length;
  rt.sendMessage(topic.id, { text: 'Which shelf?' });
  await expect.poll(() => turns.length, { message: 'the reply' }).toBeGreaterThan(n);
  expect(turns.at(-1)).toEqual({ handle: 'indexer', text: 'Which shelf?' });
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
    const subs = agentRow(page, 'indexer').locator('.agent-sub.subagent');
    // The Reader, then the subagent it started, nested under it; each with what it was asked and, on a line of its own,
    // what it’s doing now: the Reader’s latest narration in its own words, then its step since.
    await expect(subs.locator('.sub-head')).toHaveText(['general-purpose · subagent: Reader', 'general-purpose · subagent in the background: Nested checker']);
    await expect(subs.nth(0)).toHaveAttribute('data-depth', '0');
    await expect(subs.nth(1)).toHaveAttribute('data-depth', '1');
    // Its step changed after it spoke, so the line says both.
    await expect(subs.locator('.sub-now')).toHaveText(['“The word count came back as 3.” · Subagent: Nested checker', 'Nested checker']);
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
    const tree = await page
      .locator('.turn details.activity')
      .last()
      .evaluate((reply) => {
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
    const subs = agentRow(page, 'indexer').locator('.agent-sub.subagent');
    const ends = subs.locator('.sub-end');
    await expect(ends, 'End on each subagent').toHaveCount(2);
    await expect(ends.nth(0)).toHaveAttribute('aria-label', 'End @indexer’s subagent ‘Reader’');
    const first = store.state.sessions[indexer.id].subagents[0].id;
    await ends.nth(0).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => store.state.sessions[indexer.id].endingSubagents ?? [], { message: 'the subagent to be ending' }).toContain(first);
    expect(store.state.sessions[indexer.id].context.some((x) => x.startsWith('[Postbox] URGENT: the person ended your subagent'))).toBe(true);
    await expect(page.getByRole('button', { name: 'End @indexer’s subagent ‘Nested checker’' }), 'focus on the next End').toBeFocused();
    await synced(page, app);
    await expect(subs.first().locator('.sub-now'), 'the row reads ending').toHaveText('Ending: @indexer was told to stop it');
  } finally {
    r.go();
  }
});

// ── A narrow window ─────────────────────────────────────────────────────────────────────

for (const theme of /** @type {const} */ (['light', 'dark']))
  test.describe(`at 375 px (${theme})`, () => {
    test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: theme });

    test(`at 375 px (${theme}), the top bar fits a long title with no agent rings, and its menu names each agent (#320)`, async ({ page }) => {
      app.rt.renameThread(shelf.id, 'Index every book on the shelf, then check the index against the catalog');
      try {
        await open(page, `#/t/${shelf.id}`);
        expect(await page.locator('header.topbar').evaluate((t) => t.scrollWidth <= t.clientWidth), 'the top bar fits').toBe(true);
        await expect(page.locator('header.topbar pb-ring'), 'the top bar has no agent rings').toHaveCount(0);
        // Where the sidebar is hidden, the conversation’s menu names its agents, each leading to its persona.
        await page.locator('header.topbar #conversation-actions').click();
        await expect(page.locator('.menu button.mi', { hasText: '@indexer' }), 'the menu names @indexer').toBeVisible();
      } finally {
        app.rt.renameThread(shelf.id, 'Index the shelf');
      }
    });
  });
