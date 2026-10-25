// What each agent runs with (#60), in its row in the sidebar’s Agents section (#105) and the menus; the mock marker,
// the demo banner and the line on installing Claude Code (#12); and what the top bar keeps at each width (#72, #105),
// at 1280 and 375 px, in both color schemes, with its measurements noted on each test.
// On a room with four of the demo’s agents, two moved to real backends without running a turn, one of them with a
// last turn answered by a model other than the one set. No agent turn runs. A second Postbox, without --demo, looks
// for Claude Code at a path that doesn’t exist, as on a computer without it. Moved from tools/check-header.mjs (#303).

import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { failOnPageErrors, frames, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let room;
let corpus;

const personaNamed = (handle) => Object.values(app.store.state.personas).find((p) => p.handle === handle);
const threadNamed = (title) => Object.values(app.store.state.threads).find((t) => t.title === title);
const sessionOf = (handle) => app.rt.sessionsIn(room.id).find((se) => se.handle === handle);
/**
 * Real backends aren’t registered here (POSTBOX_BACKENDS=mock), so a persona is moved in the store, as an edit in the
 * persona sheet would on a computer with Claude Code. Sessions started after take that snapshot.
 */
const real = (handle, patch) => app.store.emit('persona', { ...personaNamed(handle), ...patch, version: (personaNamed(handle).version ?? 1) + 1 });

test.beforeAll(async () => {
  app = await startPostbox('header');
  real('indexer', { backend: 'claude-code', model: 'claude-opus-5-5', effort: 'medium' });
  real('researcher', { backend: 'agent-sdk', model: 'claude-opus-5-5', effort: 'high' });
  corpus = Object.values(app.store.state.projects).find((p) => p.name === 'Book corpus');
  room = app.rt.createThread({
    projectId: corpus.id,
    title: 'Full room',
    personaIds: ['librarian', 'indexer', 'researcher', 'critic'].map((x) => personaNamed(x).id),
  });
  // @indexer’s last turn was answered by another model than the one set (a router, or the person’s own settings).
  app.rt.updateSession(sessionOf('indexer').id, { lastModel: 'claude-sonnet-5-5', lastEffort: 'medium' });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
// Wide, unless a test says otherwise: the tests of what fits measure at 1280 and 375 px.
test.use({ viewport: { width: 2560, height: 900 } });

/** Opens a place in Postbox and waits for it to have heard everything the server did. */
async function open(page, hash) {
  await page.goto(`${app.origin}/${hash}`);
  await synced(page, app);
  await expect(page.locator('header.topbar')).toBeVisible();
}
/** An agent’s row in the sidebar’s Agents section (#105): the button that opens its quick panel. */
const row = (page, handle) =>
  page
    .locator('.rail .agent-row')
    .filter({ has: page.locator('.agent-btn b', { hasText: new RegExp(`^@${handle}$`) }) })
    .locator('.agent-btn');
/** The text a person sees in an element (what’s rendered, not what’s hidden), as one line. */
const seen = async (locator) => (await locator.allInnerTexts()).join(' ').replace(/\s+/g, ' ').trim();
const seesText = (locator, want, message) => expect.poll(() => seen(locator), { message }).toEqual(want);
const menu = (page) => page.locator('.menu');
const openMenu = async (page) => {
  await page.locator('header.topbar #conversation-actions').click();
  await expect(menu(page)).toBeVisible();
};

/** Runs fn with the room under a long title, so a narrow window is short of room: a short title fits at 375 px. */
async function longTitle(fn) {
  const was = app.store.state.threads[room.id].title;
  app.rt.putThread({ ...app.store.state.threads[room.id], title: 'A long room title that needs the room the project takes' });
  try {
    await fn();
  } finally {
    app.rt.putThread({ ...app.store.state.threads[room.id], title: was });
  }
}

// ── #60: the model that answered and the effort ─────────────────────────────────────────

test('#60 each agent’s row says its state, the model that answered and the effort, marked in words when the model differs', async ({ page }) => {
  await open(page, `#/t/${room.id}`);
  await seesText(row(page, 'indexer'), '@indexer · idle Sonnet 5.5, not Opus 5.5 · medium effort');
  // Before its first turn, the model and effort it’s set to.
  await seesText(row(page, 'researcher'), '@researcher · idle Opus 5.5 · high effort');
  // A mock agent has no model or effort.
  await seesText(row(page, 'critic'), '@critic mock · idle');
});

test('#60 a new last model reaches the row without a reload', async ({ page }) => {
  const { rt } = app;
  await open(page, `#/t/${room.id}`);
  try {
    rt.updateSession(sessionOf('researcher').id, { lastModel: 'claude-opus-5-5', lastEffort: 'high' });
    await expect(row(page, 'researcher')).toContainText('Opus 5.5 · high effort');
    rt.updateSession(sessionOf('researcher').id, { lastModel: 'claude-haiku-5-5' });
    await expect(row(page, 'researcher'), 'the changed model in the row').toContainText('Haiku 5.5, not Opus 5.5');
  } finally {
    rt.updateSession(sessionOf('researcher').id, { lastModel: 'claude-opus-5-5' });
  }
});

test('#60 the conversation’s menu says it with full model ids', async ({ page }) => {
  // The conversation’s ⋯ menu lists every agent with its backend, model, effort and state.
  await open(page, `#/t/${room.id}`);
  await openMenu(page);
  const said = await seen(menu(page));
  for (const line of [
    '@librarian mock Mock agent · scripted replies, not a model · idle',
    '@indexer Claude Code · claude-sonnet-5-5 · not the model you set: claude-opus-5-5 · medium effort · idle',
    '@researcher Agent SDK · claude-opus-5-5 · high effort · idle',
    '@critic mock Mock agent · scripted replies, not a model · idle',
  ])
    expect(said, `the menu says “${line}”`).toContain(line);
});

// ── #12: mock agents and demo mode, marked everywhere ───────────────────────────────────

/** That a “mock” marker is on screen and says “mock”. */
const markedMock = (locator, message) => expect(locator.locator('.mock-tag'), message).toHaveText('mock');
const railWho = (page) => page.locator(`.rail a.row[data-thread="${room.id}"] .sub`);

test('#12 a mock agent is marked in its agent row, rail row and speaker line, and a real one isn’t', async ({ page }) => {
  // A reply each from @critic (mock) and @indexer (Claude Code), so both have speaker lines.
  for (const handle of ['critic', 'indexer']) {
    const se = sessionOf(handle);
    app.rt.addItem(room.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle, text: `A reply from @${handle}.`, status: 'done' });
  }
  await open(page, `#/t/${room.id}`);
  await markedMock(row(page, 'critic'), 'the agent row says “mock”');
  await expect(row(page, 'indexer').locator('.mock-tag'), 'a Claude Code agent’s row doesn’t say “mock”').toHaveCount(0);
  // The room’s rail row names all four, and marks the two on the mock.
  await seesText(railWho(page), '@librarian mock, @indexer, @researcher, @critic mock · idle');
  // Speaker lines.
  const speaker = (handle) => page.locator('.who').filter({ has: page.locator('b', { hasText: new RegExp(`^@${handle}$`) }) });
  await markedMock(speaker('critic').last(), 'the speaker line says “mock”');
  await expect(speaker('indexer').locator('.mock-tag')).toHaveCount(0);
});

test('#12 the marker follows the persona: moved to Claude Code, the agent row and the rail row lose it without a reload', async ({ page }) => {
  await open(page, `#/t/${room.id}`);
  try {
    real('librarian', { backend: 'claude-code', model: 'claude-opus-5-5', effort: 'low' });
    // Its session keeps the effort it started with; the model was “mock”, so it runs the default.
    await expect(row(page, 'librarian').locator('.mock-tag'), 'the agent row drops “mock”').toHaveCount(0);
    await expect(row(page, 'librarian')).toContainText('Opus 5.5');
    await seesText(railWho(page), '@librarian, @indexer, @researcher, @critic mock · idle', 'the rail row drops “mock”');
  } finally {
    real('librarian', { backend: 'mock', model: 'mock' });
  }
  await markedMock(row(page, 'librarian'), 'the agent row says “mock” again');
});

test('#12 the menus and the Personas list mark mock agents', async ({ page }) => {
  await open(page, `#/t/${room.id}`);
  await openMenu(page);
  const marked = await menu(page)
    .locator('button.mi')
    .filter({ has: page.locator('.mock-tag') })
    .evaluateAll((bs) => bs.map((b) => b.querySelector('.grow')?.firstChild?.textContent));
  expect(marked).toEqual(['@librarian', '@critic']);
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await page.locator('header.topbar').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Personas' }).click();
  await expect(page.locator('.list-rows li b').first()).toBeVisible();
  const rows = await page.locator('.list-rows li').evaluateAll((lis) => lis.map((li) => [li.querySelector('b')?.textContent, !!li.querySelector('.mock-tag')]));
  expect(rows.filter(([n]) => ['@librarian', '@indexer', '@researcher', '@critic'].includes(n ?? ''))).toEqual([
    ['@librarian', true],
    ['@indexer', false],
    ['@researcher', false],
    ['@critic', true],
  ]);
});

test('#12 the composer marks a mock agent in “Replying to” and in the @ menu', async ({ page }) => {
  app.rt.putThread({ ...app.store.state.threads[room.id], lastSpeaker: sessionOf('critic').id });
  await open(page, `#/t/${room.id}`);
  await expect(page.locator('.composer .hint'), 'the hint marks @critic').toContainText('Replying to @critic mock (last speaker)');
  await page.locator('#composer-input').click();
  await page.keyboard.type('@');
  await expect(page.locator('#mention-list')).toBeVisible();
  const rows = await page
    .locator('#mention-list [role=option] .grow')
    .evaluateAll((gs) => gs.map((g) => [g.firstChild?.textContent, !!g.querySelector('.mock-tag')]));
  expect(rows.filter(([n]) => ['@librarian', '@indexer', '@researcher', '@critic'].includes(n ?? '')).sort()).toEqual([
    ['@critic', true],
    ['@indexer', false],
    ['@librarian', true],
    ['@researcher', false],
  ]);
});

const DEMO = 'Demo mode: scripted agents';
const demoNote = (page) => page.locator('header.topbar .demo-note');

test('#12 under --demo, every view says so, and it isn’t a live region', async ({ page }) => {
  for (const hash of [`#/p/${corpus.id}/threads`, `#/t/${room.id}`]) {
    await open(page, hash);
    await seesText(demoNote(page), DEMO, `the demo banner on ${hash}`);
    expect(await demoNote(page).evaluate((n) => !n.closest('[aria-live], [role=status], [role=alert], [role=log]')), 'the banner isn’t in a live region').toBe(
      true,
    );
  }
  // The demo has no install line: Postbox didn’t look for Claude Code.
  await expect(page.locator('.install-note')).toHaveCount(0);
});

test.describe('at 375 px', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test('#12 at 375 px the banner folds to “Demo”, and its whole sentence is still read', async ({ page }) => {
    await longTitle(async () => {
      await open(page, `#/t/${room.id}`);
      await expect(page.locator('header.topbar'), 'the banner folds').toHaveAttribute('data-drop', /demo/);
      // “Demo” on screen; the sentence is visually hidden, so it’s still read.
      const parts = await demoNote(page).evaluate((n) => [...n.children].map((c) => [c.textContent, Math.round(c.getBoundingClientRect().width)]));
      expect(parts[0][0]).toBe(DEMO);
      expect(parts[0][1], 'the sentence takes no room').toBeLessThanOrEqual(1);
      expect(parts[1][0]).toBe('Demo');
      expect(parts[1][1], '“Demo” is on screen').toBeGreaterThan(10);
      await expect(demoNote(page).locator('.demo-short')).toHaveAttribute('aria-hidden', 'true');
    });
  });
});

test('#12 without --demo there’s no banner, and with Claude Code missing, a fresh install says how to install it', async ({ page }) => {
  // Paths that don’t exist, so Postbox finds no Claude Code and no other CLI. The person’s own installs are never run.
  const BINS = ['POSTBOX_CLAUDE_BIN', 'POSTBOX_KIRO_BIN', 'POSTBOX_AGY_BIN', 'POSTBOX_CODEX_BIN'];
  const was = Object.fromEntries([...BINS, 'POSTBOX_BACKENDS'].map((k) => [k, process.env[k]]));
  delete process.env.POSTBOX_BACKENDS;
  for (const k of BINS) process.env[k] = join(app.root, 'no-such-folder', k.slice(8, -4).toLowerCase());
  let fresh;
  try {
    fresh = await startPostbox('header-fresh', { demo: false, mockOnly: false });
    // A fresh install has no projects or conversations.
    Object.assign(fresh.store.state, { projects: {}, threads: {}, sessions: {}, items: {} });
    await page.goto(`${fresh.origin}/#/`);
    // No project yet: the page that says so carries the install line, as the sidebar does once there is one (#320).
    await expect(page.locator('.empty-home'), 'the page with no project').toBeVisible();
    await expect(demoNote(page), 'no demo banner without --demo').toHaveCount(0);
    const line = page.locator('.install-note');
    await expect(line, 'an install line on the page').toBeVisible();
    // The Agent SDK loads without Claude Code when it’s installed (npm install), so say what agents run on.
    const sdk = fresh.rt.adapters.names().includes('agent-sdk');
    await expect(line).toContainText(sdk ? 'so agents run on the Agent SDK or the mock until it is.' : 'so agents run on the mock until it is');
    await expect(line).toContainText('install Claude Code so claude --version works, or set POSTBOX_CLAUDE_BIN to where it is, then restart Postbox');
  } finally {
    // Leave the page first, so closing the server doesn’t cut its event stream mid-message.
    await page.goto('about:blank');
    await fresh?.stop();
    for (const [k, v] of Object.entries(was))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});

// ── #72, #105: what the top bar keeps at each width ─────────────────────────────────────

/** The top bar’s fit, once it holds still: its width and overflow, what it dropped, the crumbs, and its rings. */
async function fitted(page, label) {
  await settled(page);
  await frames(page);
  const m = await page.locator('header.topbar').evaluate((bar) => {
    const box = (el) => el.getBoundingClientRect();
    const full = (el) => !!el && el.offsetWidth > 0 && box(el).left >= 0 && box(el).right <= innerWidth && el.scrollWidth <= el.clientWidth;
    return {
      width: bar.clientWidth,
      overflow: bar.scrollWidth - bar.clientWidth,
      drop: /** @type {HTMLElement} */ (bar).dataset.drop ?? '',
      title: Math.round(box(bar.querySelector('.crumbs > .title')).width),
      titleFull: full(bar.querySelector('.crumbs > .title')),
      projectFull: full(bar.querySelector('.crumbs > .crumb.up')),
      rings: bar.querySelectorAll('pb-ring').length,
    };
  });
  test
    .info()
    .annotations.push({ type: 'measured', description: `${label}: ${m.width} px, overflow ${m.overflow} px, title ${m.title} px, dropped “${m.drop}”` });
  return m;
}

for (const theme of /** @type {const} */ (['light', 'dark']))
  test.describe(`1280 px, ${theme}`, () => {
    test.use({ viewport: { width: 1280, height: 900 }, colorScheme: theme });

    test(`#105 a room with two agents at 1280 px (${theme}): the title and the project show in full, and the agents are in the sidebar, not the top bar (#320)`, async ({
      page,
    }) => {
      await open(page, `#/t/${threadNamed('Corpus planning').id}`);
      const m = await fitted(page, `1280 px, ${theme}`);
      expect(m.overflow, 'the top bar fits').toBe(0);
      expect(m.drop, 'the top bar dropped nothing').toBe('');
      expect(m.projectFull, 'the project is shown in full').toBe(true);
      expect(m.titleFull, 'the conversation’s title is shown in full').toBe(true);
      expect(m.rings, 'the top bar has no agent rings').toBe(0);
      await expect(page.locator('.rail .agent-row'), 'the Agents section lists both').toHaveCount(2);
    });
  });

for (const theme of /** @type {const} */ (['light', 'dark']))
  for (const width of [1280, 375])
    test.describe(`${width} px, ${theme}`, () => {
      test.use(
        width < 768
          ? { viewport: { width, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: theme }
          : { viewport: { width, height: 900 }, colorScheme: theme },
      );

      test(`#72 a room with four agents at ${width} px (${theme}): no overflow, and the facts stay in the conversation’s menu`, async ({ page }) => {
        await open(page, `#/t/${room.id}`);
        const m = await fitted(page, `${width} px, ${theme}`);
        expect(m.overflow, 'the top bar fits').toBe(0);
        expect(m.rings, 'the top bar has no agent rings').toBe(0);
        if (width === 1280) expect(m.drop, 'the top bar dropped nothing at 1280 px').toBe('');
        // What it runs with is in the conversation’s menu, as text on screen.
        await openMenu(page);
        const line = menu(page).locator('button.mi', { hasText: '@indexer' });
        expect(await seen(line)).toMatch(/^@indexer Claude Code · claude-sonnet-5-5 · not the model you set: claude-opus-5-5 · medium effort · idle/);
        await expect(line).toBeInViewport({ ratio: 1 });
      });
    });

test.describe('1280 px', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('#60 with one agent at 1280 px, its row shows its state, model and effort, and the top bar drops nothing', async ({ page }) => {
    await open(page, `#/t/${threadNamed('Index the shelf').id}`);
    const m = await fitted(page, 'one agent, 1280 px');
    expect(m.drop).toBe('');
    expect(m.titleFull && m.projectFull, 'the title and the project are shown in full').toBe(true);
    await seesText(row(page, 'indexer'), '@indexer · idle Opus 5.5 · medium effort');
  });

  test('#72 the top bar refits when the window changes, and a state word changing doesn’t move it', async ({ page }) => {
    const { rt } = app;
    await open(page, `#/t/${room.id}`);
    const wide = await fitted(page, 'wide');
    expect(wide.drop).toBe('');
    // “· calling tools” is longer than “· idle”; it’s in the sidebar, so the top bar stays as it was.
    const all = ['librarian', 'indexer', 'researcher', 'critic'];
    try {
      for (const handle of all) rt.updateSession(sessionOf(handle).id, { state: 'tool', currentStep: 'Working' });
      await expect(row(page, 'indexer'), 'the row says “calling tools”').toContainText(/^@indexer · calling tools/);
      const busy = await fitted(page, 'busy');
      expect([busy.overflow, busy.drop, busy.title]).toEqual([0, '', wide.title]);
    } finally {
      for (const handle of all) rt.updateSession(sessionOf(handle).id, { state: 'idle', currentStep: '' });
    }
    await expect(row(page, 'indexer')).toContainText(/^@indexer · idle/);
    // Narrow, with a title that needs the room, it drops in order, and wide again, it brings everything back.
    await longTitle(async () => {
      await synced(page, app);
      await page.setViewportSize({ width: 375, height: 812 });
      const narrow = await fitted(page, '375 px');
      expect(narrow.overflow).toBe(0);
      expect(narrow.drop, 'it dropped the project crumb first').toMatch(/^crumb/);
      await page.setViewportSize({ width: 1280, height: 900 });
      expect((await fitted(page, 'back to 1280 px')).drop).toBe('');
    });
  });
});
