// A headless Chrome check of the overview: what needs you and what’s working as cards above the fold, and each
// idle conversation as one compact row (#3).
//
//   node tools/check-overview.mjs
//
// It starts its own server with the demo seed (mock agents) on a fresh data folder in the temp directory. PB_PORT
// and PB_CHROME_PORT move it, so sessions working in parallel don’t collide.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { launch } from './cdp.mjs';
import { finish, ports, record } from './harness.mjs';

const { PORT, CHROME_PORT } = await ports(4610, 9810);

process.env.POSTBOX_BACKENDS = 'mock';
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-overview-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true, claudeHome: dataDir });
const page = await launch({ port: CHROME_PORT });
const { rt, store } = app;

const threadNamed = (title) => Object.values(store.state.threads).find((t) => t.title.startsWith(title));
const sessionIn = (title, handle) => rt.sessionsIn(threadNamed(title).id).find((x) => x.handle === handle);

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
}
let loaded = false;
async function open(hash) {
  if (loaded) await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
  else await page.send('Page.navigate', { url: `${app.origin}/${hash}` });
  loaded = true;
  await page.waitFor(`document.querySelector('header.topbar')`);
  await page.synced(store.state.seq);
}

// Like the demo at its end: three agents need you and one is working (#3’s measure). @critic’s conversation has a
// long name, which once wrapped and pushed its card’s footer below its neighbors’.
const schema = threadNamed('Corpus schema spec');
rt.putThread({ ...schema, title: 'Corpus schema spec for every shelf, with the catalog’s fields and their types' });
const needs = [sessionIn('Corpus schema spec', 'critic'), sessionIn('Corpus planning', 'indexer'), sessionIn('Agent memory papers', 'researcher')];
for (const se of needs) rt.updateSession(se.id, { state: 'needs', needs: { kind: 'block', text: 'Which format should the index use?' } });
// Nothing in its tool calls, subagents or agent messages: those sections aren’t shown.
rt.updateSession(needs[0].id, {
  toolCalls: [],
  toolCount: 0,
  subagents: [],
  agentMessages: [],
  currentStep: 'Waiting for you',
  lastMessage: 'The schema draft is ready.',
});
const working = sessionIn('Corpus explorer', 'librarian');
rt.updateSession(working.id, {
  state: 'tool',
  currentStep: 'Searching the corpus',
  startedAt: Date.now(),
  toolCalls: [{ name: 'corpus.search', state: 'running' }],
  toolCount: 1,
});

/** The conversations with no card, each with live agents of its own: what the overview lists as idle rows. */
const idleConversations = () => {
  const s = store.state;
  const carded = new Set(
    Object.values(s.sessions)
      .filter((se) => se.needs || ['think', 'gen', 'tool'].includes(se.state))
      .map((se) => se.threadId),
  );
  return Object.values(s.threads)
    .filter((t) => t.kind === 'thread' || t.kind === 'room')
    .filter((t) => !carded.has(t.id) && t.members.some((id) => s.sessions[id] && !s.sessions[id].archived))
    .map((t) => t.id)
    .sort();
};

await page.size(1280, 900);

await check('#3 what needs you and what’s working fit above the fold at 1280 × 900, and each idle conversation is one compact row', async () => {
  await open('#/');
  await page.waitFor(`document.querySelectorAll('.ov-col').length === 4 && document.querySelectorAll('.ov-row').length > 0`, {
    label: 'four cards and the rows',
  });
  const m = await page.evaluate(`JSON.stringify({
    cards: [...document.querySelectorAll('.ov-col')].map((c) => ({ key: c.dataset.key, bottom: Math.round(c.getBoundingClientRect().bottom) })),
    rows: [...document.querySelectorAll('.ov-row')].map((r) => ({ key: r.dataset.key, height: Math.round(r.getBoundingClientRect().height) })),
    fold: innerHeight,
    height: document.querySelector('main.ov').scrollHeight,
  })`);
  const { cards, rows, fold, height } = JSON.parse(m);
  console.log(
    `  overview: ${cards.length} cards, ${rows.length} rows, ${height} px tall; the lowest card ends at ${Math.max(...cards.map((c) => c.bottom))} px`,
  );
  assert.deepEqual(cards.map((c) => c.key).sort(), [...needs, working].map((se) => se.id).sort());
  for (const c of cards) assert.ok(c.bottom <= fold, `A card ends at ${c.bottom} px, below the fold at ${fold} px`);
  assert.deepEqual(rows.map((r) => r.key).sort(), idleConversations());
  for (const r of rows) assert.ok(r.height <= 64, `A row is ${r.height} px tall`);
  // What needs you comes first.
  assert.equal(cards.at(-1).key, working.id);
});

await check('#3 cards leave out empty sections, never write nothing three ways, and don’t repeat the state', async () => {
  await open('#/');
  const card = (se) => `document.querySelector('.ov-col[data-key="${se.id}"]')`;
  await page.waitFor(`${card(needs[0])} && ${card(working)}`);
  const labels = (se) => page.evaluate(`[...${card(se)}.querySelectorAll('.oc-sec > .label')].map((l) => l.textContent.trim().split(/\\s/)[0])`);
  // “Waiting for you” only repeats “Needs you”, and its tool calls, subagents and agent messages are empty.
  assert.deepEqual(await labels(needs[0]), ['Needs', 'Last']);
  // A working agent’s step says what it’s doing.
  assert.ok((await labels(working)).includes('Current'));
  assert.match(await page.evaluate(`${card(working)}.innerText`), /Searching the corpus/);
  const text = await page.evaluate(`[...document.querySelectorAll('.ov-col .oc-sec')].map((s) => s.innerText).join('\\n')`);
  assert.doesNotMatch(text, /None yet|^—$|\bNone\b/m);
});

await check('#3 the cards in a row line up: as tall as each other, the stats along the bottom, the conversation on one line', async () => {
  await open('#/');
  const m = JSON.parse(
    await page.evaluate(`JSON.stringify([...document.querySelectorAll('.ov-col')].map((c) => {
      const b = c.getBoundingClientRect(), where = c.querySelector('.oc-where');
      return { top: Math.round(b.top), height: Math.round(b.height), stats: Math.round(c.querySelector('.stats').getBoundingClientRect().top),
        where: where.getClientRects().length, whereHeight: where.getBoundingClientRect().height, text: where.textContent };
    }))`),
  );
  const tops = new Set(m.map((c) => c.top));
  for (const top of tops) {
    const row = m.filter((c) => c.top === top);
    assert.equal(new Set(row.map((c) => c.height)).size, 1, `Cards in a row differ in height: ${row.map((c) => c.height)}`);
    assert.equal(new Set(row.map((c) => c.stats)).size, 1, `Stats in a row don’t line up: ${row.map((c) => c.stats)}`);
  }
  const long = m.find((c) => c.text.includes('catalog’s fields'));
  assert.ok(long, 'The long conversation name isn’t on its card');
  assert.ok(long.text.endsWith('their types'), 'The card cuts the name itself, not just how it shows');
  assert.ok(long.whereHeight < 24, `The conversation name takes ${long.whereHeight} px, more than a line`);
});

await check('#3 an idle row opens its conversation, and a card whose agent goes idle becomes a row', async () => {
  await open('#/');
  const first = await page.evaluate(`document.querySelector('.ov-row')?.dataset.key`);
  await page.evaluate(`document.querySelector('.ov-row a.ov-row-link').click()`);
  await page.waitFor(`location.hash === ${JSON.stringify(`#/t/${first}`)}`, { label: 'the row to open its conversation' });
  await open('#/');
  rt.updateSession(working.id, { state: 'idle', currentStep: '', toolCalls: [], finishedAt: Date.now() });
  const conv = threadNamed('Corpus explorer').id;
  await page.waitFor(`!document.querySelector('.ov-col[data-key="${working.id}"]') && !!document.querySelector('.ov-row[data-key="${conv}"]')`, {
    label: 'the card to become a row',
  });
  // The newest idle conversation is the first row.
  assert.equal(await page.evaluate(`document.querySelector('.ov-row').dataset.key`), conv);
});

await check('#3 at 375 px the rows fit the window', async () => {
  await page.size(375, 812);
  try {
    await open('#/');
    await page.waitFor(`document.querySelectorAll('.ov-row').length > 0`);
    const over = await page.evaluate(`document.documentElement.scrollWidth - innerWidth`);
    assert.equal(over, 0, `The overview is ${over} px wider than the window`);
  } finally {
    await page.size(1280, 900);
  }
});

await page.close();
await app.close();
await rm(dataDir, { recursive: true, force: true });
finish();
