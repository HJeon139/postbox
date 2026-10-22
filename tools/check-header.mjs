// A headless Chrome check of the agent header and card: what each agent runs with (#60).
//
//   node tools/check-header.mjs
//
// It starts its own server with the demo seed (mock agents) on a fresh data folder in the temp directory, and
// seeds a room with four agents through the runtime: two moved to real backends without running a turn, one of
// them with a last turn answered by a model other than the one set. No agent turn runs. PB_PORT (and the port
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
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); document.querySelector('.menu')?.remove();`);
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
  assert.equal(await seen(chip('critic')), '@critic · idle');
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
    '@librarian Mock agent · scripted replies, not a model · idle',
    '@indexer Claude Code · claude-sonnet-5-5 · not the model you set: claude-opus-5-5 · medium effort · idle',
    '@researcher Agent SDK · claude-opus-5-5 · high effort · idle',
    '@critic Mock agent · scripted replies, not a model · idle',
  ])
    assert.ok(menu.includes(line), `The conversation menu doesn’t say “${line}”:\n${menu}`);
});

await page.close();
await app.close();
await rm(dataDir, { recursive: true, force: true });
await rm(claudeHome, { recursive: true, force: true });
if (page.logs.length) console.log(`\nPage errors:\n  ${page.logs.join('\n  ')}`);
console.log(failures.length ? `\n${failures.length} failed.` : '\nAll header checks passed.');
process.exit(failures.length || page.logs.length ? 1 : 0);
