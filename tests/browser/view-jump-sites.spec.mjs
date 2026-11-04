// Every jump to an item goes through jumpTo (#712, app/js/view-jump.mjs): the moved item's "Go to it", a retired app's
// link to what replaced it, ⌃J, the side thread's line to its card, a citation's "Show in sources", and Alt+↑/↓. Each
// test drives the real control in a room of long replies, opened at its end, so the items between the view and the
// target haven't drawn yet. Once the page holds still, the target's item is the transcript's anchor (reading, or
// following at the end), and the target starts where the jump's block puts it, within 1 px, unless the scroll is
// clamped at the start or end of the page. Each test has a conversation of its own.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox } from './postbox.mjs';
import { holds, LONG, open as openIn, room as roomIn } from './view-read-fixture.mjs';

test.use({ colorScheme: 'light' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('view-jump-sites');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const room = (/** @type {string} */ title) => roomIn(app, title);
const open = (/** @type {any} */ page, /** @type {any} */ t) => openIn(app, page, t);
// 200 px tall, the height a frame starts at, so the app doesn't grow once its frame loads after the jump.
const APP = (/** @type {string} */ label) =>
  `<style>html,body{margin:0}</style><button class="btn" type="button" style="display:block;width:100%;height:200px">${label}</button>`;
/** n more long replies, after what the room has. @param {(text: string) => any} say */
const more = (say, n = 15, from = 100) => {
  for (let i = 0; i < n; i++) say(`${LONG(from + i)}\n\n${LONG(from + i + 50)}`);
};
/** No agent but the one named needs the person, so ⌃J and the side line go to its card. @param {string} sessionId */
function onlyNeeds(sessionId, needs) {
  for (const se of Object.values(app.store.state.sessions)) if (se.needs && se.id !== sessionId) app.rt.updateSession(se.id, { needs: null, state: 'idle' });
  app.rt.updateSession(sessionId, { state: 'needs', needs });
}

/**
 * The transcript's view of a thread, and where a target in it starts in what you can see of its scroll box: the page
 * below the top bar, or the side panel's body. clamped says the box is scrolled to its start or its end, where a jump can't put the target where it wants.
 * @param {any} page @param {string} threadId @param {string} target  a selector for the target
 */
const where = (page, threadId, target) =>
  page.evaluate(
    ({ id, sel }) => {
      const el = /** @type {HTMLElement} */ (document.querySelector(`.transcript[data-thread="${id}"]`));
      const inPanel = !!el.closest('.sidepanel');
      const s = /** @type {Element} */ (inPanel ? el.parentElement : document.scrollingElement);
      // What you can see starts at the panel's body, or under the main pane's sticky top bar.
      const bar = document.querySelector('header.topbar')?.getBoundingClientRect().bottom ?? 0;
      const top0 = inPanel ? s.getBoundingClientRect().top : Math.max(0, bar);
      const r = /** @type {Element} */ (document.querySelector(sel)).getBoundingClientRect();
      const gap = s.scrollHeight - s.scrollTop - s.clientHeight;
      return {
        mode: el.dataset.viewMode,
        anchor: el.dataset.viewAnchor,
        top: r.top - top0,
        height: r.height,
        room: inPanel ? s.clientHeight : s.clientHeight - top0,
        clamped: s.scrollTop <= 0 || gap <= 1,
      };
    },
    { id: threadId, sel: target },
  );

/**
 * The jump's findings, soft so each reports: its item is the anchor, and the target is where block puts it.
 * @param {any} page @param {string} threadId @param {string} target @param {string} itemKey
 * @param {'center' | 'nearest'} block
 */
async function landed(page, threadId, target, itemKey, block) {
  await settled(page);
  const v = await where(page, threadId, target);
  expect.soft(v.mode, 'the view is reading after the jump').toBe('reading');
  expect.soft(v.anchor, 'the target’s item is the anchor').toBe(itemKey);
  if (block === 'center' && !v.clamped) {
    const wanted = Math.max(0, (v.room - v.height) / 2);
    expect.soft(Math.abs(v.top - wanted), `the target is centered: starts at ${v.top}, wanted ${wanted}`).toBeLessThanOrEqual(1);
  }
  if (block === 'nearest') {
    expect.soft(v.top, 'the target starts in the view').toBeGreaterThanOrEqual(-1);
    expect.soft(v.top + Math.min(v.height, v.room), 'the target ends in the view').toBeLessThanOrEqual(v.room + 1);
  }
  return v;
}

test('#712 Go to it on a moved app’s stub makes the app the anchor, centered', async ({ page }) => {
  const { rt, store } = app;
  const { t, say } = room('Jump: Go to it');
  const [se] = rt.sessionsIn(t.id);
  const tools = rt.toolsFor(se.id);
  tools.show_app({ id: 'jump-moved', title: 'Pair explorer', code: APP('v1'), permissions: [] });
  more(say, 20);
  tools.update_app({ id: 'jump-moved', code: APP('v2') });
  rt.appCheck('jump-moved', { version: 2, problems: [] });
  more(say, 15, 300);
  const item = store.items(t.id).find((/** @type {any} */ i) => i.kind === 'block' && i.block.id === 'jump-moved');
  const stub = store.items(t.id).find((/** @type {any} */ i) => i.kind === 'moved' && i.itemId === item.id);
  await open(page, t);
  await page
    .locator(`[data-key="${stub.id}"]`)
    .getByRole('button', { name: /^Go to it/ })
    .click();
  await landed(page, t.id, `#main > [data-key="${item.id}"]`, item.id, 'center');
  await holds(page, t, 'after Go to it');
});

test('#712 a retired app’s link to its replacement makes the replacement the anchor, centered', async ({ page }) => {
  const { rt, store } = app;
  const { t, say } = room('Jump: retired app');
  const [se] = rt.sessionsIn(t.id);
  const tools = rt.toolsFor(se.id);
  tools.show_app({ id: 'jump-old', title: 'Practice lab', code: APP('Lab'), permissions: [] });
  more(say, 20);
  tools.show_app({ id: 'jump-new', title: 'Metro map', code: APP('Map'), permissions: [] });
  rt.appCheck('jump-new', { version: 1, problems: [] });
  more(say, 15, 300);
  const r = tools.retire_app({ id: 'jump-old', reason: 'The metro map covers the same route.', replacedBy: 'jump-new' });
  expect(r.ok, `retire_app: ${r.message}`).toBe(true);
  const to = store.state.apps['jump-new'].itemId;
  await open(page, t);
  await page.getByRole('button', { name: 'Go to Metro map' }).click();
  await landed(page, t.id, `#main > [data-key="${to}"]`, to, 'center');
  await holds(page, t, 'after the retired app’s link');
});

test('#712 ⌃J to a card in the middle of the room makes it the anchor, centered', async ({ page }) => {
  const { rt, store } = app;
  const { t, say } = room('Jump: ⌃J');
  const [se] = rt.sessionsIn(t.id);
  rt.toolsFor(se.id).show_block({
    block: { id: 'jump-ask', type: 'confirm', version: 1, fallback: 'Clear it?', statement: 'Clear the frames?', confirmLabel: 'Clear' },
  });
  const ask = store.items(t.id).at(-1);
  more(say, 15);
  onlyNeeds(se.id, { kind: 'block', itemId: ask.id, text: 'Clear the frames?' });
  await open(page, t);
  await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
  await page.keyboard.press('Control+j');
  await expect.poll(() => page.evaluate((k) => !!document.activeElement?.closest(`[data-key="${k}"]`), ask.id), { message: '⌃J focuses the card' }).toBe(true);
  await landed(page, t.id, `#main > [data-key="${ask.id}"]`, ask.id, 'center');
  await holds(page, t, 'after ⌃J');
});

test('#712 the side thread’s line goes to its card in the panel and makes it the anchor there, centered', async ({ page }) => {
  const { rt } = app;
  const { t } = room('Jump: side line');
  const [se] = rt.sessionsIn(t.id);
  const side = rt.putThread({
    ...{ id: `th_side${t.id.slice(3)}`, projectId: t.projectId, title: '@researcher ↔ @researcher', kind: 'side', parentId: t.id },
    ...{ pair: 'researcher|researcher', woke: 'researcher', members: [], lastSpeaker: null, hops: 0, queue: [], createdAt: Date.now(), archived: false },
  });
  rt.addItem(t.id, { kind: 'sidelink', sideThreadId: side.id, from: 'researcher', to: 'researcher', count: 0 });
  const sayThere = (/** @type {string} */ text) =>
    rt.addItem(side.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text, status: 'done' });
  more(sayThere, 30);
  const block = { id: 'jump-side-ask', type: 'confirm', version: 1, fallback: 'Index it?', statement: 'Index the shelf?', confirmLabel: 'Index' };
  const card = rt.addItem(side.id, { kind: 'block', sessionId: se.id, handle: se.handle, turnId: null, valid: true, block, answered: false });
  more(sayThere, 15, 300);
  onlyNeeds(se.id, { kind: 'block', itemId: card.id, threadId: side.id, text: 'Index the shelf?' });
  await open(page, t);
  await page.locator('#main .pill', { hasText: 'asked' }).click();
  await expect.poll(() => page.evaluate((k) => !!document.activeElement?.closest(`[data-key="${k}"]`), card.id), { message: 'focus on the card' }).toBe(true);
  await landed(page, side.id, `.sidepanel [data-key="${card.id}"]`, card.id, 'center');
});

test('#712 Show in sources makes the cited reply the anchor, with its source centered', async ({ page }) => {
  const { rt } = app;
  const { t, say } = room('Jump: Show in sources');
  const body = Array.from({ length: 14 }, (_, i) => LONG(200 + i)).join('\n\n');
  const cited = say(`ReAct grounds each step in what it observed [1].\n\n${body}`);
  rt.patchItem(t.id, cited.id, { sources: [{ title: 'ReAct', authors: 'Yao, Zhao', year: 2023, url: 'https://arxiv.org/abs/2210.03629' }] });
  more(say, 15);
  await open(page, t);
  await page.locator(`[data-key="${cited.id}"] a.cite`).click();
  await page.locator('.hovercard').getByRole('link', { name: 'Show in sources' }).click();
  await landed(page, t.id, `#src-${cited.id}-1`, cited.id, 'center');
  await holds(page, t, 'after Show in sources');
});

test('#712 Alt+↑ to an item above the view makes it the anchor, in view', async ({ page }) => {
  const { t, say } = room('Jump: Alt+Up');
  more(say, 15);
  await open(page, t);
  const keys = await page.evaluate(() => [...document.querySelectorAll('#main > .item')].map((n) => /** @type {HTMLElement} */ (n).dataset.key));
  // From the composer, Alt+↑ starts at the last item; eight more go eight up, past the top of the view.
  for (let i = 0; i < 9; i++) await page.keyboard.press('Alt+ArrowUp');
  const key = /** @type {string} */ (keys.at(-9));
  await expect
    .poll(() => page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.dataset.key), { message: 'Alt+↑ focuses the item' })
    .toBe(key);
  await landed(page, t.id, `#main > [data-key="${key}"]`, key, 'nearest');
  await holds(page, t, 'after Alt+↑');
});
