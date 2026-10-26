// The checks that close the loop: what the browser finds reaches the agent.
// - #46: a diagram Mermaid can’t draw comes back to the agent as a lint turn, and the person still sees the frame’s
//   “couldn’t be drawn” text and Show source.
// - #53: the app check measures marks, labels and dashes at 375 and 1280 px. A chart too small to read, and an app that
//   shows only an error, are shown with notes and reach the agent; a readable chart passes.
// - #58: a progress step shows “2 of 4 papers” with a bar, the block says when it last moved, a running step’s time
//   goes up and its glyph turns (still with reduced motion), and a step left running looks stalled.
// - #63: a reply that ends with options in prose comes back to the agent as a lint turn, and the person sees the
//   choice it shows then, with no second reply.
// SHOTS=<folder> also saves a screenshot of the progress block, running and stalled. Each test has a conversation of
// its own, with a scripted agent. Moved from tools/check-feedback.mjs (#303).

import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { formatMessage } from '../../server/adapters/guide.mjs';
import { failOnPageErrors, frames, startPostbox, synced } from './postbox.mjs';

const BROKEN = 'flowchart LR\n  A[Read] -->> B[Index]';
// A chart of 900 dots, labels and dashed links, drawn far too small; the same chart at a readable size.
const chart = ({ n, r, font, dash, stroke, view }) => `<!doctype html><html><body style="margin:0">
<svg id="c" viewBox="0 0 ${view} ${view / 2}" style="width:100%;height:auto;display:block" role="img" aria-label="Pairs"></svg>
<script>
const svg = document.getElementById('c'); const ns = 'http://www.w3.org/2000/svg'; let out = '';
for (let i = 0; i < ${n}; i++) {
  const x = 20 + ((i * 37) % (${view} - 40)), y = 20 + ((i * 53) % (${view} / 2 - 40));
  out += '<circle cx="' + x + '" cy="' + y + '" r="${r}" fill="var(--accent)"/>';
  if (i % 3 === 0) out += '<line x1="' + x + '" y1="' + y + '" x2="' + (x + 30) + '" y2="' + (y + 10) + '" stroke="var(--dim)" stroke-width="${stroke}" stroke-dasharray="${dash}"/>';
  if (i % 9 === 0) out += '<text x="' + x + '" y="' + (y - 4) + '" font-size="${font}" fill="var(--text)">p' + i + '</text>';
}
svg.innerHTML = out;
</script></body></html>`;
const APPS = {
  tiny: { title: 'Pair explorer', code: chart({ n: 900, r: 0.8, font: 9, dash: '2 1', stroke: 0.6, view: 2400 }) },
  readable: { title: 'Pair summary', code: chart({ n: 12, r: 8, font: 14, dash: '8 5', stroke: 2, view: 360 }) },
  missing: {
    title: 'SciFact explorer',
    code: '<!doctype html><html><body><p>SciFact isn’t loaded in this Postbox yet. Restart Postbox to load it.</p></body></html>',
  },
};
// What the agent does with Postbox’s check of a reply that should have been a choice (#63).
const UNBLOCK = {
  id: 'unblock',
  type: 'choice',
  version: 1,
  title: 'How should I get the documents?',
  fallback: 'Share the folder, paste the documents, or point me at an export.',
  options: ['Share the folder', 'Paste the documents', 'Point me at an export'].map((label, i) => ({ id: ['share', 'paste', 'export'][i], label })),
};
/** The progress turns holding until their test lets them end. */
const holds = [];
/** What the agent does, by the message it’s sent; apps are named for the conversation they’re in. */
const scripts = {
  progress: async (ctx) => {
    const steps = [
      { id: 'find', label: 'Find the papers', state: 'done', duration: '12 s' },
      { id: 'read', label: 'Read and summarize', state: 'running', progress: { done: 2, total: 4, unit: 'papers' }, eta: '3 min' },
      { id: 'write', label: 'Write the summary', state: 'pending' },
    ];
    ctx.tools.show_block({ block: { id: 'reading', type: 'progress', version: 1, title: 'Reading the papers', fallback: 'Reading four papers', steps } });
    await new Promise((r) => holds.push(r));
  },
  // A finished block beside a running one, so the clock ticks while the finished one is on the page.
  'finished and running': async (ctx) => {
    const done = (id) => ({ id, label: `Step ${id}`, state: 'done', duration: '4 s' });
    ctx.tools.show_block({ block: { id: 'done', type: 'progress', version: 1, title: 'Indexed', fallback: 'Indexed', steps: [done('a'), done('b')] } });
    const live = [done('c'), { id: 'd', label: 'Embed the chunks', state: 'running' }];
    ctx.tools.show_block({ block: { id: 'live', type: 'progress', version: 1, title: 'Embedding', fallback: 'Embedding', steps: live } });
    await new Promise((r) => holds.push(r));
  },
  diagram: (ctx) => ctx.text(`Here’s the flow:\n\n\`\`\`mermaid\n${BROKEN}\n\`\`\``),
  apps: (ctx, session) => {
    for (const [id, a] of Object.entries(APPS)) ctx.tools.show_app({ id: `${id}-${session.threadId}`, title: a.title, code: a.code });
  },
  options: (ctx) =>
    ctx.text('I can’t read the shared folder yet.\n\nTo unblock, pick one:\n1. Share the folder\n2. Paste the documents\n3. Point me at an export'),
};

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** Every message Postbox sends the agent, with the conversation it was in. */
const calls = [];
let drawer;
test.beforeAll(async () => {
  app = await startPostbox('feedback');
  app.rt.adapters.register({
    name: 'mock',
    async deliver(session, message, ctx) {
      calls.push({ ...message, threadId: session.threadId });
      if (message.kind === 'user') await scripts[message.text]?.(ctx, session);
      if (message.kind === 'lint' && message.problems.some((p) => p.code === 'options-in-prose')) ctx.tools.show_block({ block: UNBLOCK });
    },
  });
  drawer = app.rt.createPersona({ handle: 'drawer' });
});
test.afterAll(async () => {
  for (const r of holds.splice(0)) r();
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

/** A conversation of its own with @drawer, open in the page, sent that message. lints() are its lint turns. */
async function conversation(page, title, text) {
  const { rt } = app;
  const thread = rt.createThread({ projectId: Object.values(rt.s.projects)[0].id, title, personaIds: [drawer.id] });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  rt.sendMessage(thread.id, { text });
  const lints = () => calls.filter((m) => m.kind === 'lint' && m.threadId === thread.id);
  const idle = () => expect.poll(() => rt.turns.has(rt.sessionsIn(thread.id)[0].id), { message: 'the agent to finish' }).toBe(false);
  return { thread, lints, idle };
}

test('a finished progress block says when it last moved, and the clock leaves it alone while a running one ticks', async ({ page }) => {
  await conversation(page, 'Finished', 'finished and running');
  const finished = page.locator('[data-progress]').filter({ hasText: 'Indexed' });
  const live = page.locator('[data-progress] li[data-s="running"]');
  await expect(live).toBeVisible();
  // A finished block says the time it last moved, which needs no tick, with the day on hover.
  const updated = finished.locator('.block-head [data-since]');
  await expect(updated).toHaveText(/^Updated \d\d:\d\d$/);
  await expect(updated).toHaveAttribute('title', /\w+day, \w+ \d+ \d\d:\d\d$/);
  // Count every change to the finished block while the running one’s time goes up at least once.
  await finished.evaluate((node) => {
    const w = /** @type {any} */ (window);
    w.finishedChanges = 0;
    new MutationObserver((records) => {
      w.finishedChanges += records.length;
    }).observe(node, { subtree: true, childList: true, characterData: true });
  });
  const time = () => live.evaluate((li) => li.lastElementChild?.textContent);
  const before = await time();
  await expect.poll(time, { message: 'the running step’s time goes up' }).not.toBe(before);
  await expect.poll(time, { message: 'and again' }).not.toBe(await time());
  expect(await page.evaluate(() => /** @type {any} */ (window).finishedChanges), 'the finished block wasn’t rewritten').toBe(0);
  for (const r of holds.splice(0)) r();
});

test('#46 a diagram Mermaid can’t draw comes back to the agent once as a lint turn, and the person still has its frame and Show source', async ({ page }) => {
  const { lints, idle } = await conversation(page, 'Diagram', 'diagram');
  await expect.poll(() => lints().length, { message: 'a lint turn' }).toBeGreaterThan(0);
  const problem = lints()[0].problems.find((p) => p.code === 'diagram-error');
  expect(problem, 'for the diagram that couldn’t be drawn').toBeTruthy();
  expect(problem.message, 'with Mermaid’s message and line').toMatch(/line 2[\s\S]*Parse error|Parse error[\s\S]*line 2/);
  expect(problem.scope?.excerpt, 'quoting the diagram').toBe(BROKEN);
  const figure = page.locator('figure.diagram');
  await expect(figure.locator('iframe')).toHaveAttribute('data-failed', '1');
  await expect(figure.getByRole('button', { name: 'Show source' })).toBeVisible();
  const frame = await (await figure.locator('iframe').elementHandle())?.contentFrame();
  await expect(frame?.locator('.err') ?? page.locator('nothing'), 'the frame says it couldn’t be drawn').toContainText('couldn’t be drawn');
  // Once the lint turn has ended, and the page has drawn what came after it, no second one comes.
  await idle();
  await synced(page, app);
  await frames(page);
  expect(lints().length, 'once').toBe(1);
});

test('#53 apps too small to read, or showing only an error, are shown with notes and reach the agent in one lint turn; a readable chart passes', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const { rt } = app;
  const { thread, lints, idle } = await conversation(page, 'Apps', 'apps');
  const id = (key) => `${key}-${thread.id}`;
  const st = (key) => rt.s.apps[id(key)]?.check ?? {};
  const codes = (key) => (st(key).problems ?? []).map((p) => p.code);
  await expect
    .poll(() => Object.keys(APPS).every((k) => rt.s.apps[id(k)] && st(k).status !== 'pending'), {
      message: 'the browser to check all three apps',
      timeout: 30_000,
    })
    .toBe(true);
  test.info().annotations.push({
    type: 'checked',
    description: `tiny: ${st('tiny').status} ${codes('tiny').join(', ')}; readable: ${st('readable').status} ${codes('readable').join(', ')}`,
  });
  expect(st('readable').status, 'the readable chart passes').toBe('passed');
  expect([st('tiny').status, st('tiny').notes], 'the tiny chart is shown, with notes').toEqual(['note', true]);
  for (const code of ['marks-too-small', 'text-too-small', 'dashes-too-fine']) expect(codes('tiny'), `the tiny chart gets ${code}`).toContain(code);
  const messages = (st('tiny').problems ?? []).map((p) => p.message);
  expect(messages.some((m) => /^At 375 px/.test(m)) && messages.some((m) => /^At 1280 px/.test(m)), 'measured at 375 and 1280 px').toBe(true);
  expect(st('missing').status).toBe('note');
  expect(codes('missing'), 'an app showing only an error is flagged').toContain('only-error');
  const aboutApps = () => lints().find((m) => m.problems.some((p) => p.scope.kind === 'app'));
  await expect.poll(() => !!aboutApps(), { message: 'a lint turn about the apps', timeout: 20_000 }).toBe(true);
  const about = new Set(aboutApps().problems.map((p) => p.scope.id));
  expect([about.has(id('tiny')), about.has(id('missing')), about.has(id('readable'))], 'one lint turn tells the agent about both').toEqual([true, true, false]);
  // Once the lint turn has ended, and the page has drawn what came after it, no second one comes.
  await idle();
  await synced(page, app);
  expect(lints().length, 'one lint turn for the turn that showed the apps').toBe(1);
  await expect(page.locator('.app-note', { hasText: /marks are under 4 px/ }), 'the person sees the app with notes, not as a failure').toContainText(
    /^Shown with notes for @drawer/,
  );
});

test('#58 a progress step counts with a bar, says when it moved, its time goes up and its glyph turns; left running, it looks stalled', async ({ page }) => {
  const { lints } = await conversation(page, 'Progress', 'progress');
  const running = page.locator('[data-progress] li[data-s="running"]');
  await expect(running).toBeVisible();
  const shoot = (name) => process.env.SHOTS && page.locator('[data-progress]').screenshot({ path: join(process.env.SHOTS, `${name}.png`) });
  const read = () =>
    running.evaluate((li) => ({
      count: li.querySelector('.p-count')?.textContent,
      bar: /** @type {HTMLElement | null} */ (li.querySelector('.p-bar i'))?.style.width,
      time: li.lastElementChild?.textContent,
      spin: getComputedStyle(/** @type {Element} */ (li.querySelector('.g-running'))).animationName,
      updated: [...(li.closest('[data-progress]')?.querySelectorAll('.block-head [data-since]') ?? [])].map((e) => e.textContent).join(''),
    }));
  const first = await read();
  expect([first.count, first.bar], '“2 of 4 papers” with a bar at half').toEqual(['2 of 4 papers · 3 min left', '50%']);
  expect(first.updated, 'the block says when it last moved').toMatch(/^Updated (just now|\d+ s ago)$/);
  expect(first.spin, 'the running glyph turns').toBe('pb-turn');
  await expect.poll(async () => (await read()).time, { message: 'the running step’s time goes up' }).not.toBe(first.time);
  expect((await read()).time).toMatch(/^\d+ s$/);
  await shoot('progress-running');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect((await read()).spin, 'the glyph holds still with reduced motion').toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  holds.shift()?.();
  const stalled = page.locator('[data-progress] li[data-s="stalled"]');
  await expect(stalled.locator('.g'), 'a step left running looks stalled').toHaveAttribute('aria-label', 'Stalled');
  await expect(stalled.locator(':scope > :last-child'), 'and says for how long').toHaveText(/^No update for /);
  const dimmed = await stalled.evaluate(
    (li) => getComputedStyle(/** @type {Element} */ (li.querySelector('.t'))).color !== getComputedStyle(document.body).color,
  );
  expect(dimmed, 'a stalled step is dimmed').toBe(true);
  await expect
    .poll(() => lints().some((m) => m.problems.some((p) => p.code === 'steps-left-running')), { message: 'the agent is told to close the step' })
    .toBe(true);
  await shoot('progress-stalled');
});

test('#63 a reply that ends with options in prose comes back as a lint turn, and the person picks from the choice it shows, with no second reply', async ({
  page,
}) => {
  const { rt } = app;
  const { thread, lints, idle } = await conversation(page, 'Options', 'options');
  const nudge = () => lints().find((m) => m.problems.some((p) => p.code === 'options-in-prose'));
  await expect.poll(() => !!nudge(), { message: 'a lint turn about the options' }).toBe(true);
  expect(formatMessage(nudge()), 'the agent reads that the reply should have been a choice block').toMatch(
    /Your reply should have been a block:\n- It ends with options in a list\. Offer them as a choice block/,
  );
  const choice = page.locator('.transcript .block', { hasText: 'How should I get the documents?' });
  for (const option of ['Share the folder', 'Paste the documents', 'Point me at an export'])
    await expect(choice.locator('button', { hasText: option }), 'the person picks with a click').toBeVisible();
  await idle();
  const items = rt.store.items(thread.id);
  expect(items.filter((i) => i.kind === 'agent' && /To unblock/.test(i.text ?? '')).length, 'one reply').toBe(1);
  expect(
    items.some((i) => i.kind === 'agent' && i.lintReply),
    'no second reply, only the choice',
  ).toBe(false);
});
