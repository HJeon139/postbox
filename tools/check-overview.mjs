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

// ── #101: sessions leave the overview with their conversation ───────────────────────────

const menuItem = (text) => `[...document.querySelectorAll('.menu button.mi')].find((b) => b.innerText.includes(${JSON.stringify(text)}))`;
const archivedRow = (id) => `document.querySelector('table.tbl tr[data-thread="${id}"]')`;

await check('#101 Archive conversation on an idle row takes it off the overview; Archived lists it, and Restore brings it back', async () => {
  const t = threadNamed('Catalog tour');
  const se = rt.sessionsIn(t.id)[0];
  await open('#/');
  const more = `document.querySelector('.ov-row[data-key="${t.id}"] button[aria-haspopup=menu]')`;
  await page.waitFor(more);
  await page.evaluate(`${more}.click()`);
  await page.waitFor(menuItem('Archive conversation'));
  await page.evaluate(`${menuItem('Archive conversation')}.click()`);
  await page.waitFor(`!document.querySelector('.ov-row[data-key="${t.id}"]')`, { label: 'the row to leave the overview' });
  assert.equal(store.state.sessions[se.id].archived, true);
  assert.equal(store.state.threads[t.id].archived, true);
  await open('#/archived');
  await page.waitFor(archivedRow(t.id), { label: 'the conversation under Archived' });
  assert.match(await page.evaluate(`${archivedRow(t.id)}.innerText`), /@librarian[\s\S]*Catalog tour/);
  await page.evaluate(`${archivedRow(t.id)}.querySelector('button').click()`);
  await page.waitFor(`!${archivedRow(t.id)}`, { label: 'the row to leave Archived' });
  assert.equal(store.state.sessions[se.id].archived, false);
  await open('#/');
  await page.waitFor(`!!document.querySelector('.ov-row[data-key="${t.id}"]')`, { label: 'the row to come back' });
});

await check('#101 a room archived from its ⋯ takes every agent off the overview, its side thread’s fork too, and comes back whole', async () => {
  const room = threadNamed('Corpus planning');
  const side = rt.createThread({
    projectId: room.projectId,
    title: '@indexer ↔ @researcher',
    kind: 'side',
    parentId: room.id,
    personaIds: [needs[1].personaId],
  });
  const fork = rt.sessionsIn(side.id)[0];
  rt.updateSession(fork.id, { state: 'needs', needs: { kind: 'permission', text: 'Allow Bash?' } });
  const ids = [...rt.sessionsIn(room.id), fork].map((x) => x.id);
  await open('#/');
  await page.waitFor(`!!document.querySelector('.ov-col[data-key="${fork.id}"]') && !!document.querySelector('.ov-col[data-key="${needs[1].id}"]')`);
  await open(`#/t/${room.id}`);
  await page.evaluate(`document.querySelector('header.topbar #conversation-actions').click()`);
  await page.waitFor(menuItem('Archive room'));
  await page.evaluate(`${menuItem('Archive room')}.click()`);
  await page.waitFor(`import('/app/js/client.mjs').then(({ client }) => ${JSON.stringify(ids)}.every((id) => client.state.sessions[id].archived))`, {
    label: 'every agent archived',
  });
  await open('#/');
  for (const id of ids) assert.equal(await page.evaluate(`!!document.querySelector('.ov-col[data-key="${id}"]')`), false, 'An archived agent still has a card');
  assert.equal(await page.evaluate(`!!document.querySelector('.ov-row[data-key="${room.id}"]')`), false);
  await open('#/archived');
  await page.waitFor(archivedRow(room.id));
  const listed = (await page.evaluate(`${archivedRow(room.id)}.innerText`)).match(/@\w+/g).sort();
  assert.deepEqual(listed, ['@indexer', '@indexer', '@researcher'], 'The row doesn’t list the room’s agents and the fork');
  // Restore from the room’s own ⋯.
  await open(`#/t/${room.id}`);
  await page.evaluate(`document.querySelector('header.topbar #conversation-actions').click()`);
  await page.waitFor(menuItem('Restore room'));
  await page.evaluate(`${menuItem('Restore room')}.click()`);
  await page.waitFor(`import('/app/js/client.mjs').then(({ client }) => ${JSON.stringify(ids)}.every((id) => !client.state.sessions[id].archived))`, {
    label: 'every agent restored',
  });
  assert.equal(store.state.threads[room.id].archived, false);
  assert.equal(store.state.threads[side.id].archived, false);
  // Archiving answered nothing; it set the agents idle. @indexer needs you again for the next case.
  rt.updateSession(needs[1].id, { state: 'needs', needs: { kind: 'block', text: 'Which format should the index use?' } });
});

await check('#101 a conversation idle for as long as Settings › Projects says archives itself, and one waiting on you stays', async () => {
  await open('#/');
  await page.evaluate(`document.querySelector('header.topbar button[aria-label="Settings"]').click()`);
  const tab = `[...document.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Projects')`;
  await page.waitFor(tab);
  await page.evaluate(`${tab}.click()`);
  const radio = `[...document.querySelectorAll('[role=radio]')].find((r) => r.textContent === '3 days')`;
  await page.waitFor(`${radio} && [...document.querySelectorAll('[role=radio][aria-checked=true]')].some((r) => r.textContent === '7 days')`, {
    label: '7 days chosen by default',
  });
  await page.evaluate(`${radio}.click()`);
  await page.waitFor(`${radio}.getAttribute('aria-checked') === 'true'`);
  assert.equal(store.state.settings.archiveAfterDays, 3);
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  // Four days on, nothing having happened: every idle conversation goes; the ones waiting on you stay.
  const idle = idleConversations();
  assert.ok(idle.length > 0);
  const gone = rt.archiveIdle(Date.now() + 4 * 864e5);
  assert.deepEqual(gone.sort(), idle);
  for (const se of needs) assert.equal(store.state.sessions[se.id].archived, false, `@${se.handle} needs you and was archived`);
  await open('#/');
  await page.waitFor(`document.querySelectorAll('.ov-row').length === 0 && document.querySelector('.ov-idle').hidden`, { label: 'the rows to go' });
  await open('#/archived');
  for (const id of idle) await page.waitFor(archivedRow(id));
  for (const id of gone) rt.restoreThread(id);
  rt.store.emit('settings', { archiveAfterDays: 7 });
});

await page.close();
await app.close();
await rm(dataDir, { recursive: true, force: true });
finish();
