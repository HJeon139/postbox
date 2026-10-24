// A headless Chrome check of Summarize back in a side thread (#225), by keyboard: the panel’s Summarize back opens a
// menu of the thread’s two agents, the one that started it first; the agent picked writes the summary in the side
// thread, and it’s posted in the conversation as a summary from that thread. Its @-mention of the other agent wakes
// no one, and the wake limit doesn’t move. Asked while that agent is busy in the side thread, it waits behind that turn,
// and the button waits until the summary is posted; asked while its stopped turn’s process is still exiting, it waits
// after a reload too.
//
//   node tools/checks/side-summary.mjs
//
// It uses tools/side-threads-kit.mjs: its own server with the demo seed on a fresh data folder, and @indexer and
// @researcher on a fake Claude Code backend whose turns the check scripts. PB_PORT and PB_CHROME_PORT move it.

import { rm } from 'node:fs/promises';
import { finish, record } from '../harness.mjs';
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
  release,
  researcher,
  room,
  rt,
  scripts,
  settle,
  sideOf,
  store,
  turns,
  until,
  wake,
} from '../side-threads-kit.mjs';

await page.size(1280, 900);
const BUTTON = `[...document.querySelectorAll('.sidepanel .sp-head button')].find((b) => b.textContent === 'Summarize back')`;
const idle = () => until(() => !rt.turns.size && !rt.exiting.size, 'the agents to finish');
const expect = (ok, what) => {
  if (!ok) throw new Error(what);
};

await check('#225 Summarize back in a side thread: pick who writes it, and the summary is posted in the conversation', async () => {
  // @indexer asks @researcher, which answers in the side thread; the answer comes back to @indexer.
  scripts.set(researcher.id, async (ctx) => ctx.text('The 1908 edition drops two chapters.'));
  scripts.set(indexer.id, async (ctx) => ctx.text('Noted.'));
  wake(indexer.id, 'researcher', 'Which editions differ?');
  await idle();
  const side = sideOf();
  await open(`#/t/${room.id}/side/${side.id}`);
  await page.waitFor(`${BUTTON} && !${BUTTON}.disabled`, { label: 'Summarize back in the side thread' });
  await page.evaluate(`${BUTTON}.focus()`);
  await press('Enter');
  const items = await page.evaluate(`[...document.querySelectorAll('.menu [role=menuitem]')].map((b) => b.textContent)`);
  expect(
    items.length === 2 && items[0] === '@indexer writes itstarted this thread' && items[1] === '@researcher writes it',
    `The menu lists ${JSON.stringify(items)}`,
  );
  expect(await page.evaluate(`document.activeElement?.textContent === '@indexer writes itstarted this thread'`), 'Focus isn’t on the first agent');
  const hops = store.state.threads[room.id].hops;
  const before = turns.length;
  scripts.set(indexer.id, async (ctx) => ctx.text('@researcher found that the 1908 edition drops two chapters; nothing is open.'));
  await press('Enter');
  expect(await page.evaluate(`document.activeElement?.id === 'side-input'`), 'Focus didn’t go to the composer once the button waited');
  // The request is a fetch from the page: its turn starts once the server has it.
  await until(() => turns.length > before, 'the summary’s turn');
  await idle();
  const ran = turns
    .slice(before)
    .map((x) => [x.sessionId === indexer.id ? 'indexer' : x.sessionId === researcher.id ? 'researcher' : x.sessionId, x.thread === side.id]);
  expect(JSON.stringify(ran) === JSON.stringify([['indexer', true]]), `The turns were ${JSON.stringify(ran)}`);
  expect(store.state.threads[room.id].hops === hops, 'The summary counted against the wake limit');
  await page.synced(store.state.seq);
  await settle();
  const card = await page.evaluate(
    `[...document.querySelectorAll('#main .shared-card')].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()).find((t) => t.includes('1908')) ?? ''`,
  );
  expect(card.startsWith('Summary of the thread “@indexer ↔ @researcher” · @indexer'), `The conversation shows “${card}”`);
});

await check('#225 Summarize back asked while its agent is busy in the side thread waits until the summary is posted', async () => {
  // The person asks @indexer one more thing in the side thread, and that turn holds, so the summary waits behind it.
  const side = sideOf();
  rt.sendMessage(side.id, { text: '@indexer one more thing' });
  await until(() => busy(indexer.id), '@indexer at work');
  await open(`#/t/${room.id}/side/${side.id}`);
  await page.waitFor(`${BUTTON} && !${BUTTON}.disabled`, { label: 'Summarize back in the side thread' });
  await page.evaluate(`${BUTTON}.focus()`);
  await press('Enter');
  await press('Enter');
  await until(() => store.state.threads[side.id].summaryPending, 'the request on the server');
  // The turn it waited for ends, and the summary’s own turn starts: the button still waits.
  const before = turns.length;
  release(indexer.id);
  await until(() => turns.length > before && /^Summarize/.test(turns.at(-1).text), 'the summary’s turn');
  await page.synced(store.state.seq);
  await settle();
  // Waiting, the button is labelled “Summary requested…”.
  const was = await page.evaluate(
    `(({ disabled, textContent }) => [disabled, textContent])(document.querySelector('.sidepanel .sp-head [aria-haspopup=menu]'))`,
  );
  expect(was[0] && was[1] === 'Summary requested…', `Summarize back could be asked again while the summary was being written: ${JSON.stringify(was)}`);
  release(indexer.id);
  await idle();
  await page.synced(store.state.seq);
  await page.waitFor(`${BUTTON} && !${BUTTON}.disabled`, { label: 'Summarize back once the summary is posted' });
  const last = store.items(room.id).at(-1);
  expect(last.kind === 'shared' && last.summary && last.fromThreadId === side.id, 'The summary wasn’t posted in the conversation');
});

await check('#225 Summarize back asked while its agent’s stopped turn is still exiting waits after a reload too', async () => {
  // @indexer’s turn in the side thread ignores Stop for a while, as a CLI that’s slow to exit does, so the summary
  // waits for its process.
  const side = sideOf();
  let exit = () => {};
  scripts.set(indexer.id, async (ctx) => {
    ctx.status({ state: 'tool', currentStep: 'Reading the shelf' });
    await new Promise((r) => {
      exit = r;
    });
  });
  rt.sendMessage(side.id, { text: '@indexer one more thing' });
  await until(() => busy(indexer.id), '@indexer at work');
  rt.stop(indexer.id);
  await open(`#/t/${room.id}/side/${side.id}`);
  await page.waitFor(`${BUTTON} && !${BUTTON}.disabled`, { label: 'Summarize back in the side thread' });
  await page.evaluate(`${BUTTON}.focus()`);
  await press('Enter');
  await press('Enter');
  await until(() => rt.exiting.get(indexer.id)?.held.some((h) => h.summarizeTo), 'the summary waiting for the stopped turn to exit');
  // The page loads again, so it knows only what the server sends it.
  await page.reload();
  await page.synced(store.state.seq);
  await page.waitFor(`document.querySelector('.sidepanel .sp-head [aria-haspopup=menu]')`, { label: 'the side thread’s panel again' });
  await settle();
  const was = await page.evaluate(
    `(({ disabled, textContent }) => [disabled, textContent])(document.querySelector('.sidepanel .sp-head [aria-haspopup=menu]'))`,
  );
  expect(was[0] && was[1] === 'Summary requested…', `After a reload, Summarize back could be asked again while the summary waited: ${JSON.stringify(was)}`);
  // The process exits, the summary’s turn runs, and once it’s posted the button is back.
  const before = turns.length;
  exit();
  await until(() => turns.length > before && /^Summarize/.test(turns.at(-1).text), 'the summary’s turn');
  release(indexer.id);
  await idle();
  await page.synced(store.state.seq);
  await page.waitFor(`${BUTTON} && !${BUTTON}.disabled`, { label: 'Summarize back once the summary is posted' });
  const last = store.items(room.id).at(-1);
  expect(last.kind === 'shared' && last.summary && last.fromThreadId === side.id, 'The summary wasn’t posted in the conversation');
});

await page.close();
await app.close();
await rm(dataDir, { recursive: true, force: true });
await rm(claudeHome, { recursive: true, force: true });
record(!page.logs.length, 'the page logged no errors', page.logs.join('\n'));
finish();
