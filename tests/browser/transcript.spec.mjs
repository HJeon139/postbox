// How the transcript follows agents, driven with real wheel and mouse input:
// - the view stays on the newest message until you scroll up, and stays on what you’re reading after that (#88);
// - apps name their author (#88);
// - “Jump to latest” shows only while something is unread below (#91);
// - the working rows sit in the message column (#83);
// - and Summarize back and Send to conversation post once (#93).
// Each test has a conversation of its own. Every step waits for its change to reach the page and for the page to hold
// still, and only then measures, once: a view that drifts fails rather than eventually passing.
// Moved from tools/check-transcript.mjs (#303).

import { expect, test } from '@playwright/test';
import { allowPageError, failOnPageErrors, frames, settled, startPostbox, synced } from './postbox.mjs';

test.use({ colorScheme: 'light' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('transcript');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const LONG = (n) =>
  `Message ${n}. The ReAct loop alternates a thought, an action and an observation; the observation is the only outside evidence, so it keeps the plan grounded while the agent works through the search results one at a time.`;

/** A long room with @researcher and @critic: questions, and the agents’ long answers. */
function room(title, count = 24) {
  const { rt, store } = app;
  const project = Object.values(store.state.projects)[0];
  const t = rt.createThread({ projectId: project.id, title, personaIds: [rt.personaByHandle('researcher').id, rt.personaByHandle('critic').id] });
  const [researcher, critic] = rt.sessionsIn(t.id);
  const say = (se, text, extra = {}) =>
    rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text, status: 'done', ...extra });
  for (let i = 1; i <= count; i++) {
    if (i % 3 === 1) rt.addItem(t.id, { kind: 'user', text: `Question ${i}: what does the observation step add?` });
    else say(i % 2 ? critic : researcher, LONG(i));
  }
  return { t, researcher, critic, say };
}

/** Streams a reply a few words a frame, the way an agent does, ends it, and waits for the page to draw its end. */
async function stream(page, t, se, text) {
  const { rt, store } = app;
  const it = rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: '', status: 'streaming' });
  for (const chunk of text.match(/\S+\s*/g)) {
    store.emit('item.text', { threadId: t.id, id: it.id, text: chunk });
    await frames(page);
  }
  rt.patchItem(t.id, it.id, { status: 'done' });
  const item = page.locator(`[data-key="${it.id}"]`);
  await expect(item.locator('.md'), 'the streamed reply finished on the page').toContainText(text.trim().slice(-24));
  await expect(item.locator('.caret')).toHaveCount(0);
  await settled(page);
  return it;
}

/** An app that starts short and grows to 700 px a moment after it loads. */
const growingApp = (id, title, after = 1500) => ({
  id,
  title,
  fallback: `${title}: a box that grows.`,
  code: `<div id="b" style="height:150px">Loading the gallery…</div><script>setTimeout(() => { document.getElementById('b').style.height = '700px'; }, ${after});</script>`,
});
const appItem = (t, appId) => app.store.items(t.id).find((i) => i.kind === 'block' && i.block?.id === appId)?.id;
/** An app’s frame, not the hidden one its check runs in. */
const frameOf = (page, key) => page.locator(`[data-key="${key}"] iframe:not(.check-frame)`);
/** Waits for an app’s frame to have grown to 700 px. */
const grown = (page, key) =>
  expect.poll(() => frameOf(page, key).evaluate((f) => f.getBoundingClientRect().height), { message: 'the app to grow to 700 px' }).toBeGreaterThanOrEqual(690);

/** How far the view is from the end of the conversation, and of the panel. */
const gap = (page) => page.evaluate(() => Math.round(document.scrollingElement.scrollHeight - scrollY - innerHeight));
const panelGap = (page) =>
  page.evaluate(() => {
    const b = document.querySelector('.sp-body');
    return b ? Math.round(b.scrollHeight - b.scrollTop - b.clientHeight) : null;
  });
/** Once the page holds still, that the view is at the end. */
async function atTheEnd(page, what) {
  await settled(page);
  expect(await gap(page), what).toBeLessThanOrEqual(2);
}
/** The message at the middle of the view, and where it starts; the same message must stay put. */
const reading = (page) =>
  page.evaluate(() => {
    const n = /** @type {HTMLElement | undefined} */ (document.elementFromPoint(760, innerHeight / 2)?.closest('.item'));
    return n ? { key: n.dataset.key ?? '', top: Math.round(n.getBoundingClientRect().top) } : null;
  });
const topOf = (page, key) => page.locator(`[data-key="${key}"]`).evaluate((n) => Math.round(n.getBoundingClientRect().top));

/** Turns the mouse wheel over the middle of the transcript, as a trackpad or mouse does, and waits for the scroll to end. */
async function wheel(page, deltaY) {
  await page.mouse.move(760, 400);
  await page.mouse.wheel(0, deltaY);
  await settled(page);
}

/** Opens a conversation, and waits for its transcript to draw and hold still. */
async function open(page, t) {
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator(`.transcript[data-thread="${t.id}"] .item`).first()).toBeVisible();
  await settled(page);
}
/**
 * Opens or closes the thread panel by its address. Within one conversation that changes only the right pane, so it
 * waits for the pane; a thread made a moment ago must have reached the page first.
 */
async function panel(page, t, side) {
  await synced(page, app);
  await page.evaluate(
    (h) => {
      location.hash = h;
    },
    side ? `#/t/${t.id}/side/${side}` : `#/t/${t.id}`,
  );
  if (side) await expect(page.locator(`.sidepanel .transcript[data-thread="${side}"]`)).toBeVisible();
  else await expect(page.locator('.sidepanel')).toHaveCount(0);
  await settled(page);
}

// ── #88: at the bottom, you stay at the bottom ──────────────────────────────────────────

test('#88 at the bottom: streaming, a patch, a new item and the working row keep the view on the newest message', async ({ page }) => {
  const { rt, store } = app;
  const { t, researcher, critic } = room('Stays at the bottom');
  await open(page, t);
  await atTheEnd(page, 'opens at the bottom');
  await stream(page, t, researcher, `${LONG(90)} ${LONG(91)} ${LONG(92)}`);
  await atTheEnd(page, 'after streaming');
  const last = store.items(t.id).at(-1);
  rt.patchItem(t.id, last.id, { activity: { steps: [{ id: 's1', label: 'grep observation', state: 'done', ms: 400 }] } });
  rt.patchItem(t.id, last.id, { sources: [{ title: 'ReAct', authors: 'Yao, Zhao', year: 2023, url: 'https://arxiv.org/abs/2210.03629' }] });
  await expect(page.locator(`[data-key="${last.id}"] .activity`)).toBeAttached();
  await expect(page.locator(`[data-key="${last.id}"] .sources`)).toBeAttached();
  await atTheEnd(page, 'after an item patch grew the reply');
  rt.updateSession(critic.id, { state: 'tool', currentStep: 'Searched the web for ReAct ablations', glimpse: 'Checking whether the ablation holds.' });
  await expect(page.locator('.working .work-row')).toBeVisible();
  await atTheEnd(page, 'after the working row appeared');
});

test('#88 at the bottom: an app growing from 200 to 700 px leaves the view at the bottom, and the app names its author', async ({ page }) => {
  const { rt } = app;
  const { t, critic } = room('An app grows');
  await open(page, t);
  rt.addItem(t.id, { kind: 'user', text: 'Show me the gallery.' });
  rt.toolsFor(critic.id).show_app(growingApp('gallery', 'Gallery', 2500));
  const key = appItem(t, 'gallery');
  await expect(frameOf(page, key)).toBeAttached();
  await grown(page, key);
  await atTheEnd(page, 'after the app grew');
  await expect(page.locator(`[data-key="${key}"] .who b`), 'the app’s header names the agent that wrote it').toHaveText('@critic');
  // The author line sits in the message column, like every other speaker line.
  const [appWho, colLeft] = await page.evaluate((k) => {
    const left = (sel) => Math.round(document.querySelector(sel)?.getBoundingClientRect().left ?? Number.NaN);
    return [left(`[data-key="${k}"] .who`), left('.transcript .col.turn')];
  }, key);
  expect(appWho).toBe(colLeft);
});

test('#88 at the bottom: opening and closing the thread panel leaves the view at the bottom, in both panes', async ({ page }) => {
  const { rt, store } = app;
  const { t, researcher } = room('Panel at the bottom');
  rt.toolsFor(researcher.id).show_app(growingApp('explainer', 'Explainer', 800));
  for (let i = 0; i < 3; i++) rt.addItem(t.id, { kind: 'user', text: `After the app ${i}` });
  await open(page, t);
  const key = appItem(t, 'explainer');
  await grown(page, key);
  const root = store.items(t.id).find((i) => i.kind === 'agent');
  const { threadId } = rt.startTopic(t.id, root.id);
  for (let i = 0; i < 12; i++) rt.addItem(threadId, { kind: 'user', text: LONG(200 + i) });
  await panel(page, t, threadId);
  // The app frame stays (only the pane changes), and keeps its height in the narrower column.
  await grown(page, key);
  await atTheEnd(page, 'conversation, with the panel open');
  expect(await panelGap(page), 'the panel itself').toBeLessThanOrEqual(2);
  await panel(page, t, null);
  await grown(page, key);
  await atTheEnd(page, 'after closing the panel');
});

test('#88 at the bottom: a window resize leaves the view at the bottom', async ({ page }) => {
  const { t } = room('Resize at the bottom');
  await open(page, t);
  await page.setViewportSize({ width: 1000, height: 700 });
  await atTheEnd(page, 'narrower and shorter');
  await page.setViewportSize({ width: 1280, height: 900 });
  await atTheEnd(page, 'back to 1280');
});

test('#88 at the bottom: a card that needs you stays still while what follows it shrinks (the working row going, the pill hiding)', async ({ page }) => {
  const { rt, store } = app;
  const { t, researcher, critic } = room('A card at the bottom');
  await open(page, t);
  rt.updateSession(critic.id, { state: 'tool', currentStep: 'Searched the web', glimpse: 'Reading the first result.' });
  rt.toolsFor(researcher.id).show_block({
    block: {
      id: 'go',
      type: 'confirm',
      version: 1,
      title: 'Run the eval',
      statement: 'Run the eval on all 300 claims?',
      confirmLabel: 'Run it',
      fallback: 'Run the eval on all 300 claims?',
    },
  });
  const card = store.items(t.id).at(-1).id;
  const button = page.locator(`[data-key="${card}"] .btn`, { hasText: /^Run it$/ });
  await expect(button).toBeVisible();
  await expect(page.locator('.working .work-row')).toBeVisible();
  await atTheEnd(page, 'at the bottom');
  const y = () => button.evaluate((b) => Math.round(b.getBoundingClientRect().top));
  const before = await y();
  // The working row goes: the page would get shorter and pull the card down.
  rt.updateSession(critic.id, { state: 'idle', currentStep: '', glimpse: '' });
  await expect(page.locator('.working .work-row')).toHaveCount(0);
  await settled(page);
  expect(await y(), 'the card’s button stayed where it was').toBe(before);
  // Scrolled up while messages arrive, the pill shows; scrolling back down hides it, and nothing moves after that.
  await wheel(page, -600);
  await frames(page);
  const late = [0, 1].map((i) => rt.addItem(t.id, { kind: 'user', text: `While you were up ${i}` }));
  await expect(page.locator(`[data-key="${late[1].id}"]`)).toBeAttached();
  await settled(page);
  for (let i = 0; i < 6 && (await gap(page)) > 2; i++) await wheel(page, 400);
  await atTheEnd(page, 'back at the bottom');
  const last = page.locator(`[data-key="${late[1].id}"]`);
  const at = await last.evaluate((n) => Math.round(n.getBoundingClientRect().top));
  await expect(page.getByRole('button', { name: /^Jump to latest/ })).toBeHidden();
  await settled(page);
  expect(await last.evaluate((n) => Math.round(n.getBoundingClientRect().top)), 'the pill going didn’t move anything').toBe(at);
});

// ── #88: scrolled up, nothing moves you ─────────────────────────────────────────────────

test('#88 scrolled up: streaming, patches, new items, an app growing above, the panel and a resize don’t move what you’re reading', async ({ page }) => {
  const { rt, store } = app;
  const { t, researcher, critic, say } = room('Scrolled up', 6);
  rt.toolsFor(critic.id).show_app(growingApp('above', 'Above the view', 60000));
  // Enough below the app that it ends just above the view once you scroll up, where apps stay loaded.
  for (let i = 0; i < 16; i++) say(i % 2 ? critic : researcher, LONG(300 + i));
  await open(page, t);
  await wheel(page, -300);
  // The transcript learns you scrolled up from the scroll event, a frame later (#341).
  await frames(page);
  const at = await reading(page);
  expect(at, 'a message is in view').toBeTruthy();
  expect(await gap(page), 'scrolled up').toBeGreaterThan(200);
  const appKey = appItem(t, 'above');
  expect(await page.locator(`[data-key="${appKey}"]`).evaluate((n) => n.getBoundingClientRect().bottom), 'the app is above the view').toBeLessThan(48);
  // Within a pixel: scroll positions round to whole pixels.
  const still = async (what) => expect(Math.abs((await topOf(page, at.key)) - at.top), `${what} moved the message you were reading`).toBeLessThanOrEqual(1);
  await stream(page, t, researcher, `${LONG(400)} ${LONG(401)}`);
  await still('streaming');
  await expect(page.locator(`[data-key="${rt.addItem(t.id, { kind: 'user', text: 'A new question below.' }).id}"]`)).toBeAttached();
  await settled(page);
  await still('a new item');
  // A message above the one you’re reading grows (a patch re-renders it).
  const above = store.items(t.id).filter((i) => i.kind === 'agent')[2];
  rt.patchItem(t.id, above.id, { text: `${above.text}\n\n${LONG(500)}\n\n${LONG(501)}` });
  await expect(page.locator(`[data-key="${above.id}"]`)).toContainText('Message 501');
  await settled(page);
  await still('a patch above');
  // The app above the view grows to 700 px. Chrome holds back rendering in a cross-origin frame that’s off screen, so
  // the app can’t measure itself there (and Postbox may have unloaded it to a placeholder of the same height): set the
  // height of what’s in its box, the way sizeFrame() does when an app reports one.
  await page.locator(`[data-key="${appKey}"] .app-body`).evaluate((n) => {
    /** @type {HTMLElement} */ (n.firstElementChild).style.height = '700px';
  });
  await settled(page);
  await still('the app above growing');
  await page.setViewportSize({ width: 1100, height: 900 });
  await settled(page);
  const moved = Math.abs((await topOf(page, at.key)) - at.top);
  await page.setViewportSize({ width: 1280, height: 900 });
  await settled(page);
  expect(moved, 'a resize moved it').toBeLessThanOrEqual(1);
  // Opening the panel narrows the conversation beside it: you stay on the same message.
  const root = store.items(t.id).find((i) => i.kind === 'agent');
  const { threadId } = rt.startTopic(t.id, root.id);
  // The root message’s Reply in thread becomes its Thread link first; measure once that’s on the page.
  await expect(page.locator(`[data-key="${root.id}"] .replies`)).toBeAttached();
  await settled(page);
  const before = await topOf(page, at.key);
  await panel(page, t, threadId);
  expect(Math.abs((await topOf(page, at.key)) - before), 'opening the panel moved it').toBeLessThanOrEqual(1);
  expect(await gap(page), 'still scrolled up with the panel open').toBeGreaterThan(200);
});

// ── #91: Jump to latest ─────────────────────────────────────────────────────────────────

test('#91 the pill counts what arrives while you’re scrolled up, and goes once you scroll to the bottom yourself', async ({ page }) => {
  const { rt } = app;
  const { t, critic } = room('Jump to latest');
  await open(page, t);
  const pill = page.locator('.jump');
  /** Each new user message, once it’s on the page and the page has settled. */
  const arrive = async (text) => {
    const it = rt.addItem(t.id, { kind: 'user', text });
    await expect(page.locator(`[data-key="${it.id}"]`)).toBeAttached();
    await settled(page);
  };
  await expect(pill, 'no pill at the bottom').toBeHidden();
  await wheel(page, -600);
  await frames(page);
  for (const i of [0, 1, 2]) await arrive(`Arrived while you read ${i}`);
  await expect(pill).toHaveText(/Jump to latest · 3 new/);
  // Down by hand, with the wheel, never touching the pill.
  for (let i = 0; i < 6; i++) await wheel(page, 400);
  await atTheEnd(page, 'at the bottom');
  await expect(pill, 'the pill goes, and its count with it').toBeHidden();
  await arrive('Arrived at the bottom');
  await expect(pill, 'nothing is unread below').toBeHidden();
  await atTheEnd(page, 'and the view followed it');
  await wheel(page, -600);
  await frames(page);
  await arrive('One more while you read');
  await expect(pill).toHaveText(/1 new/);
  // With an agent working, the pill shows only while the working row is further down than the pill, and it goes once
  // you’re within that distance of the end, so it never sits over the row.
  rt.updateSession(critic.id, { state: 'tool', currentStep: 'Searched the web', glimpse: 'Reading the first result.' });
  await expect(page.locator('.working .work-row')).toBeVisible();
  await settled(page);
  const clear = await page.evaluate(() => {
    const p = document.querySelector('.jump button')?.getBoundingClientRect();
    const w = document.querySelector('.working')?.getBoundingClientRect();
    return !!p && !!w && w.top >= p.bottom;
  });
  expect(clear, 'the working row is below the pill, out of its way').toBe(true);
  for (let i = 0; i < 6 && (await gap(page)) > 48; i++) await wheel(page, Math.min(120, (await gap(page)) - 20));
  const near = await gap(page);
  expect(near > 2 && near <= 48, `near the end but not at it (gap ${near})`).toBe(true);
  await expect(pill, 'near the end, the pill is gone').toBeHidden();
});

// ── #83: the working rows sit in the message column ─────────────────────────────────────

test('#83 the working row lines up with the message column, with and without the panel, and a long step truncates', async ({ page }) => {
  const { rt, store } = app;
  const { t, researcher, critic } = room('Working rows');
  await open(page, t);
  const step = `Searched the web for ${'ReAct observation ablations and the follow-up papers that cite them, '.repeat(6)}`;
  rt.updateSession(researcher.id, { state: 'tool', currentStep: step, glimpse: 'Reading the third result.' });
  rt.updateSession(critic.id, { state: 'think', glimpse: 'Is the ablation fair?' });
  await expect(page.locator('.working .work-row')).toHaveCount(2);
  await settled(page);
  const measure = () =>
    page.evaluate(() => {
      const box = (n) => /** @type {Element} */ (n).getBoundingClientRect();
      const ring = box(document.querySelector('.working .work-row pb-ring'));
      const who = box([...document.querySelectorAll('.transcript .col.turn:not(.me) .who pb-ring')].at(-1));
      const col = box([...document.querySelectorAll('.transcript .col.turn')].at(-1));
      const work = box(document.querySelector('.working'));
      const line = /** @type {HTMLElement} */ (document.querySelector('.working .work-line'));
      return {
        ring: Math.round(ring.left),
        who: Math.round(who.left),
        colRight: Math.round(col.right),
        workRight: Math.round(work.right),
        truncated: line.scrollWidth > line.clientWidth && getComputedStyle(line).textOverflow === 'ellipsis',
        lineRight: Math.round(line.getBoundingClientRect().right),
      };
    });
  const plain = await measure();
  expect(plain.ring, 'the ring and the @handle above share a left edge').toBe(plain.who);
  expect(plain.workRight, 'the rows end inside the column').toBeLessThanOrEqual(plain.colRight);
  expect(plain.truncated && plain.lineRight <= plain.colRight, 'the long step truncates with an ellipsis, inside the column').toBe(true);
  const root = store.items(t.id).find((i) => i.kind === 'agent');
  const { threadId } = rt.startTopic(t.id, root.id);
  await panel(page, t, threadId);
  await expect(page.locator('.main .working .work-row')).toHaveCount(2);
  await settled(page);
  const beside = await measure();
  expect(beside.ring, 'with the panel open too').toBe(beside.who);
  expect(beside.workRight <= beside.colRight && beside.truncated, 'and still inside the column, truncated').toBe(true);
});

// ── #93: what goes back to the conversation goes once ───────────────────────────────────

test('#93 Summarize back clicked twice posts one summary; the button waits, and the summary’s reply shows it was sent', async ({ page }) => {
  const { rt, store } = app;
  const { t, researcher } = room('Summarize once', 6);
  const root = store.items(t.id).find((i) => i.kind === 'agent' && i.sessionId === researcher.id);
  const { threadId } = rt.startTopic(t.id, root.id);
  await open(page, t);
  await panel(page, t, threadId);
  const button = page.locator('.sidepanel .sp-head .btn.sm', { hasText: /^Summar/ });
  await expect(button).toHaveText('Summarize back');
  await button.click({ clickCount: 2 });
  await expect(button).toHaveText('Summary requested…');
  await expect(button, 'disabled while the summary is pending').toBeDisabled();
  allowPageError(page, /status of 409/);
  // From the page, as another tab would send it: with the page’s token (#74), which a request from here wouldn’t have.
  const second = await page.evaluate(
    (id) => fetch(`/api/threads/${id}/summarize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status),
    threadId,
  );
  expect(second, 'the server refuses a second request, as from another tab').toBe(409);
  await expect(button, 'the button comes back').toHaveText('Summarize back', { timeout: 15_000 });
  await expect(button).toBeEnabled();
  const shared = store.items(t.id).filter((i) => i.kind === 'shared');
  expect(shared.length, 'one summary in the conversation').toBe(1);
  expect([shared[0].summary, shared[0].text.slice(0, 26)], 'not a summary of the thread (#228)').toEqual([true, 'In the thread we looked at']);
  expect(store.items(threadId).filter((i) => i.kind === 'voice').length, 'one request').toBe(1);
  const reply = store.items(threadId).find((i) => i.kind === 'agent' && i.text);
  const actions = page.locator(`.sp-body [data-key="${reply.id}"] .msg-actions`);
  await expect(actions, 'the reply shows it was sent').toContainText('Sent to the conversation');
  await expect(actions.getByRole('button', { name: 'Send to conversation' }), 'no Send button on it').toHaveCount(0);
});

test('#93 Send to conversation clicked twice posts once', async ({ page }) => {
  const { rt, store } = app;
  const { t, researcher } = room('Send once', 6);
  const root = store.items(t.id).find((i) => i.kind === 'agent' && i.sessionId === researcher.id);
  const { threadId } = rt.startTopic(t.id, root.id);
  // Its one session answers in the thread (#228).
  const reply = rt.addItem(threadId, {
    kind: 'agent',
    sessionId: researcher.id,
    personaId: researcher.personaId,
    handle: researcher.handle,
    text: 'Offsets, not pages.',
    status: 'done',
  });
  await open(page, t);
  await panel(page, t, threadId);
  const actions = page.locator(`.sp-body [data-key="${reply.id}"] .msg-actions`);
  await actions.getByRole('button', { name: 'Send to conversation' }).click({ clickCount: 2 });
  await expect(actions, 'the reply shows it was sent').toContainText('Sent to the conversation');
  await synced(page, app);
  await settled(page);
  expect(store.items(t.id).filter((i) => i.kind === 'shared').length, 'posted once').toBe(1);
  // Without the wait, the second click reached the server, which refused it with an error toast.
  await expect(page.locator('.toast[role=alert]', { hasText: 'Couldn’t send it' }), 'no “Couldn’t send it” error').toHaveCount(0);
});
