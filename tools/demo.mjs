// The demo: walks through every block type and every error state with the mock agent, using only
// Postbox’s public API. Run it and watch in a browser:
//
//   node tools/demo.mjs            starts a fresh Postbox in demo mode on port 4173 and plays every scene
//   node tools/demo.mjs --port 4280 --speed 0.4
//
// Agent apps are checked in the browser before they’re shown, so keep the page open while it plays.
// tools/shoot-app.mjs imports these scenes and screenshots each one.

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function client(origin) {
  const call = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const r = await fetch(origin + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${path}: ${data.error ?? r.status}`);
    return data;
  };
  const state = async () => (await call('/api/state')).state;
  const until = async (fn, { timeout = 30000, label = 'the next step' } = {}) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const s = await state();
      const v = fn(s);
      if (v) return v;
      await sleep(200);
    }
    const st = await state();
    const apps = Object.values(st.apps)
      .map((x) => `${x.id} v${x.current} ${x.check.status}${x.check.problems.length ? ' (' + x.check.problems.map((p) => p.code).join(', ') + ')' : ''}`)
      .join('; ');
    throw new Error(`Timed out waiting for ${label}.${apps ? ` Apps: ${apps}.` : ''}`);
  };
  const thread = (s, title) => Object.values(s.threads).find((t) => t.title === title);
  const items = (s, t) => s.items[t.id] ?? [];
  const session = (s, t, handle) => (t.members ?? []).map((id) => s.sessions[id]).find((x) => x?.handle === handle);
  const idle = (s, t) => (t.members ?? []).every((id) => !['think', 'gen', 'tool'].includes(s.sessions[id]?.state));
  return { call, state, until, thread, items, session, idle };
}

/**
 * The scenes, in order. Each calls view(hash) when the page should show a thread, and shot(name, opts)
 * when the screen is ready. opts.prepare(page) can open a menu or pin a hover card first.
 */
export async function play({ origin, view = async () => {}, shot = async () => {}, log = console.log, speed = 0.35 }) {
  const c = client(origin);
  const { call, until } = c;
  const setSpeed = (v) => call('/api/demo/speed', { speed: v }).catch(() => {});
  await setSpeed(speed);
  let s = await c.state();
  const T = (title) => c.thread(s, title);
  const send = (t, text) => call(`/api/threads/${t.id}/messages`, { text });
  const settled = (t, extra = () => true, label) =>
    until((st) => c.idle(st, st.threads[t.id]) && extra(st) && st, { label: label ?? `${t.title} to finish`, timeout: 60000 });
  const act = (t, itemId, action, values = {}) => call(`/api/threads/${t.id}/items/${itemId}/act`, { action, values });
  const find = (st, t, pred) => c.items(st, st.threads[t.id]).find(pred);

  // 1 · An empty thread
  const explorer = T('Corpus explorer');
  log('Empty thread: a welcome and example prompts.');
  await view(`#/t/${explorer.id}`);
  await shot('02-empty');

  // 2 · An agent-written app: the corpus explorer
  log('@librarian writes the corpus explorer; Postbox checks it, then shows it.');
  await send(explorer, 'Build me an explorer for my corpus');
  await until((st) => st.apps['corpus-explorer']?.check.status === 'passed', { label: 'the explorer to pass its check', timeout: 25000 });
  const hits = (await call('/api/apps/corpus-explorer/query', { tool: 'corpus.search', args: { query: 'hope after loss', k: 4 } })).result;
  await call('/api/apps/corpus-explorer/state', {
    state: {
      q: 'hope after loss',
      mode: 'both',
      picked: Object.fromEntries(hits.slice(0, 3).map((h) => [h.id, { title: h.title, chapter: h.chapter }])),
      year: '',
    },
  });
  await call('/api/apps/corpus-explorer/event', {
    action: 'use-passages',
    values: { passages: hits.slice(0, 3).map((h) => h.id), summary: `3 passages · ${[...new Set(hits.slice(0, 3).map((h) => h.title))].join(', ')}` },
  });
  await settled(explorer, (st) => st.apps['corpus-explorer']?.current === 2 && st.apps['corpus-explorer'].check.status === 'passed', 'v2 of the explorer');
  await shot('04-corpus-app');

  // 3 · Every catalog block, with one already answered
  const tour = T('Catalog tour');
  log('@librarian sends one of each catalog block.');
  await view(`#/t/${tour.id}`);
  await send(tour, 'Show me every kind of block you can send');
  s = await settled(
    tour,
    (st) => find(st, tour, (i) => i.valid && i.block.id === 'title-pages')?.block.steps.every((x) => x.state !== 'running' && x.state !== 'pending'),
    'the catalog tour',
  );
  await act(tour, find(s, tour, (i) => i.valid && i.block.id === 'start-book').id, 'choose', { selected: ['walden'] });
  await settled(tour);
  await shot('06-catalog');

  // 4 · An explainer: citations, a diagram, math, a glossary term and a practice app
  const react = T('ReAct, step by step');
  log('@researcher explains ReAct with sources, a diagram, math and an exercise.');
  await view(`#/t/${react.id}`);
  await send(react, 'Explain ReAct with something I can try');
  await until(
    (st) => st.apps['react-practice']?.check.status === 'passed' && st.glossary[react.id]?.['observation-budget'] && c.idle(st, st.threads[react.id]),
    { label: 'the explainer', timeout: 60000 },
  );
  await shot('05-explainer', {
    prepare: async (page) => {
      await page.evaluate(
        `(() => { const c = document.querySelector('.cite'); c.scrollIntoView({ block: 'center' }); c.focus(); c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`,
      );
      await sleep(400);
    },
  });

  // 4b · A narrated walkthrough: slides that follow a local voice, with the transcript always there
  const st4 = await c.state();
  const researcherId = st4.sessions[st4.threads[react.id].members[0]].personaId;
  const walk = await call('/api/threads', { projectId: react.projectId, title: 'ReAct, out loud', personaIds: [researcherId] });
  log('@researcher turns the explainer into a narrated walkthrough.');
  await view(`#/t/${walk.id}`);
  await send(walk, 'Walk me through ReAct, out loud');
  await until((st) => st.apps['react-walkthrough']?.check.status === 'passed' && c.idle(st, st.threads[walk.id]), { label: 'the walkthrough', timeout: 60000 });
  await shot('16-narration');

  // 4c · A topic thread: a side question forks @researcher’s session at its message, and comes back as a summary
  log('You reply in a thread to @researcher’s explainer; it answers there, then summarizes back.');
  const st4c = await c.state();
  const rootMsg = c.items(st4c, st4c.threads[react.id]).find((i) => i.kind === 'agent' && i.text);
  const { threadId: topicId } = await call(`/api/threads/${react.id}/items/${rootMsg.id}/topic`, {});
  const topic = { id: topicId, title: 'the thread' };
  await view(`#/t/${react.id}/side/${topicId}`);
  await send(topic, 'Why does the observation step matter so much?');
  await settled(topic);
  await call(`/api/threads/${topicId}/summarize`, {});
  await settled(topic, (st) => find(st, react, (i) => i.kind === 'shared'), 'the summary');
  await shot('18-topic-thread', {
    prepare: async (page) => {
      await page.evaluate(`document.querySelector('.shared-card')?.scrollIntoView({ block: 'center' })`);
      await sleep(200);
    },
  });
  await view(`#/p/${react.projectId}/threads`);
  await shot('19-threads');

  // 5 · Review: comments, a verdict, then a revision shown as a diff
  const spec = T('Corpus schema spec');
  log('@critic asks for a review; you comment and request changes; it revises in place.');
  await view(`#/t/${spec.id}`);
  await send(spec, 'Review my corpus schema line by line');
  s = await settled(
    spec,
    (st) => find(st, spec, (i) => i.valid && i.block.id === 'layout-review') && st.apps['layout-proposal']?.check.status === 'passed',
    'the review blocks',
  );
  await act(spec, find(s, spec, (i) => i.valid && i.block.id === 'schema-review').id, 'submit', {
    verdict: 'request_changes',
    comments: [
      { line: 5, text: 'Per chapter is too coarse for search. Can we go per passage?' },
      { line: 6, text: 'No overlap will cut sentences in half.' },
      { line: 10, text: 'Plain text has no pages. Store offsets instead?' },
      { line: 13, text: 'Should we tune `k1` for short passages?' },
    ],
  });
  await settled(spec, (st) => find(st, spec, (i) => i.valid && i.block.id === 'schema-review')?.block.revision === 2, 'the revision');
  await shot('07-review');

  // 6 · A conversation in progress: two agents, a streaming reply, subagents, a compaction, a queued message
  const room = T('Corpus planning');
  log('In a room, @indexer indexes the shelf while @researcher waits; you queue a message.');
  await view(`#/t/${room.id}`);
  await send(room, 'Before we embed anything, @researcher which editions are we indexing?');
  await settled(room);
  await setSpeed(1.2);
  await send(room, '@indexer go ahead: lexical index first, then embeddings.');
  await until((st) => find(st, room, (i) => i.kind === 'system' && i.variant === 'compaction'), { label: 'the compaction', timeout: 60000 });
  await send(room, 'Also drop the illustration captions.');
  await shot('03-thread');
  await setSpeed(speed);
  await settled(room, () => true, 'the indexing run');

  // 7 · Wakes: agents waking each other, the limit, a side thread and a scheduled wake-up
  log('@indexer and @researcher wake each other until the limit asks you; @indexer schedules a wake-up.');
  await send(room, '@indexer remind me later about the embedding run');
  await settled(room);
  await send(room, '@indexer check the editions with the researcher, in a loop');
  s = await until((st) => find(st, room, (i) => i.kind === 'hop' && i.status === 'open') && st, { label: 'the wake limit', timeout: 60000 });
  const side = Object.values(s.threads).find((t) => t.parentId === room.id);
  await view(`#/t/${room.id}/side/${side.id}`);
  await shot('08-wakes');

  // 8 · Errors: a failed reply, a stopped reply, blocks that can’t be shown, a crashed app, reconnecting
  const index = T('Index the shelf');
  log('@indexer fails, gets stopped, sends blocks Postbox can’t show, and writes an app that crashes.');
  await view(`#/t/${index.id}`);
  await send(index, 'Rebuild without the prefaces');
  await settled(index);
  await setSpeed(1);
  await send(index, 'Index the shelf');
  await sleep(1800);
  const ix = (await c.state()).threads[index.id].members.map((id) => s.sessions[id] ?? null).filter(Boolean)[0];
  await call(`/api/sessions/${ix.id}/stop`, {});
  await setSpeed(speed);
  await send(index, 'Show it as a timeline');
  await settled(index);
  await send(index, 'Show me the shelf map');
  await until((st) => st.apps['shelf-map']?.check.status === 'crashed', { label: 'the crashed app', timeout: 60000 });
  await call('/api/demo/offline', { ms: 60000 }).catch(() => {});
  await sleep(2500);
  await shot('09-errors');
  await call('/api/demo/offline', { ms: 1 }).catch(() => {});
  await sleep(3000);

  // 9 · A proposed teammate, the + menu and attachments
  const quotes = await call('/api/threads', { projectId: index.projectId, title: 'Check my quotes', personaIds: [ix.personaId] });
  log('@indexer proposes a teammate with a tool it doesn’t have.');
  await view(`#/t/${quotes.id}`);
  await send(quotes, 'Can you double-check that the quotes in my notes match the books?');
  await settled(quotes, (st) => find(st, quotes, (i) => i.kind === 'proposal'), 'the proposal');
  await shot('10-plus-menu', {
    prepare: async (page) => {
      await page.attach?.('README.md');
      await page.evaluate(
        `(() => { const t = document.getElementById('composer-input'); t.value = 'Here are my notes, check these three quotes'; t.dispatchEvent(new Event('input')); document.querySelector('[aria-label="Add a file or a new agent"]').click(); })()`,
      );
      await sleep(300);
    },
  });
  await shot('11-new-agent', {
    prepare: async (page) => {
      await page.evaluate(`document.querySelector('[aria-label="Add a file or a new agent"]').click()`);
      await sleep(200);
      await page.evaluate(`[...document.querySelectorAll('.menu .mi')].find((b) => b.textContent.includes('From a boilerplate')).click()`);
      await sleep(300);
      await page.evaluate(`(() => { const i = document.getElementById('na-h'); i.value = 'citer'; i.dispatchEvent(new Event('input')); })()`);
    },
  });

  // 10 · Permission: the agent asks before it runs a command, and waits for you
  const cache = await call('/api/threads', { projectId: index.projectId, title: 'Clear the index cache', personaIds: [ix.personaId] });
  log('@indexer asks before it runs a command; you allow it.');
  await view(`#/t/${cache.id}`);
  await send(cache, 'Clear the old index cache');
  const ask = await until((st) => find(st, cache, (i) => i.kind === 'permission' && i.status === 'open'), { label: 'the permission card' });
  await shot('15-permission');
  await call(`/api/threads/${cache.id}/items/${ask.id}/act`, { action: 'allow' });
  await settled(cache);

  // 11 · A dashboard that fails its check at phone width, gets fixed, then shows
  const dash = await call('/api/threads', { projectId: index.projectId, title: 'Corpus dashboard', personaIds: [ix.personaId] });
  log('@indexer writes a dashboard; the check finds it too wide for a phone; @indexer fixes it.');
  await view(`#/t/${dash.id}`);
  await send(dash, 'Show me a dashboard');
  await until((st) => st.apps['corpus-dashboard']?.current === 2 && st.apps['corpus-dashboard'].check.status === 'passed', {
    label: 'the fixed dashboard',
    timeout: 60000,
  });
  await settled(dash);
  await shot('14-charts');

  // 12 · The overview, with one agent that needs you
  const papers = T('Agent memory papers');
  log('@researcher asks which papers to read, so it needs you; the overview shows it first.');
  await send(papers, 'Which agent memory papers should I read?');
  await settled(papers, (st) => Object.values(st.sessions).some((x) => x.threadId === papers.id && x.needs), 'the choice');
  const archived = (await c.state()).threads[quotes.id].members[0];
  await call(`/api/sessions/${archived}/archive`, {});
  await view('#/');
  await shot('01-overview');
  await shot('12-card-menu', {
    prepare: async (page) => {
      await page.evaluate(
        `[...document.querySelectorAll('.ov-col')].find((n) => n.textContent.includes('@critic')).querySelector('[aria-haspopup="menu"]').click()`,
      );
      await sleep(250);
    },
  });
  await shot('13-delete-confirm', {
    prepare: async (page) => {
      await page.evaluate(
        `[...document.querySelectorAll('.ov-col')].find((n) => n.textContent.includes('@critic')).querySelector('[aria-haspopup="menu"]').click()`,
      );
      await sleep(200);
      await page.evaluate(`[...document.querySelectorAll('.menu .mi')].find((b) => b.textContent.includes('Delete session')).click()`);
      await sleep(250);
    },
  });
  log('Done. Every block type and every error state has been shown.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > -1 ? process.argv[i + 1] : d;
  };
  const port = Number(arg('port', 4173));
  const { start } = await import('../server/index.mjs');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const app = await start({ port, dataDir: join(root, 'data', 'demo'), fresh: true, demo: true });
  const origin = `http://127.0.0.1:${port}`;
  console.log(`\nOpen ${origin}/ in a browser and keep it open: apps are checked there before they’re shown.\n`);
  await sleep(4000);
  try {
    await play({
      origin,
      speed: Number(arg('speed', 0.6)),
      view: async (hash) => {
        console.log(`  → ${origin}/${hash}`);
        await sleep(1500);
      },
      shot: async (name) => {
        console.log(`  ✓ ${name}`);
        await sleep(2500);
      },
    });
  } catch (e) {
    console.error(`The demo stopped: ${e.message}`);
  }
  console.log('\nThe demo server keeps running so you can look around. Press Ctrl+C to stop it.');
  process.on('SIGINT', async () => {
    await app.close();
    process.exit(0);
  });
}
