// A headless Chrome check of side threads as the person sees them (#121, #110): an agent woken into a side thread shows
// in its conversation (its agent tree, the side-thread line and the conversation’s row) with where it is and who woke
// it; a wake while it’s busy waits in the side thread’s queue, with no fork (#228); one waiting on a permission prompt
// counts in the tab title and ⌃J opens its card; /stop in the conversation reaches the side thread, not a topic thread;
// a wake for one outside the conversation brings a card, and Add joins it (#228); Copy link and the composer’s # link a
// thread, whose id the agent then gets; the Threads page lists side threads (#124); Send to conversation and
// bring_to_conversation (#128); a failed turn’s line, with Retry (#151); and at 375 px the side-thread line fits.
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
  assert.equal(sideOf().queue.length, 1);
});

await check('a wake while that session is busy in the conversation waits for its turn: no fork, and no second entry (#228)', async () => {
  // The queued wake runs and ends; then @researcher takes on a long job in the conversation.
  release(researcher.id);
  await until(() => turns.some((t) => t.text === 'And the dates?') && !busy(researcher.id), 'the queued wake');
  rt.sendMessage(room.id, { text: '@researcher start the long job' });
  await until(() => busy(researcher.id) && !store.state.sessions[researcher.id].sideTurn, '@researcher at work in the conversation');
  const r = wake(indexer.id, 'researcher', 'One question meanwhile.');
  assert.match(r.message, /it’s busy, so it answers when its current turn ends/);
  assert.equal(Object.values(store.state.sessions).filter((x) => x.forkOf?.sessionId === researcher.id).length, 0, 'A fork answered');
  await open(`#/t/${room.id}/side/${sideOf().id}`); // it waits in the side thread’s queue, as the agent’s message
  const queued = `document.querySelector('.sidepanel .queued')`;
  await page.waitFor(`${queued}?.innerText.includes('@indexer’s message · waits for @researcher to finish')`, { label: 'the queued wake' });
  assert.equal(await page.evaluate(`[...${queued}.querySelectorAll('button')].some((b) => b.textContent === 'Edit')`), false, 'A wake can be edited');
  await page.synced(store.state.seq);
  await settle();
  assert.deepEqual(await subs('researcher'), [], 'Its row has an entry of its own');
  assert.match(await page.evaluate(`${row('researcher')}.querySelector('.agent-btn').innerText`), /calling tools/);
});

await check('a side-thread agent waiting on a permission prompt counts in the tab title, and ⌃J opens the side thread at its card', async () => {
  const side = sideOf();
  // The long job ends, and the wake that waited for it asks first.
  scripts.set(researcher.id, (ctx) => ctx.askPermission({ tool: 'Bash', summary: 'run the indexer' }));
  release(researcher.id);
  await until(() => store.state.sessions[researcher.id].needs?.kind === 'permission', 'the permission prompt');
  const card = store.state.sessions[researcher.id].needs.itemId;
  assert.ok(store.item(side.id, card), 'The card isn’t in the side thread');
  await page.waitFor(`document.title.startsWith('(1) ')`, { label: 'the tab title’s count' });
  await page.evaluate(`document.querySelector('#composer-input')?.blur(); document.body.focus()`);
  await press('j', { ctrl: true });
  await page.waitFor(`location.hash === ${JSON.stringify(`#/t/${room.id}/side/${side.id}`)}`, { label: 'the side thread to open' });
  await page.waitFor(`document.activeElement?.closest('[data-key="${card}"]')`, { label: 'focus on the card' });
  rt.act(side.id, card, 'allow');
  await until(() => !store.state.sessions[researcher.id].needs, 'the answer');
});

await check('/stop in the conversation stops its agents in side threads, and not a topic thread’s', async () => {
  // @researcher works in the side thread again, and a topic thread off the conversation has a turn running.
  await until(() => !rt.turns.has(researcher.id) && !rt.exiting.has(researcher.id), 'the answered turn to end');
  wake(indexer.id, 'researcher', 'One more pass.');
  await until(() => busy(researcher.id) && store.state.sessions[researcher.id].sideTurn, '@researcher at work in the side thread');
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
  // Its agent answers there from its one session in the conversation (#228).
  const topicSe = indexer;
  await until(() => busy(topicSe.id), 'the topic thread’s turn');
  await open(`#/t/${room.id}`);
  await page.evaluate(`document.querySelector('#composer-input').focus()`);
  await type('/stop');
  await press('Enter');
  await until(() => !busy(researcher.id), 'the side thread’s session to stop');
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

await check('an agent that wakes one from outside the conversation brings a card; Add joins it with a note on its row (#228)', async () => {
  await open(`#/t/${room.id}`);
  const critic = () => sessionIn(room, 'critic');
  const before = Object.keys(store.state.sessions).length;
  assert.equal(wake(indexer.id, 'critic', 'Read the schema, please.').waiting, true);
  assert.equal(Object.keys(store.state.sessions).length, before, 'The wake made a session');
  const card = store.items(room.id).find((x) => x.kind === 'hop' && x.join && x.status === 'open');
  const add = `[...document.querySelectorAll('#main [data-key="${card.id}"] button')].find((b) => b.textContent === 'Add @critic')`;
  await page.waitFor(add, { label: 'the card’s Add' });
  assert.match(await page.evaluate(`document.querySelector('#main [data-key="${card.id}"]').innerText`), /Add @critic to this conversation\?/);
  await page.evaluate(`${add}.click()`);
  await until(() => critic(), '@critic to join');
  const why = 'Joined when @indexer woke it';
  await page.waitFor(`${row('critic')}?.querySelector('.agent-btn').innerText.includes('${why}')`, { label: 'the row’s note' });
  await page.waitFor(`document.getElementById('top-ring-${critic().id}')`, { label: 'its ring in the top bar' });
  assert.equal(await page.evaluate(`document.getElementById('top-ring-${critic().id}').title`), why);
  // The agents the person added say nothing of the kind.
  assert.doesNotMatch(await page.evaluate(`${row('indexer')}.innerText`), /Joined when/);
  // The mock @critic’s reply can ask something, which would take the side-thread line in the cases after this one.
  await until(() => !rt.turns.has(critic().id), '@critic’s turn to end');
  rt.archive(critic().id);
});

await check('the Threads page lists side threads beside topic threads, with their pair, state, count and last activity (#124)', async () => {
  const side = sideOf();
  const link = store.items(room.id).find((x) => x.kind === 'sidelink' && x.sideThreadId === side.id);
  await open(`#/p/${room.projectId}/threads`);
  const cards = () =>
    page.evaluate(
      `[...document.querySelectorAll('.thread-list li')].map((li) => ({ kind: li.dataset.kind, text: li.innerText.replace(/\\s+/g, ' ').trim(), href: li.querySelector('a').getAttribute('href') }))`,
    );
  const card = (await cards()).find((c) => c.kind === 'side' && c.text.startsWith(side.title));
  assert.ok(card, 'No card for the side thread');
  assert.match(card.text, new RegExp(`^${side.title} Side thread · in Side checks · ${link.count} messages · (idle|@\\w+ [a-z ]+) · `));
  assert.equal(card.href, `#/t/${room.id}/side/${side.id}`);
  // A topic thread says which kind it is too.
  assert.ok(
    (await cards()).some((c) => c.kind === 'topic' && / Topic thread · in /.test(c.text)),
    'No topic thread says its kind',
  );
});

await check('a side-thread message goes to the conversation by Send to conversation, or by an agent the person asked (#128)', async () => {
  const side = sideOf();
  // The person asks an agent in the side thread, and it posts it with bring_to_conversation.
  scripts.set(researcher.id, (ctx) => {
    ctx.tools.bring_to_conversation({ text: 'The editions, for the main chat.' });
    ctx.text('Posted it in the conversation.');
  });
  release(researcher.id);
  await until(() => !busy(researcher.id), '@researcher to be free');
  rt.sendMessage(side.id, { text: '@researcher post the editions in the main chat' });
  await until(() => store.items(room.id).some((x) => x.kind === 'shared' && x.agent), 'the agent’s post');
  await until(() => !busy(researcher.id), '@researcher’s turn to end');
  const reply = store.items(side.id).findLast((x) => x.kind === 'agent' && x.handle === 'researcher' && x.text && !x.sharedAt);
  await open(`#/t/${room.id}/side/${side.id}`);
  const button = `[...document.querySelectorAll('.sidepanel [data-key="${reply.id}"] button')].find((b) => b.textContent === 'Send to conversation')`;
  await page.waitFor(button, { label: 'Send to conversation on the side thread’s reply' });
  await page.evaluate(`${button}.click()`);
  await until(() => store.items(room.id).some((x) => x.kind === 'shared' && !x.agent && x.text === reply.text), 'the reply in the conversation');
  await page.synced(store.state.seq);
  await page.waitFor(`document.querySelector('.sidepanel [data-key="${reply.id}"]')?.innerText.includes('Sent to the conversation')`, { label: 'Sent' });
  const cards = await page.evaluate(`[...document.querySelectorAll('#main .shared-head')].map((n) => n.innerText.replace(/\\s+/g, ' ').trim())`);
  assert.ok(cards.includes(`From the thread “${side.title}” · shared by @researcher in a turn you started Open thread`), cards.join('\n'));
  assert.ok(cards.includes(`From the thread “${side.title}” · @researcher Open thread`), cards.join('\n'));
});

await check('a failed side-thread turn shows on its line with Retry, and the line’s Open goes to its card (#151)', async () => {
  release(researcher.id);
  await until(() => !busy(researcher.id), '@researcher to be free');
  const side = sideOf();
  scripts.set(researcher.id, async () => {
    throw new Error('API 500');
  });
  wake(indexer.id, 'researcher', 'Review the plan.');
  await until(() => store.state.sessions[researcher.id].state === 'failed', 'the failed turn');
  const card = store.state.sessions[researcher.id].needs;
  assert.equal(card.threadId, side.id);
  await open(`#/t/${room.id}`);
  const line = `[...document.querySelectorAll('#main [data-side-sig]')].find((n) => n.querySelector('.pill')?.textContent.includes('@researcher failed'))`;
  await page.waitFor(line, { label: 'the failure on the side-thread line' });
  assert.equal(await page.evaluate(`${line}.querySelector('button')?.textContent`), 'Retry');
  // It counts as needing you, in the tab title.
  assert.match(await page.evaluate('document.title'), /^\(\d+\) /);
  // Open goes to the side thread, at the card, with its Retry focused.
  await page.evaluate(`${line}.querySelector('.pill').click()`);
  await page.waitFor(`document.activeElement?.closest('[data-key="${card.itemId}"]')`, { label: 'focus on the failed card' });
  assert.ok(await page.evaluate(`!!document.activeElement.closest('.sidepanel')`));
  // Retry on the line answers the wake again.
  await open(`#/t/${room.id}`);
  await page.waitFor(line, { label: 'the line again' });
  const before = turns.length;
  await page.evaluate(`${line}.querySelector('button').click()`);
  await until(() => turns.length > before && busy(researcher.id), 'the retried turn');
  assert.deepEqual([turns.at(-1).sessionId, turns.at(-1).thread, turns.at(-1).text], [researcher.id, side.id, 'Review the plan.']);
  release(researcher.id);
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
