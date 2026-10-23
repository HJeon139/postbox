// A headless Chrome check of side threads as the person sees them (#121, #110): an agent woken into a side thread
// shows in its conversation (the sidebar’s agent tree, the side-thread line and the conversation’s row) with where it
// is and who woke it; a fork that answered while its session was busy is a second entry under the same persona; one
// waiting on a permission prompt counts in the tab title and ⌃J opens the side thread at its card; /stop in the
// conversation reaches the side thread but not a topic thread; Copy link and the composer’s # link a thread, whose id
// the agent then gets; and at 375 px the side-thread line fits.
//
//   node tools/check-side-threads.mjs
//
// It starts its own server with the demo seed on a fresh data folder, and moves @indexer and @researcher to a fake
// Claude Code backend that holds each turn open until the check lets it go or Stop aborts it, so no real agent runs.
// PB_PORT and PB_CHROME_PORT move it; ONLY=<text> runs only the cases whose names include it.

import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { finish, record } from './harness.mjs';
import {
  app,
  busy,
  check,
  claudeHome,
  dataDir,
  indexer,
  open,
  page,
  press,
  q,
  release,
  researcher,
  room,
  row,
  rt,
  scripts,
  sessionIn,
  settle,
  sideLine,
  sideOf,
  store,
  subs,
  turns,
  type,
  until,
  wake,
} from './side-threads-kit.mjs';

await page.size(1280, 900);

// ── The cases ───────────────────────────────────────────────────────────────────────────

await check('an agent woken into a side thread works in its own session, and the conversation shows it and where', async () => {
  await open(`#/t/${room.id}`);
  wake(indexer.id, 'researcher', 'Check the editions on the shelf.');
  await until(() => busy(researcher.id), '@researcher’s turn');
  const side = sideOf();
  assert.equal(Object.values(store.state.sessions).filter((x) => x.handle === 'researcher' && x.threadId === room.id).length, 1);
  assert.equal(turns.at(-1).sessionId, researcher.id, 'The wake went to another session');
  assert.equal(turns.at(-1).thread, side.id);
  // The agent tree: under @researcher, one line with its state and who it’s with, and a Stop; the thread and who woke
  // it are on hover and in the link’s name.
  await page.waitFor(`${row('researcher')}?.querySelector('.agent-sub')`, { label: 'the tree entry' });
  assert.deepEqual(await subs('researcher'), ['Calling tools with @indexer Stop']);
  const link = `${row('researcher')}.querySelector('.agent-sub a')`;
  assert.equal(await page.evaluate(`${link}.getAttribute('href')`), `#/t/${room.id}/side/${side.id}`);
  assert.equal(await page.evaluate(`${link}.title`), `In the side thread “${side.title}”, woken by @indexer`);
  assert.equal(await page.evaluate(`${link}.getAttribute('aria-label')`), `Calling tools with @indexer, in the side thread “${side.title}”, woken by @indexer`);
  // Its words show whole, wrapped if need be: none of it is only in the tooltip.
  assert.ok(
    await page.evaluate(
      `(() => { const n = ${link}.querySelector('.name'); return n.scrollWidth <= n.clientWidth && n.scrollHeight <= n.clientHeight + 1; })()`,
    ),
    'The entry’s text is cut',
  );
  // The side-thread line, with the ring and state word.
  assert.match(await sideLine(), /@indexer asked @researcher · @researcher is calling tools · 1 message · Open/);
  assert.ok(await page.evaluate(`!![...document.querySelectorAll('#main .pill')].find((p) => p.textContent.includes('asked'))?.querySelector('pb-ring')`));
  // The conversation’s row in the sidebar.
  assert.match(await page.evaluate(`${q(`.rail a.row[data-thread="${room.id}"]`)}.innerText`), /calling tools in a side thread/);
  // Another wake there while it works waits for its turn: no fork, no second @researcher at the same work.
  scripts.set(researcher.id, (ctx) => ctx.text('Dates: 1999 and 2004.'));
  wake(indexer.id, 'researcher', 'And the dates?');
  const here = (x) => x.threadId === room.id || store.state.threads[x.threadId]?.parentId === room.id;
  assert.equal(Object.values(store.state.sessions).filter((x) => x.handle === 'researcher' && here(x)).length, 1);
  assert.equal(rt.turns.get(researcher.id).pending.length, 1);
});

await check('a wake while that session is busy in the conversation goes to a fork of it: a second entry under the persona, with its Stop', async () => {
  // The queued wake runs and ends; then @researcher takes on a long job in the conversation.
  release(researcher.id);
  await until(() => turns.some((t) => t.text === 'And the dates?') && !busy(researcher.id), 'the queued wake');
  rt.sendMessage(room.id, { text: '@researcher start the long job' });
  await until(() => busy(researcher.id) && !store.state.sessions[researcher.id].sideTurn, '@researcher at work in the conversation');
  wake(indexer.id, 'researcher', 'One question meanwhile.');
  const fork = () => Object.values(store.state.sessions).find((x) => x.forkOf?.sessionId === researcher.id && x.forkOf.busy);
  await until(() => fork() && busy(fork().id), 'the fork’s turn');
  await page.waitFor(`${row('researcher')}?.querySelectorAll('.agent-sub').length === 1`, { label: 'the fork’s entry' });
  // The entry can show before the event that names it a fork reaches the page.
  await page.synced(store.state.seq);
  await settle();
  assert.deepEqual(await subs('researcher'), ['Fork · calling tools with @indexer Stop']);
  assert.ok(
    await page.evaluate(`(() => { const n = ${row('researcher')}.querySelector('.agent-sub .name'); return n.scrollWidth <= n.clientWidth; })()`),
    'The fork’s entry is cut',
  );
  assert.equal(await page.evaluate(`${row('researcher')}.querySelectorAll('.agent-sub pb-ring').length`), 1, 'The fork has its own ring');
  // Two sessions of one persona, two entries: its row (at work in the conversation) and the fork.
  assert.match(await page.evaluate(`${row('researcher')}.querySelector('.agent-btn').innerText`), /calling tools/);
});

await check('a side-thread agent waiting on a permission prompt counts in the tab title, and ⌃J opens the side thread at its card', async () => {
  const side = sideOf();
  const fork = Object.values(store.state.sessions).find((x) => x.forkOf?.sessionId === researcher.id);
  // The fork’s next turn asks first; let the current one finish so it starts.
  scripts.set(fork.id, (ctx) => ctx.askPermission({ tool: 'Bash', summary: 'run the indexer' }));
  release(fork.id);
  wake(indexer.id, 'researcher', 'Run the indexer, please.');
  await until(() => store.state.sessions[fork.id].needs?.kind === 'permission', 'the permission prompt');
  const card = store.state.sessions[fork.id].needs.itemId;
  assert.ok(store.item(side.id, card), 'The card isn’t in the side thread');
  await page.waitFor(`document.title.startsWith('(1) ')`, { label: 'the tab title’s count' });
  await page.evaluate(`document.querySelector('#composer-input')?.blur(); document.body.focus()`);
  await press('j', { ctrl: true });
  await page.waitFor(`location.hash === ${JSON.stringify(`#/t/${room.id}/side/${side.id}`)}`, { label: 'the side thread to open' });
  await page.waitFor(`document.activeElement?.closest('[data-key="${card}"]')`, { label: 'focus on the card' });
  rt.act(side.id, card, 'allow');
  await until(() => !store.state.sessions[fork.id].needs, 'the answer');
});

await check('/stop in the conversation stops its agents in side threads, and not a topic thread’s', async () => {
  const fork = Object.values(store.state.sessions).find((x) => x.forkOf?.sessionId === researcher.id);
  // The fork works again, and a topic thread off the conversation has a turn running.
  wake(indexer.id, 'researcher', 'One more pass.');
  await until(() => busy(fork.id) && busy(researcher.id), 'both sessions at work');
  const root = rt.addItem(room.id, {
    kind: 'agent',
    sessionId: indexer.id,
    personaId: indexer.personaId,
    handle: 'indexer',
    text: 'A side topic.',
    status: 'done',
  });
  const topic = store.state.threads[rt.startTopic(room.id, root.id).threadId];
  rt.sendMessage(topic.id, { text: 'Go on here.' });
  const topicSe = rt.sessionsIn(topic.id)[0];
  await until(() => busy(topicSe.id), 'the topic thread’s turn');
  await open(`#/t/${room.id}`);
  await page.evaluate(`document.querySelector('#composer-input').focus()`);
  await type('/stop');
  await press('Enter');
  await until(() => !busy(researcher.id) && !busy(fork.id), 'the side thread’s sessions to stop');
  assert.ok(busy(topicSe.id), 'Stop reached the topic thread');
  rt.stop(topicSe.id);
});

await check('the composer’s # links a side thread, and the agent that gets the message has its id and title', async () => {
  const side = sideOf();
  await until(() => !rt.turns.has(indexer.id) && !rt.exiting.size, 'the stopped turns to exit');
  await open(`#/t/${room.id}`);
  await page.evaluate(`(() => { const ta = document.querySelector('#composer-input'); ta.value = ''; ta.focus(); })()`);
  await type('#');
  await page.waitFor(`${q('#mention-list')}?.getAttribute('aria-label') === 'Threads'`, { label: 'the # menu' });
  assert.match(await page.evaluate(`${q('#mention-list')}.innerText`), /Link a thread[\s\S]*@indexer ↔ @researcher/i);
  await type('indexer');
  await press('Enter');
  const value = await page.evaluate(`document.querySelector('#composer-input').value`);
  assert.equal(value, `[@indexer ↔ @researcher](${app.origin}/#/t/${room.id}/side/${side.id}) `);
  scripts.set(indexer.id, (ctx) => ctx.text('Read it.'));
  await type('@indexer read this');
  await press('Enter');
  await until(() => turns.some((t) => t.sessionId === indexer.id && t.text.includes('read this')), '@indexer’s turn');
  const got = turns.findLast((t) => t.sessionId === indexer.id);
  assert.ok(
    got.context.some((c) => c.includes(`side thread “${side.title}” (thread ${side.id})`) && c.includes('read_conversation')),
    `The message didn’t carry the thread: ${JSON.stringify(got.context)}`,
  );
});

await check('a side thread has Copy link, which gives its whole address', async () => {
  const side = sideOf();
  await open(`#/t/${room.id}/side/${side.id}`);
  const button = `[...document.querySelectorAll('.sidepanel button')].find((b) => b.textContent === 'Copy link')`;
  await page.waitFor(button, { label: 'Copy link' });
  assert.equal(await page.evaluate(`${button}.getAttribute('aria-label')`), 'Copy link to this side thread');
  await page.send('Browser.grantPermissions', { origin: app.origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  // By keyboard: the permission toast from earlier can still cover the panel’s head.
  await page.evaluate(`${button}.focus()`);
  await press('Enter');
  await page.waitFor(`${button.replace("'Copy link'", "'Copied'")}`, { label: 'Copied' });
  assert.equal(await page.evaluate('navigator.clipboard.readText()'), `${app.origin}/#/t/${room.id}/side/${side.id}`);
});

await check('an agent woken from outside the conversation joins it, and its row, its ring and the wake’s line say why', async () => {
  await open(`#/t/${room.id}`);
  wake(indexer.id, 'critic', 'Read the schema, please.');
  const critic = () => sessionIn(room, 'critic');
  await until(() => critic(), '@critic to join');
  assert.equal(Object.values(store.state.sessions).filter((x) => x.handle === 'critic' && x.threadId === room.id).length, 1);
  await page.waitFor(`${row('critic')}?.querySelector('.agent-btn').innerText.includes('Joined when @indexer woke it')`, { label: 'the row’s note' });
  const line = await page.evaluate(
    `[...document.querySelectorAll('#main .sys-line')].map((n) => n.innerText.replace(/\\s+/g, ' ').trim()).find((t) => t.includes('woke @critic')) ?? ''`,
  );
  assert.match(line, /^@indexer woke @critic · joined the conversation · agent wake 1 of 3$/);
  await page.waitFor(`document.getElementById('top-ring-${critic().id}')`, { label: 'its ring in the top bar' });
  assert.equal(await page.evaluate(`document.getElementById('top-ring-${critic().id}').title`), 'Joined when @indexer woke it');
  // The agents the person added say nothing of the kind.
  assert.doesNotMatch(await page.evaluate(`${row('indexer')}.innerText`), /Joined when/);
});

await check('at 375 px, the side-thread line with its agent’s state fits without scrolling sideways', async () => {
  await page.size(375, 812);
  try {
    wake(indexer.id, 'researcher', 'Last look.');
    await until(() => busy(researcher.id), '@researcher’s turn');
    await open(`#/t/${room.id}`);
    await page.waitFor(`[...document.querySelectorAll('#main .pill')].some((p) => p.textContent.includes('is calling tools'))`, {
      label: 'the state on the line',
    });
    assert.ok(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'The page scrolls sideways');
  } finally {
    rt.stop(researcher.id);
    await page.size(1280, 900);
  }
});

await page.close();
await app.close();
await rm(dataDir, { recursive: true, force: true });
await rm(claudeHome, { recursive: true, force: true });
record(!page.logs.length, 'the page logged no errors', page.logs.join('\n'));
finish();
