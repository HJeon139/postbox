// A headless Chrome check of what each agent runs with (#60), in its row in the sidebar’s Agents section (#105),
// its card and the menus; the mock marker, the demo banner and the line on installing Claude Code (#12); and what
// the top bar keeps at each width (#72, #105): at 1280 and 375 px, in both color schemes, it prints its
// measurements.
//
//   node tools/check-header.mjs
//
// It starts its own server with the demo seed (mock agents) on a fresh data folder in the temp directory, and
// seeds a room with four agents through the runtime: two moved to real backends without running a turn, one of
// them with a last turn answered by a model other than the one set. No agent turn runs. A second server, without
// --demo, looks for Claude Code at a path that doesn’t exist, as on a computer without it. PB_PORT (and the port
// after it) and PB_CHROME_PORT move them, so sessions working in parallel don’t collide.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { launch } from './cdp.mjs';
import { finish, ports, record } from './harness.mjs';

const { PORT, CHROME_PORT } = await ports(4440, 9640, { span: 2 });

process.env.POSTBOX_BACKENDS = 'mock';
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-header-'));
const claudeHome = await mkdtemp(join(tmpdir(), 'pb-check-header-home-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true, claudeHome });
const page = await launch({ port: CHROME_PORT });
const { rt, store } = app;

// ── The room: four agents, two on real backends ─────────────────────────────────────────

const personaNamed = (handle) => Object.values(store.state.personas).find((p) => p.handle === handle);
// Real backends aren’t registered here (POSTBOX_BACKENDS=mock), so the personas are moved in the store, as an
// edit in the persona sheet would on a computer with Claude Code. Their sessions start after, with that snapshot.
const real = (handle, patch) => store.emit('persona', { ...personaNamed(handle), ...patch, version: (personaNamed(handle).version ?? 1) + 1 });
real('indexer', { backend: 'claude-code', model: 'claude-opus-5-5', effort: 'medium' });
real('researcher', { backend: 'agent-sdk', model: 'claude-opus-5-5', effort: 'high' });
const corpus = Object.values(store.state.projects).find((p) => p.name === 'Book corpus');
const room = rt.createThread({
  projectId: corpus.id,
  title: 'Full room',
  personaIds: ['librarian', 'indexer', 'researcher', 'critic'].map((x) => personaNamed(x).id),
});
const sessionOf = (handle) => rt.sessionsIn(room.id).find((se) => se.handle === handle);
// @indexer’s last turn was answered by another model than the one set (a router, or the person’s own settings).
rt.updateSession(sessionOf('indexer').id, { lastModel: 'claude-sonnet-5-5', lastEffort: 'medium' });

// ── Helpers ─────────────────────────────────────────────────────────────────────────────

const settle = () => page.evaluate('new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 60)); setTimeout(r, 250); })');
/** An agent’s row in the sidebar’s Agents section (#105): the button that opens its quick panel. */
const row = (handle) =>
  `[...document.querySelectorAll('.rail .agent-row .agent-btn')].find((c) => c.querySelector('b')?.textContent === ${JSON.stringify(`@${handle}`)})`;
/** The text a person sees in an element (what’s rendered, not what’s hidden), as one line. */
const seenText = (expr) => `(() => { const el = ${expr}; return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null; })()`;
const seen = (expr) => page.evaluate(seenText(expr));

/** Escape closes any menu or dialog left open, the way a person would, so its listeners go with it. */
async function closeAll() {
  for (let i = 0; i < 4 && (await page.evaluate(`!!document.querySelector('.backdrop, .menu')`)); i++)
    await page.evaluate(
      `(document.querySelector('.menu') ?? document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
    );
}

async function check(name, fn) {
  let timer;
  try {
    const late = new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error('Timed out after 30 s')), 30000);
    });
    await Promise.race([fn(), late]);
    record(true, name);
  } catch (e) {
    record(false, name, e.message);
  } finally {
    clearTimeout(timer);
  }
  await closeAll();
}
/**
 * Runs fn with the room under a long title, so a narrow window is short of room: with no agent rings in the top bar
 * (#320), a short title fits at 375 px with nothing dropped.
 */
async function longTitle(fn) {
  const was = store.state.threads[room.id].title;
  rt.putThread({ ...store.state.threads[room.id], title: 'A long room title that needs the room the project takes' });
  try {
    await fn();
  } finally {
    rt.putThread({ ...store.state.threads[room.id], title: was });
    await page.synced(store.state.seq);
  }
}
let loaded = false;
async function open(hash) {
  if (loaded) {
    // What the check changed on the server must have reached the page first, or it shows what was there before.
    await page.synced(store.state.seq);
    await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
  }
  // Not page.goto(): it waits for an animation frame, which headless Chrome can hold back.
  else await page.send('Page.navigate', { url: `${app.origin}/${hash}` });
  loaded = true;
  await page.waitFor(`document.querySelector('header.topbar')`);
  await settle();
}

// Wide; #72’s and #105’s cases below measure what fits at 1280 and 375 px.
const WIDE = 2560;
await page.size(WIDE, 900);

// ── #60: the model that answered and the effort ─────────────────────────────────────────

await check('#60 each agent’s row says its state, the model that answered and the effort, marked in words when the model differs', async () => {
  await open(`#/t/${room.id}`);
  assert.equal(await seen(row('indexer')), '@indexer · idle Sonnet 5.5, not Opus 5.5 · medium effort');
  // Before its first turn, the model and effort it’s set to.
  assert.equal(await seen(row('researcher')), '@researcher · idle Opus 5.5 · high effort');
  // A mock agent has no model or effort.
  assert.equal(await seen(row('critic')), '@critic mock · idle');
});

await check('#60 a new last model reaches the row without a reload', async () => {
  await open(`#/t/${room.id}`);
  rt.updateSession(sessionOf('researcher').id, { lastModel: 'claude-opus-5-5', lastEffort: 'high' });
  await page.waitFor(`${seenText(row('researcher'))}?.includes('Opus 5.5 · high effort')`);
  rt.updateSession(sessionOf('researcher').id, { lastModel: 'claude-haiku-5-5' });
  await page.waitFor(`${seenText(row('researcher'))}?.includes('Haiku 5.5, not Opus 5.5')`, { label: 'the changed model in the row' });
  rt.updateSession(sessionOf('researcher').id, { lastModel: 'claude-opus-5-5' });
});

await check('#60 the conversation’s menu says it with full model ids', async () => {
  // The conversation’s ⋯ menu lists every agent with its backend, model, effort and state.
  await open(`#/t/${room.id}`);
  await page.evaluate(`document.querySelector('header.topbar #conversation-actions').click()`);
  await page.waitFor(`document.querySelector('.menu')`);
  const menu = await seen(`document.querySelector('.menu')`);
  for (const line of [
    '@librarian mock Mock agent · scripted replies, not a model · idle',
    '@indexer Claude Code · claude-sonnet-5-5 · not the model you set: claude-opus-5-5 · medium effort · idle',
    '@researcher Agent SDK · claude-opus-5-5 · high effort · idle',
    '@critic mock Mock agent · scripted replies, not a model · idle',
  ])
    assert.ok(menu.includes(line), `The conversation menu doesn’t say “${line}”:\n${menu}`);
});

// ── #12: mock agents and demo mode, marked everywhere ───────────────────────────────────

/** Whether an element (a “mock” marker) is on screen and says “mock”. */
const visibleMarker = (expr) => page.evaluate(`(() => { const t = ${expr}; return !!t && t.offsetWidth > 0 && t.innerText.trim() === 'mock'; })()`);
const railWho = `document.querySelector('.rail a.row[data-thread="${room.id}"] .sub')`;

await check('#12 a mock agent is marked in its agent row, rail row and speaker line, and a real one isn’t', async () => {
  // A reply each from @critic (mock) and @indexer (Claude Code), so both have speaker lines.
  for (const handle of ['critic', 'indexer']) {
    const se = sessionOf(handle);
    rt.addItem(room.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle, text: `A reply from @${handle}.`, status: 'done' });
  }
  await open(`#/t/${room.id}`);
  assert.equal(await visibleMarker(`${row('critic')}?.querySelector('.mock-tag')`), true, 'The agent row has no visible “mock”');
  assert.equal(await page.evaluate(`!!${row('indexer')}?.querySelector('.mock-tag')`), false, 'A Claude Code agent’s row says “mock”');
  // The room’s rail row names all four, and marks the two on the mock.
  assert.equal(await seen(railWho), '@librarian mock, @indexer, @researcher, @critic mock · idle');
  // Speaker lines.
  const speaker = (handle) => `[...document.querySelectorAll('.who')].find((w) => w.querySelector('b')?.textContent === '@${handle}')`;
  await page.waitFor(speaker('critic'));
  assert.equal(await visibleMarker(`${speaker('critic')}.querySelector('.mock-tag')`), true, 'The speaker line has no visible “mock”');
  assert.equal(await page.evaluate(`!!${speaker('indexer')}.querySelector('.mock-tag')`), false);
});

await check('#12 the marker follows the persona: moved to Claude Code, the agent row and the rail row lose it without a reload', async () => {
  await open(`#/t/${room.id}`);
  real('librarian', { backend: 'claude-code', model: 'claude-opus-5-5', effort: 'low' });
  // Its session keeps the effort it started with; the model was “mock”, so it runs the default.
  await page.waitFor(`!${row('librarian')}.querySelector('.mock-tag') && ${seenText(row('librarian'))}.includes('Opus 5.5')`, {
    label: 'the agent row to drop “mock”',
  });
  await page.waitFor(`${seenText(railWho)} === '@librarian, @indexer, @researcher, @critic mock · idle'`, { label: 'the rail row to drop “mock”' });
  real('librarian', { backend: 'mock', model: 'mock' });
  await page.waitFor(`!!${row('librarian')}.querySelector('.mock-tag')`, { label: 'the agent row to say “mock” again' });
});

await check('#12 the menus and the Personas list mark mock agents', async () => {
  await open(`#/t/${room.id}`);
  await page.evaluate(`document.querySelector('header.topbar #conversation-actions').click()`);
  await page.waitFor(`document.querySelector('.menu')`);
  const marked = await page.evaluate(
    `[...document.querySelectorAll('.menu button.mi')].filter((b) => b.querySelector('.mock-tag')).map((b) => b.querySelector('.grow').firstChild.textContent)`,
  );
  assert.deepEqual(marked, ['@librarian', '@critic']);
  await closeAll();
  await page.evaluate(`document.querySelector('header.topbar button[aria-label="Settings"]').click()`);
  const tab = `[...document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Personas')`;
  await page.waitFor(tab);
  await page.evaluate(`${tab}.click()`);
  await page.waitFor(`document.querySelector('.list-rows li b')`);
  const rows = await page.evaluate(
    `[...document.querySelectorAll('.list-rows li')].map((li) => [li.querySelector('b')?.textContent, !!li.querySelector('.mock-tag')])`,
  );
  assert.deepEqual(
    rows.filter(([n]) => ['@librarian', '@indexer', '@researcher', '@critic'].includes(n)),
    [
      ['@librarian', true],
      ['@indexer', false],
      ['@researcher', false],
      ['@critic', true],
    ],
  );
  await closeAll();
});

await check('#12 the composer marks a mock agent in “Replying to” and in the @ menu', async () => {
  rt.putThread({ ...store.state.threads[room.id], lastSpeaker: sessionOf('critic').id });
  await open(`#/t/${room.id}`);
  const hintText = seenText(`document.querySelector('.composer .hint')`);
  await page.waitFor(`(${hintText} ?? '').includes('Replying to @critic mock (last speaker)')`, { label: 'the hint to mark @critic' });
  await page.evaluate(
    `(() => { const ta = document.querySelector('.composer textarea'); ta.focus(); ta.value = '@'; ta.setSelectionRange(1, 1); ta.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await page.waitFor(`document.querySelector('#mention-list')`);
  const rows = await page.evaluate(
    `[...document.querySelectorAll('#mention-list [role=option] .grow')].map((g) => [g.firstChild.textContent, !!g.querySelector('.mock-tag')])`,
  );
  assert.deepEqual(rows.filter(([n]) => ['@librarian', '@indexer', '@researcher', '@critic'].includes(n)).sort(), [
    ['@critic', true],
    ['@indexer', false],
    ['@librarian', true],
    ['@researcher', false],
  ]);
  await page.evaluate(
    `(() => { const ta = document.querySelector('.composer textarea'); ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
});

const DEMO = 'Demo mode: scripted agents';
const demoNote = `document.querySelector('header.topbar .demo-note')`;
await check('#12 under --demo, every view says so, and it isn’t a live region', async () => {
  for (const hash of [`#/p/${corpus.id}/threads`, `#/t/${room.id}`]) {
    await open(hash);
    assert.equal(await seen(demoNote), DEMO, `No demo banner on ${hash}`);
    assert.equal(await page.evaluate(`!${demoNote}.closest('[aria-live], [role=status], [role=alert], [role=log]')`), true, 'The banner is in a live region');
  }
  // The demo has no install line: Postbox didn’t look for Claude Code.
  await open(`#/t/${room.id}`);
  assert.equal(await page.evaluate(`!!document.querySelector('.install-note')`), false);
});

await check('#12 at 375 px the banner folds to “Demo”, and its whole sentence is still read', async () => {
  await page.size(375, 812);
  try {
    await longTitle(async () => {
      await open(`#/t/${room.id}`);
      await page.waitFor(`document.querySelector('header.topbar').dataset.drop?.includes('demo')`, { label: 'the banner to fold' });
      // “Demo” on screen; the sentence is visually hidden, so it’s still read.
      const widths = await page.evaluate(
        `[...${demoNote}.children].map((c) => [c.textContent, Math.round(c.getBoundingClientRect().width), c.getAttribute('aria-hidden')])`,
      );
      assert.equal(widths[0][0], DEMO);
      assert.ok(widths[0][1] <= 1, `The sentence is ${widths[0][1]} px wide`);
      assert.equal(widths[1][0], 'Demo');
      assert.ok(widths[1][1] > 10, '“Demo” isn’t on screen');
      assert.equal(await page.evaluate(`${demoNote}.querySelector('.demo-short').getAttribute('aria-hidden')`), 'true');
    });
  } finally {
    await page.size(WIDE, 900);
  }
});

await check('#12 without --demo there’s no banner, and with Claude Code missing, a fresh install says how to install it', async () => {
  delete process.env.POSTBOX_BACKENDS;
  // Paths that don’t exist, so Postbox finds no Claude Code and no other CLI. The person’s own installs are never
  // run: asking agy, Kiro and Codex for their models took most of the case’s 30 s on a busy computer.
  const BINS = ['POSTBOX_CLAUDE_BIN', 'POSTBOX_KIRO_BIN', 'POSTBOX_AGY_BIN', 'POSTBOX_CODEX_BIN'];
  const was = Object.fromEntries(BINS.map((k) => [k, process.env[k]]));
  for (const k of BINS) process.env[k] = join(claudeHome, 'no-such-folder', k.slice(8, -4).toLowerCase());
  const freshDir = await mkdtemp(join(tmpdir(), 'pb-check-header-fresh-'));
  const fresh = await start({ port: PORT + 1, dataDir: freshDir, fresh: true, quiet: true, claudeHome });
  try {
    // A fresh install has no projects or conversations.
    Object.assign(fresh.store.state, { projects: {}, threads: {}, sessions: {}, items: {} });
    await page.send('Page.navigate', { url: `${fresh.origin}/#/` });
    // No project yet: the page that says so carries the install line, as the sidebar does once there is one (#320).
    await page.waitFor(`document.querySelector('.empty-home')`, { label: 'the page with no project' });
    assert.equal(await page.evaluate(`!!${demoNote}`), false, 'A demo banner without --demo');
    const line = await seen(`document.querySelector('.install-note')`);
    assert.ok(line, 'No install line on the page');
    // The Agent SDK loads without Claude Code when it’s installed (npm install), so say what agents run on.
    const sdk = fresh.rt.adapters.names().includes('agent-sdk');
    assert.match(line, sdk ? /so agents run on the Agent SDK or the mock until it is\./ : /so agents run on the mock until it is/);
    assert.match(line, /install Claude Code so claude --version works, or set POSTBOX_CLAUDE_BIN to where it is, then restart Postbox/);
  } finally {
    await page.send('Page.navigate', { url: 'about:blank' });
    await fresh.close();
    await rm(freshDir, { recursive: true, force: true });
    for (const k of BINS)
      if (was[k] === undefined) delete process.env[k];
      else process.env[k] = was[k];
    process.env.POSTBOX_BACKENDS = 'mock';
    loaded = false;
  }
});

// ── #72, #105: what the top bar keeps at each width ─────────────────────────────────────
// The agents’ words are in the sidebar’s Agents section now (#105), and the top bar keeps a ring for each agent,
// which opens its quick panel.

/** The top bar’s fit, measured: its width and overflow, what it dropped, the crumbs, and each ring. */
const measure = () =>
  page.evaluate(`(() => {
    const bar = document.querySelector('header.topbar');
    const box = (el) => el.getBoundingClientRect();
    const shown = (el) => !!el && el.offsetWidth > 0 && box(el).left >= 0 && box(el).right <= innerWidth;
    const full = (el) => !!el && shown(el) && el.scrollWidth <= el.clientWidth;
    const crumbs = box(bar.querySelector('.crumbs'));
    const present = bar.querySelector('.present');
    const stack = bar.querySelector('.ring-stack');
    return {
      width: bar.clientWidth,
      overflow: bar.scrollWidth - bar.clientWidth,
      drop: bar.dataset.drop ?? '',
      title: Math.round(box(bar.querySelector('.crumbs > .title')).width),
      titleFull: full(bar.querySelector('.crumbs > .title')),
      projectFull: full(bar.querySelector('.crumbs > .crumb.up')),
      // How far the crumbs run under the rings (0 or less: they don’t).
      overlap: present ? Math.round(crumbs.right - box(present).left) : 0,
      // Each agent’s ring button, shown on its own, or folded into the stack.
      rings: [...bar.querySelectorAll('.present .ring-btn')].map((b) => ({
        shown: shown(b),
        name: b.querySelector('pb-ring svg')?.getAttribute('aria-label') ?? '',
        popup: b.getAttribute('aria-haspopup'),
      })),
      stack: stack ? { shown: shown(stack), rings: stack.querySelectorAll('pb-ring').length } : null,
    };
  })()`);
const fitted = async () => {
  await settle();
  await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  return measure();
};
const report = (label, m) =>
  console.log(
    `        ${label}: ${m.width} px, overflow ${m.overflow} px, title ${m.title} px, dropped “${m.drop}”, rings ${m.rings.filter((r) => r.shown).length}/${m.rings.length}${m.stack?.shown ? ' (folded)' : ''}`,
  );
const corpusPlanning = Object.values(store.state.threads).find((t) => t.title === 'Corpus planning');

for (const theme of ['light', 'dark'])
  await check(
    `#105 a room with two agents at 1280 px (${theme}): the title and the project show in full, and the agents are in the sidebar, not the top bar (#320)`,
    async () => {
      await page.size(1280, 900, { theme });
      try {
        await open(`#/t/${corpusPlanning.id}`);
        const m = await fitted();
        report(`1280 px, ${theme}`, m);
        assert.equal(m.overflow, 0, 'The top bar overflows');
        assert.equal(m.drop, '', `The top bar dropped “${m.drop}”`);
        assert.ok(m.projectFull, 'The project isn’t shown in full');
        assert.ok(m.titleFull, 'The conversation’s title isn’t shown in full');
        assert.equal(m.rings.length, 0, 'The top bar has agent rings');
        assert.equal(await page.evaluate(`document.querySelectorAll('.rail .agent-row').length`), 2, 'The Agents section lists both');
      } finally {
        await page.size(1280, 900);
      }
    },
  );

for (const theme of ['light', 'dark'])
  for (const width of [1280, 375])
    await check(`#72 a room with four agents at ${width} px (${theme}): no overflow, and the facts stay in the conversation’s menu`, async () => {
      await page.size(width, width < 768 ? 812 : 900, { theme });
      try {
        await open(`#/t/${room.id}`);
        const m = await fitted();
        report(`${width} px, ${theme}`, m);
        assert.equal(m.overflow, 0, 'The top bar overflows');
        assert.equal(m.rings.length, 0, 'The top bar has agent rings');
        if (width === 1280) assert.equal(m.drop, '', `The top bar dropped “${m.drop}” at 1280 px`);
        // What it runs with is in the conversation’s menu, as text on screen.
        await page.evaluate(`document.querySelector('header.topbar #conversation-actions').click()`);
        await page.waitFor(`document.querySelector('.menu')`);
        const line = `[...document.querySelectorAll('.menu button.mi')].find((b) => b.innerText.includes('@indexer'))`;
        assert.match((await seen(line)) ?? '', /^@indexer Claude Code · claude-sonnet-5-5 · not the model you set: claude-opus-5-5 · medium effort · idle/);
        assert.ok(await page.evaluate(`${line}.offsetWidth > 0 && ${line}.getBoundingClientRect().right <= innerWidth`), 'The menu line is off screen');
        await closeAll();
      } finally {
        await page.size(1280, 900);
      }
    });

await check('#60 with one agent at 1280 px, its row shows its state, model and effort, and the top bar drops nothing', async () => {
  const dm = Object.values(store.state.threads).find((t) => t.title === 'Index the shelf');
  await open(`#/t/${dm.id}`);
  const m = await fitted();
  report('one agent, 1280 px', m);
  assert.equal(m.drop, '');
  assert.ok(m.titleFull && m.projectFull, 'The title or the project isn’t shown in full');
  assert.equal(await seen(row('indexer')), '@indexer · idle Opus 5.5 · medium effort');
});

await check('#72 the top bar refits when the window changes, and a state word changing doesn’t move it', async () => {
  await open(`#/t/${room.id}`);
  const wide = await fitted();
  assert.equal(wide.drop, '');
  // “· calling tools” is longer than “· idle”; it’s in the sidebar, so the top bar stays as it was.
  const all = ['librarian', 'indexer', 'researcher', 'critic'];
  for (const handle of all) rt.updateSession(sessionOf(handle).id, { state: 'tool', currentStep: 'Working' });
  await page.waitFor(`${seenText(row('indexer'))}?.startsWith('@indexer · calling tools')`, { label: 'the row to say “calling tools”' });
  const busy = await fitted();
  assert.equal(busy.overflow, 0);
  assert.equal(busy.drop, '');
  assert.equal(busy.title, wide.title);
  for (const handle of all) rt.updateSession(sessionOf(handle).id, { state: 'idle', currentStep: '' });
  await page.waitFor(`${seenText(row('indexer'))}?.startsWith('@indexer · idle')`);
  // Narrow, with a title that needs the room, it drops in order, and wide again, it brings everything back.
  await longTitle(async () => {
    await open(`#/t/${room.id}`);
    await page.size(375, 812);
    try {
      const narrow = await fitted();
      report('375 px', narrow);
      assert.equal(narrow.overflow, 0);
      assert.ok(narrow.drop.startsWith('crumb'), `It dropped “${narrow.drop}”, not the project crumb first`);
    } finally {
      await page.size(1280, 900);
    }
    const back = await fitted();
    assert.equal(back.drop, '');
  });
});

await page.close();
await app.close();
await rm(dataDir, { recursive: true, force: true });
await rm(claudeHome, { recursive: true, force: true });
record(!page.logs.length, 'the page logged no errors', page.logs.join('\n'));
finish();
