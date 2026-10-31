// Stop with background jobs (#126, #129), driven with real key presses and clicks:
// - a background job the agent started shows under its reply, running, with its own Stop;
// - Stop asks “@developer has 1 background job running. Stop it too?”, focus on its first choice, and Escape leaves
//   the agent running, with focus back on Stop;
// - Keep running stops the agent (it reads “stopping” until its process exits) and the job stays listed; its own Stop
//   then stops it;
// - a kept job Postbox couldn’t tell apart from another process (#164) says so under its row, and its Stop stops both;
// - Stop it too stops both; the ask’s colors are the tokens’, with amber only on its first choice; at 375 px it fits;
// - each stopped reply says why (#215, #249): “Stopped by you”, with its background work kept running after Keep
//   running, and “Interrupted by Send now” after a queued message’s Send now, whose job keeps running;
// - two kept jobs Postbox couldn’t tell apart share their processes (#167): stopping one ends the other as stopped.
// With a scripted Claude Code agent (no real turns or processes: the job’s process group is a fake), in a room of its
// own for each test. Moved from tools/check-stop.mjs (#303).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, focusIs, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** The job’s process group: signals are recorded, nothing is sent. */
const signals = [];
/** Sessions whose agent, once stopped, waits to exit until the test lets it, and how to let each go. */
const holdExit = new Set();
const exits = new Map();
let dev;

// …and ps shows the kept job’s shell, so Postbox knows the group is still the job’s, and a foreground call’s (#164).
const PROCS = [
  { pid: 4242, ppid: 1, pgid: 4242, command: "/bin/zsh -c source snapshot.sh && eval 'node tools/uat-run.mjs' < /dev/null" },
  { pid: 4343, ppid: 1, pgid: 4343, command: "/bin/zsh -c source snapshot.sh && eval 'sleep 600' < /dev/null" },
];

test.beforeAll(async () => {
  app = await startPostbox('stop');
  const { rt, store } = app;
  rt.signalProcess = (pid, sig) => {
    if (sig !== 0) signals.push([pid, sig]);
    return true;
  };
  rt.listProcesses = async () => PROCS;
  // A Claude Code agent that starts a background job, then works until it’s stopped.
  let n = 0;
  rt.adapters.register({
    name: 'claude-code',
    async folderFor() {
      return app.root;
    },
    async deliver(session, message, ctx) {
      if (!/job/.test(message.text ?? '')) return ctx.text('Done.');
      n += 1;
      // Asked for two, it starts a second job beside the first (#167).
      const jobs = [{ id: `bgjob${n}`, label: 'Run the mixed-room UAT scenario live', command: 'node tools/uat-run.mjs' }];
      if (/two jobs/.test(message.text ?? '')) jobs.push({ id: `bgjob${n}b`, label: 'Tail the UAT log', command: 'tail -f uat.log' });
      ctx.text('Starting the UAT run in the background.');
      for (const j of jobs) {
        ctx.activity({ id: `tu_${j.id}`, label: j.label, state: 'running', job: j.id });
        ctx.job({ id: j.id, toolUseId: `tu_${j.id}`, label: j.label, command: j.command, outputFile: '/tmp/out.txt', state: 'running' });
      }
      await new Promise((r) => ctx.signal.addEventListener('abort', r));
      // Asked to say it’s unsure, it keeps both shells, as for a job Postbox couldn’t tell apart (#164), for each job.
      const groups = /unsure/.test(message.text ?? '') ? PROCS.map((p) => ({ pgid: p.pgid, command: p.command })) : undefined;
      for (const { id } of jobs) ctx.job(ctx.signal.reason?.keepJobs?.length ? { id, kept: true, pgid: 4242, groups } : { id, state: 'stopped' });
      if (holdExit.has(session.id)) await new Promise((r) => exits.set(session.id, r));
    },
  });
  store.emit('project', { id: 'pr_stop', name: 'Stop', folder: app.root });
  dev = rt.createPersona({ handle: 'developer', backend: 'claude-code', permissionMode: 'auto' });
});
test.afterAll(async () => {
  for (const exit of exits.values()) exit();
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

/**
 * A room of its own with @developer, open in the page, with a turn that started a background job. Returns the room,
 * the session, and helpers to read its state, its latest step and the latest stopped reply’s tag.
 */
async function withJob(page, title, text = 'Run the UAT job, please.') {
  const { rt, store } = app;
  const room = rt.createThread({ projectId: 'pr_stop', title, personaIds: [dev.id] });
  const [se] = rt.sessionsIn(room.id);
  await page.goto(`${app.origin}/#/t/${room.id}`);
  await synced(page, app);
  rt.sendMessage(room.id, { text });
  await expect(page.locator('.bg-jobs li').first(), 'the background job row').toBeVisible();
  const state = () => store.state.sessions[se.id].state;
  const step = () =>
    store
      .items(room.id)
      .filter((i) => i.kind === 'agent' && i.activity?.steps?.length)
      .at(-1)?.activity.steps[0];
  const lastTag = async () => {
    await synced(page, app);
    return (await page.locator('.stopped-tag').last().allInnerTexts()).join('');
  };
  const idle = () => expect.poll(state, { message: 'the agent’s process to exit' }).toBe('idle');
  return { room, se, state, step, lastTag, idle };
}
const stopButton = (page) => page.locator('.composer').getByRole('button', { name: 'Stop @developer’s reply', exact: true });
const ask = (page) => page.locator('.stop-ask');
const choice = (page, name) => ask(page).getByRole('button', { name, exact: true });
const UAT = 'Run the mixed-room UAT scenario live';
/** A background job’s own Stop, by the job’s label. */
const jobStop = (page, label = UAT) => page.locator('.bg-jobs').getByRole('button', { name: `Stop the background job “${label}”`, exact: true });
const words = async (locator) => (await locator.allInnerTexts()).join(' ').replace(/\s+/g, ' ').trim();
const color = (page, v) =>
  page.evaluate((value) => {
    const p = document.createElement('span');
    p.style.color = value;
    document.body.append(p);
    const c = getComputedStyle(p).color;
    p.remove();
    return c;
  }, v);
/**
 * The signals sent since then, but a SIGKILL to group 4242: every job here shares it, and a Stop sends it SIGKILL once
 * its grace period is over (stopPgid), whenever that lands, an earlier test’s too (#244). Any other, a stray kill
 * included, still shows.
 */
const sentSince = (before) => signals.slice(before).flatMap(([pid, sig]) => (pid === -4242 && sig === 'SIGKILL' ? [] : [`${pid} ${sig}`]));
/** Stops the agent and keeps its jobs running, from the ask’s second choice, and waits for its process to exit. */
async function keepRunning(page, idle) {
  await stopButton(page).click();
  await expect(ask(page)).toBeVisible();
  await choice(page, 'Keep running').click();
  await idle();
}

test('#129 a background job shows under its reply, running, with its own Stop', async ({ page }) => {
  await withJob(page, 'Shown');
  expect(await words(page.locator('.bg-jobs li'))).toMatch(/^Background job · Run the mixed-room UAT scenario live Stop$/);
  await expect(page.locator('.bg-jobs li button[aria-label^="Stop the background job"]')).toHaveCount(1);
  // Calm: the glyph holds still, in the quiet color, not amber.
  const g = await page.locator('.bg-jobs .g-running').evaluate((n) => ({ anim: getComputedStyle(n).animationName, color: getComputedStyle(n).color }));
  expect(g).toEqual({ anim: 'none', color: await color(page, 'var(--dim)') });
});

test('#129 Stop asks first, with focus on its first choice; Escape leaves the agent running, focus back on Stop', async ({ page }) => {
  const { rt, store } = app;
  const { se } = await withJob(page, 'Asks');
  await stopButton(page).click();
  await expect(ask(page)).toBeVisible();
  expect(await words(ask(page))).toMatch(/^@developer has 1 background job running\. Stop it too\? Stop it too Keep running$/);
  await focusIs(page, 'button: Stop it too');
  expect(rt.turns.has(se.id), 'nothing stopped yet').toBe(true);
  // Amber only on the interactive control: the row’s edge is a token line, the first choice’s the accent.
  const row = await ask(page).evaluate((n) => getComputedStyle(n).borderTopColor);
  const first = await ask(page)
    .locator('.btn.send')
    .evaluate((n) => getComputedStyle(n).borderTopColor);
  const accent = await color(page, 'var(--accent)');
  expect([first, row]).toEqual([accent, await color(page, 'var(--line)')]);
  expect(row, 'the row’s edge isn’t amber').not.toBe(accent);
  await page.keyboard.press('Escape');
  // The ask goes once the server has cleared it and the page has heard so.
  await expect.poll(() => store.state.sessions[se.id].stopAsk, { message: 'the server to clear the ask' }).toBe(null);
  await expect(ask(page)).toHaveCount(0);
  await expect(stopButton(page), 'focus back on Stop').toBeFocused();
  expect(rt.turns.has(se.id), 'the agent carries on').toBe(true);
});

test('#126 #129 Keep running, by keyboard: the agent reads stopping until it exits, and the job stays listed with its Stop', async ({ page }) => {
  const { store } = app;
  const { se, state, step, lastTag, idle } = await withJob(page, 'Keeps');
  holdExit.add(se.id);
  await stopButton(page).click();
  await expect(ask(page)).toBeVisible();
  await page.keyboard.press('Tab');
  await focusIs(page, 'button: Keep running');
  await page.keyboard.press('Enter');
  await expect.poll(state, { message: 'stopping' }).toBe('stopping');
  await expect(page.locator('.transcript .who-state', { hasText: 'stopping' }), '“· stopping” beside the name').toBeVisible();
  exits.get(se.id)?.();
  await idle();
  await expect(ask(page)).toHaveCount(0);
  await expect(page.locator('.composer .btn.send'), 'Send back').toBeVisible();
  expect(step().state).toBe('running');
  await expect(page.locator('.bg-jobs li button'), 'still listed, with its own Stop').toHaveCount(1);
  expect(store.state.sessions[se.id].context.join('\n')).toMatch(/bgjob\d+ .* is still running/);
  expect(await lastTag()).toMatch(/^Stopped by you at \d\d:\d\d · its background work kept running$/);
  // Its own Stop ends it, as a person would before going on: a kept job left running would answer a later test’s Stop
  // too, since Postbox stops every kept job that shares its process group (#167).
  await jobStop(page).click();
  await expect(page.locator('.bg-jobs li'), 'the row goes').toHaveCount(0);
});

test('#129 the kept job’s own Stop stops its process group, and its step reads stopped', async ({ page }) => {
  const { step, idle } = await withJob(page, 'Kept job');
  await keepRunning(page, idle);
  const before = signals.length;
  await jobStop(page).click();
  await expect(page.locator('.bg-jobs li'), 'the row goes').toHaveCount(0);
  expect(sentSince(before)).toEqual(['-4242 SIGINT']);
  expect(step().state).toBe('stopped');
  await page.locator('details.activity > summary').click();
  await expect(page.locator('details.activity .steps li').first()).toContainText(/Run the mixed-room UAT scenario live\s*Stopped/);
});

test('#129 Stop it too stops the agent and its job', async ({ page }) => {
  const { store } = app;
  const { se, step, lastTag, idle } = await withJob(page, 'Both');
  await stopButton(page).click();
  await choice(page, 'Stop it too').click();
  await idle();
  await expect(page.locator('.bg-jobs li')).toHaveCount(0);
  await expect(ask(page)).toHaveCount(0);
  expect(step().state).toBe('stopped');
  expect(store.state.sessions[se.id].jobs).toEqual([]);
  expect(await lastTag()).toMatch(/^Stopped by you at \d\d:\d\d$/);
});

test('#164 a kept job Postbox couldn’t tell apart says so under its row, and its own Stop stops every process it kept', async ({ page }) => {
  const { step, idle } = await withJob(page, 'Unsure', 'Run the UAT job, unsure which shell.');
  await keepRunning(page, idle);
  await expect(page.locator('.bg-jobs .job-note'), 'the note under the job').toBeVisible();
  expect(await words(page.locator('.bg-jobs li'))).toMatch(
    /^Background job · Run the mixed-room UAT scenario live Postbox couldn’t tell which of 2 processes is this job, so it kept them all running; stopping the job stops them all\. Stop$/,
  );
  // PB_SHOT=<file.png> saves the reply with its job row, light as the UAT docs’ screenshots are.
  if (process.env.PB_SHOT) await page.locator('.bg-jobs').locator('..').screenshot({ path: process.env.PB_SHOT });
  const before = signals.length;
  await jobStop(page).click();
  await expect(page.locator('.bg-jobs li'), 'the row goes').toHaveCount(0);
  expect(sentSince(before)).toEqual(['-4242 SIGINT', '-4343 SIGINT']);
  expect(step().state).toBe('stopped');
});

test('#167 two kept jobs Postbox couldn’t tell apart: stopping one stops both, and the other’s step says why', async ({ page }) => {
  const { idle } = await withJob(page, 'Two jobs', 'Run two jobs, unsure which shell.');
  await keepRunning(page, idle);
  await expect(page.locator('.bg-jobs li'), 'both job rows').toHaveCount(2);
  await jobStop(page).click();
  await expect(page.locator('.bg-jobs li'), 'both rows go').toHaveCount(0);
  await page.locator('details.activity > summary').last().click();
  const rows = await page.locator('details.activity').last().locator('.steps li .step-text').allInnerTexts();
  expect(rows.map((t) => t.replace(/\s+/g, ' ').trim())).toEqual([
    'Run the mixed-room UAT scenario live Stopped',
    'Tail the UAT log Stopped: Postbox couldn’t tell its processes from those of the background job “Run the mixed-room UAT scenario live”, so stopping that job stopped this one too.',
  ]);
});

test('#215 a queued message’s Send now: the reply it interrupted says so, and its job keeps running', async ({ page }) => {
  const { rt, store } = app;
  const { room, se, state, lastTag } = await withJob(page, 'Send now');
  rt.sendMessage(room.id, { text: 'A one-line status, please.' });
  const queuedButton = page.getByRole('button', { name: new RegExp(`message.*queued for @${se.handle}`) });
  await expect(queuedButton, 'the queued message').toBeVisible();
  await queuedButton.click();
  await page.locator('.agent-queue-row').getByRole('button', { name: 'Send now', exact: true }).click();
  await expect
    .poll(() => state() === 'idle' && store.state.sessions[se.id].jobs.some((j) => j.kept), { message: 'the next turn, with the job kept' })
    .toBe(true);
  expect(await lastTag()).toMatch(/^Interrupted by Send now at \d\d:\d\d$/);
  await expect(page.locator('.bg-jobs li button'), 'still listed, with its own Stop').toHaveCount(1);
  await page.locator('.bg-jobs li button').click();
  await expect(page.locator('.bg-jobs li'), 'the row goes').toHaveCount(0);
});

/**
 * What a selector finds that sticks out of a window that wide, or out of its own box. The width is the test’s: on a
 * phone, a page that overflows widens innerWidth to fit, so it would never stick out of that.
 */
const overflowing = (page, selector, width = 375) =>
  page.evaluate(
    ([sel, w]) =>
      [...document.querySelectorAll(sel)]
        .filter((n) => {
          const b = n.getBoundingClientRect();
          return b.right > w + 1 || b.left < -1 || n.scrollHeight > n.clientHeight + 1;
        })
        .map((n) => n.className || n.textContent),
    /** @type {const} */ ([selector, width]),
  );

test.describe('at 375 px', () => {
  test.use({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test('#129 #215 at 375 px the ask, the job row and each stopped reply’s tag fit without scrolling sideways', async ({ page }) => {
    const { rt } = app;
    const { room, se, idle } = await withJob(page, 'Narrow');
    await keepRunning(page, idle); // First stopped reply has Keep running’s longest tag.
    await expect(page.locator('.stopped-tag'), 'Keep running’s tag').toHaveCount(1);
    expect(await overflowing(page, '.bg-jobs li, .stopped-tag'), 'the job row and Keep running’s tag').toEqual([]);
    rt.sendMessage(room.id, { text: 'Run the UAT job again.' });
    await expect(page.locator('.bg-jobs li'), 'the second job’s row').toHaveCount(2);
    rt.sendMessage(room.id, { text: 'A one-line status, please.' });
    await synced(page, app);
    await page.locator('#conversation-actions').click();
    await page.getByRole('menuitem', { name: new RegExp(`message.*queued for @${se.handle}`) }).click();
    await page.locator('.agent-queue-row').getByRole('button', { name: 'Send now', exact: true }).click();
    await expect(page.locator('.stopped-tag', { hasText: 'Interrupted by Send now' })).toBeVisible();
    await idle();
    await expect(page.locator('.stopped-tag'), 'both stopped replies’ tags, to measure').toHaveCount(2);
    expect(await overflowing(page, '.bg-jobs li, .stopped-tag'), 'the job rows and the tags').toEqual([]);
    rt.sendMessage(room.id, { text: 'Run the UAT job a third time.' }); // Then a third job, and Stop’s ask.
    await expect(page.locator('.bg-jobs li'), 'the third job’s row').toHaveCount(3);
    await expect.poll(() => rt.turns.has(se.id), { message: 'the third turn' }).toBe(true);
    await stopButton(page).click();
    await expect(ask(page)).toBeVisible();
    expect(await overflowing(page, '.stop-ask, .stop-ask button, .bg-jobs li, .stopped-tag'), 'the ask, beside them').toEqual([]);
    await choice(page, /^Stop (it|them) too$/).click();
    await idle();
    // The two kept jobs share a process group, so one’s Stop ends both (#167): none is left running.
    await expect(jobStop(page)).toHaveCount(2);
    await jobStop(page).nth(0).click();
    await expect(page.locator('.bg-jobs li')).toHaveCount(0);
  });
});
