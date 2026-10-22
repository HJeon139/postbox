// A headless Chrome check of the agent header and card: what each agent runs with (#60), the mock marker, the
// demo banner and the line on installing Claude Code (#12).
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

const PORT = Number(process.env.PB_PORT ?? 4440);
const CHROME_PORT = Number(process.env.PB_CHROME_PORT ?? 9640);

process.env.POSTBOX_BACKENDS = 'mock';
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-header-'));
const claudeHome = await mkdtemp(join(tmpdir(), 'pb-check-header-home-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true, claudeHome });
const page = await launch({ port: CHROME_PORT });
const { rt, store } = app;
const failures = [];

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
const chip = (handle) =>
  `[...document.querySelectorAll('header.topbar .who-chip')].find((c) => c.querySelector('b')?.textContent === ${JSON.stringify(`@${handle}`)})`;
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
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${e.message.split('\n').join('\n        ')}`);
  } finally {
    clearTimeout(timer);
  }
  await closeAll();
}
let loaded = false;
async function open(hash) {
  if (loaded) await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
  else await page.goto(`${app.origin}/${hash}`);
  loaded = true;
  await page.waitFor(`document.querySelector('header.topbar')`);
  await settle();
}

await page.size(1280, 900);

// ── #60: the model that answered and the effort ─────────────────────────────────────────

await check('#60 each chip says the model that answered and the effort, marked in words when the model differs', async () => {
  await open(`#/t/${room.id}`);
  assert.equal(await seen(chip('indexer')), '@indexer · Sonnet 5.5, not Opus 5.5 · medium effort · idle');
  // Before its first turn, the model and effort it’s set to.
  assert.equal(await seen(chip('researcher')), '@researcher · Opus 5.5 · high effort · idle');
  // A mock agent has no model or effort.
  assert.equal(await seen(chip('critic')), '@critic mock · idle');
});

await check('#60 a new last model reaches the chip without a reload', async () => {
  await open(`#/t/${room.id}`);
  rt.updateSession(sessionOf('researcher').id, { lastModel: 'claude-opus-5-5', lastEffort: 'high' });
  await page.waitFor(`${seenText(chip('researcher'))}?.includes('Opus 5.5 · high effort')`);
  rt.updateSession(sessionOf('researcher').id, { lastModel: 'claude-haiku-5-5' });
  await page.waitFor(`${seenText(chip('researcher'))}?.includes('Haiku 5.5, not Opus 5.5')`, { label: 'the changed model in the chip' });
  rt.updateSession(sessionOf('researcher').id, { lastModel: 'claude-opus-5-5' });
});

await check('#60 the card and the menus say it with full model ids', async () => {
  await open('#/');
  const card = (handle) => `document.querySelector('.ov-col[data-key="${sessionOf(handle).id}"] .oc-runs')`;
  await page.waitFor(card('indexer'));
  assert.equal(await seen(card('indexer')), 'Claude Code · claude-sonnet-5-5 · not the model you set: claude-opus-5-5 · medium effort');
  assert.equal(await seen(card('researcher')), 'Agent SDK · claude-opus-5-5 · high effort');
  assert.equal(await seen(card('critic')), 'Mock agent · scripted replies, not a model');
  // The card’s ⋯ menu.
  await page.evaluate(`document.querySelector('.ov-col[data-key="${sessionOf('indexer').id}"] button[aria-haspopup=menu]').click()`);
  await page.waitFor(`document.querySelector('.menu')`);
  assert.match(await seen(`document.querySelector('.menu')`), /not the model you set: claude-opus-5-5/);
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

await check('#12 a mock agent is marked in its chip, rail row, card and speaker line, and a real one isn’t', async () => {
  // A reply each from @critic (mock) and @indexer (Claude Code), so both have speaker lines.
  for (const handle of ['critic', 'indexer']) {
    const se = sessionOf(handle);
    rt.addItem(room.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle, text: `A reply from @${handle}.`, status: 'done' });
  }
  await open(`#/t/${room.id}`);
  assert.equal(await visibleMarker(`${chip('critic')}?.querySelector('.mock-tag')`), true, 'The chip has no visible “mock”');
  assert.equal(await page.evaluate(`!!${chip('indexer')}?.querySelector('.mock-tag')`), false, 'A Claude Code agent’s chip says “mock”');
  // The room’s rail row names all four, and marks the two on the mock.
  assert.equal(await seen(railWho), '@librarian mock, @indexer, @researcher, @critic mock · idle');
  // Speaker lines.
  const speaker = (handle) => `[...document.querySelectorAll('.who')].find((w) => w.querySelector('b')?.textContent === '@${handle}')`;
  await page.waitFor(speaker('critic'));
  assert.equal(await visibleMarker(`${speaker('critic')}.querySelector('.mock-tag')`), true, 'The speaker line has no visible “mock”');
  assert.equal(await page.evaluate(`!!${speaker('indexer')}.querySelector('.mock-tag')`), false);
  // Cards.
  await open('#/');
  const card = (handle) => `document.querySelector('.ov-col[data-key="${sessionOf(handle).id}"]')`;
  await page.waitFor(card('critic'));
  assert.equal(await visibleMarker(`${card('critic')}.querySelector('.oc-name .mock-tag')`), true, 'The card has no visible “mock”');
  assert.equal(await page.evaluate(`${card('critic')}.getAttribute('aria-label')`), '@critic, mock, idle');
  assert.equal(await page.evaluate(`!!${card('indexer')}.querySelector('.mock-tag')`), false);
});

await check('#12 the marker follows the persona: moved to Claude Code, the chip and row lose it without a reload', async () => {
  await open(`#/t/${room.id}`);
  real('librarian', { backend: 'claude-code', model: 'claude-opus-5-5', effort: 'low' });
  // Its session keeps the effort it started with; the model was “mock”, so it runs the default.
  await page.waitFor(`!${chip('librarian')}.querySelector('.mock-tag') && ${seenText(chip('librarian'))}.includes('Opus 5.5')`, {
    label: 'the chip to drop “mock”',
  });
  await page.waitFor(`${seenText(railWho)} === '@librarian, @indexer, @researcher, @critic mock · idle'`, { label: 'the rail row to drop “mock”' });
  real('librarian', { backend: 'mock', model: 'mock' });
  await page.waitFor(`!!${chip('librarian')}.querySelector('.mock-tag')`, { label: 'the chip to say “mock” again' });
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
  await open('#/');
  await page.evaluate(`document.querySelector('.ov-col[data-key="${sessionOf('critic').id}"] button[aria-haspopup=menu]').click()`);
  await page.waitFor(`document.querySelector('.menu')`);
  assert.equal(
    await page.evaluate(
      `!![...document.querySelectorAll('.menu button.mi')].find((b) => b.innerText.includes('Edit @critic persona'))?.querySelector('.mock-tag')`,
    ),
    true,
  );
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
  for (const hash of ['#/', `#/p/${corpus.id}/threads`, `#/t/${room.id}`, '#/archived']) {
    await open(hash);
    assert.equal(await seen(demoNote), DEMO, `No demo banner on ${hash}`);
    assert.equal(await page.evaluate(`!${demoNote}.closest('[aria-live], [role=status], [role=alert], [role=log]')`), true, 'The banner is in a live region');
  }
  // The demo has no install line: Postbox didn’t look for Claude Code.
  await open('#/');
  assert.equal(await page.evaluate(`!!document.querySelector('.install-note')`), false);
});

await check('#12 at 375 px the banner folds to “Demo”, and its whole sentence is still read', async () => {
  await page.size(375, 812);
  try {
    await open('#/');
    // “Demo” on screen; the sentence is visually hidden, so it’s still read.
    const widths = await page.evaluate(
      `[...${demoNote}.children].map((c) => [c.textContent, Math.round(c.getBoundingClientRect().width), c.getAttribute('aria-hidden')])`,
    );
    assert.equal(widths[0][0], DEMO);
    assert.ok(widths[0][1] <= 1, `The sentence is ${widths[0][1]} px wide`);
    assert.equal(widths[1][0], 'Demo');
    assert.ok(widths[1][1] > 10, '“Demo” isn’t on screen');
    assert.equal(await page.evaluate(`${demoNote}.querySelector('.demo-short').getAttribute('aria-hidden')`), 'true');
  } finally {
    await page.size(1280, 900);
  }
});

await check('#12 without --demo there’s no banner, and with Claude Code missing the overview says how to install it', async () => {
  delete process.env.POSTBOX_BACKENDS;
  const was = process.env.POSTBOX_CLAUDE_BIN;
  // A path that doesn’t exist, so Postbox finds no Claude Code. The person’s own install is never run.
  process.env.POSTBOX_CLAUDE_BIN = join(claudeHome, 'no-such-folder', 'claude');
  const freshDir = await mkdtemp(join(tmpdir(), 'pb-check-header-fresh-'));
  const fresh = await start({ port: PORT + 1, dataDir: freshDir, fresh: true, quiet: true, claudeHome });
  try {
    // A fresh install has no projects or conversations.
    Object.assign(fresh.store.state, { projects: {}, threads: {}, sessions: {}, items: {} });
    await page.send('Page.navigate', { url: `${fresh.origin}/#/` });
    await page.waitFor(`document.querySelector('.ov-empty')`, { label: 'the empty overview' });
    assert.equal(await page.evaluate(`!!${demoNote}`), false, 'A demo banner without --demo');
    const line = await seen(`document.querySelector('.install-note')`);
    assert.ok(line, 'No install line on the overview');
    // The Agent SDK loads without Claude Code when it’s installed (npm install), so say what agents run on.
    const sdk = fresh.rt.adapters.names().includes('agent-sdk');
    assert.match(line, sdk ? /so agents run on the Agent SDK or the mock until it is\./ : /so agents run on the mock until it is/);
    assert.match(line, /install Claude Code so claude --version works, or set POSTBOX_CLAUDE_BIN to where it is, then restart Postbox/);
  } finally {
    await page.send('Page.navigate', { url: 'about:blank' });
    await fresh.close();
    await rm(freshDir, { recursive: true, force: true });
    if (was === undefined) delete process.env.POSTBOX_CLAUDE_BIN;
    else process.env.POSTBOX_CLAUDE_BIN = was;
    process.env.POSTBOX_BACKENDS = 'mock';
    loaded = false;
  }
});

await page.close();
await app.close();
await rm(dataDir, { recursive: true, force: true });
await rm(claudeHome, { recursive: true, force: true });
if (page.logs.length) console.log(`\nPage errors:\n  ${page.logs.join('\n  ')}`);
console.log(failures.length ? `\n${failures.length} failed.` : '\nAll header checks passed.');
process.exit(failures.length || page.logs.length ? 1 : 0);
