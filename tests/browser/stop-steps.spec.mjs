// A stopped reply settles its steps (#288), driven with real clicks. The agent has a background job and a foreground
// call running when you press Stop, as in the p0 UAT:
// - Stop it too: the reply’s header doesn’t say “running”, and the foreground call reads as stopped;
// - Keep running: the header says its background work is running, not that the reply is, and the job keeps its row;
//   so it does when a card split the reply, and the steps are on its first part, which isn’t the stopped one.
// With a scripted Claude Code agent (no real turns or processes: the job’s process group is a fake), in a room of its
// own for each test. Moved from tools/check-stop-steps.mjs (#303).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

// The reply’s steps as the p0 UAT recorded them at its Stop (Postbox 0.30.1): a background loop with its job, a wait
// that had finished, and the same wait running when the person pressed Stop.
const BG = 'Append timestamps to heartbeat-2.log every 5 seconds for 3 minutes';
const WAIT = 'Wait 20 seconds, then count lines in heartbeat-2.log';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let dev;
test.beforeAll(async () => {
  app = await startPostbox('stop-steps');
  const { rt, store } = app;
  // The job’s process group: nothing is signaled, and ps shows its shell, so a kept job stays the job’s.
  rt.signalProcess = () => true;
  rt.listProcesses = async () => [{ pid: 4242, ppid: 1, pgid: 4242, command: "/bin/zsh -c source snapshot.sh && eval 'sh heartbeat.sh' < /dev/null" }];
  let n = 0;
  rt.adapters.register({
    name: 'claude-code',
    async folderFor() {
      return app.root;
    },
    async deliver(_session, message, ctx) {
      const id = `bgheart${++n}`;
      ctx.text('Started the loop.');
      ctx.activity({ id: `tu_${id}`, label: BG, state: 'running', job: id });
      ctx.job({ id, toolUseId: `tu_${id}`, label: BG, command: 'sh heartbeat.sh', outputFile: '/tmp/out.txt', state: 'running' });
      ctx.activity({ id: `tu_${id}_w1`, label: WAIT, state: 'done', ms: 21237 });
      // Asked for a card, it shows one and writes on: the reply is in two parts, with its steps on the first.
      if (/card/.test(message.text ?? '')) {
        ctx.tools.show_block({ block: { id: `card${n}`, type: 'card', version: 1, title: 'Heartbeat', fallback: 'The loop is running.' } });
        ctx.text('Checking it again.');
      }
      ctx.activity({ id: `tu_${id}_w2`, label: WAIT, state: 'running' });
      await new Promise((r) => ctx.signal.addEventListener('abort', r));
      ctx.job(ctx.signal.reason?.keepJobs?.length ? { id, kept: true, pgid: 4242 } : { id, state: 'stopped' });
    },
  });
  store.emit('project', { id: 'pr_steps', name: 'Stop steps', folder: app.root });
  dev = rt.createPersona({ handle: 'developer', backend: 'claude-code', permissionMode: 'auto' });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

/**
 * In a room of its own, starts the turn, waits for its job row and Stop, presses Stop and picks a choice in its ask,
 * and waits for the agent’s process to exit.
 */
async function stopWith(page, title, choice, text = 'Start a background loop that appends the time to heartbeat-2.log, and check it every 20 seconds.') {
  const { rt, store } = app;
  const room = rt.createThread({ projectId: 'pr_steps', title, personaIds: [dev.id] });
  const [se] = rt.sessionsIn(room.id);
  await page.goto(`${app.origin}/#/t/${room.id}`);
  await synced(page, app);
  rt.sendMessage(room.id, { text });
  await expect(page.locator('.bg-jobs li').first()).toBeVisible();
  await page.locator('.composer .btn.stop').click();
  await page.locator(choice === 'stop' ? '.stop-ask .btn.send' : '.stop-ask .btn:not(.send):not(.ghost)').click();
  await expect.poll(() => store.state.sessions[se.id].state, { message: 'the agent’s process to exit' }).toBe('idle');
  await synced(page, app);
}
/** The last reply’s header and its steps, and the last stopped tag. */
async function lastReply(page) {
  const d = page.locator('details.activity').last();
  await d.locator('> summary').click();
  const words = async (l) => (await l.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  return {
    header: (await words(d.locator('> summary')))[0],
    steps: await words(d.locator('.steps li .step-text')),
    tag: (await words(page.locator('.stopped-tag').last()))[0],
  };
}

test('#288 Stop it too: the stopped reply’s header doesn’t say running, and its foreground call reads stopped', async ({ page }) => {
  await stopWith(page, 'Stop it too', 'stop');
  await expect(page.locator('.bg-jobs li'), 'the job row goes').toHaveCount(0);
  const r = await lastReply(page);
  expect(r.tag).toMatch(/^Stopped by you at \d\d:\d\d$/);
  // Before #288: “Used 3 tools · 21 s in tools · running”.
  expect(r.header).not.toMatch(/running/);
  expect(r.steps).toEqual([`${BG} Stopped`, WAIT, `${WAIT} Stopped`]);
});

for (const [how, text] of [
  ['Keep running', undefined],
  [
    'Keep running, with a card between, where the steps are on the reply’s first part,',
    'Start the heartbeat loop, show me a card, and check it every 20 seconds.',
  ],
])
  test(`#288 ${how}: the header says its background work runs on, not the reply, and the wait reads stopped`, async ({ page }) => {
    await stopWith(page, how, 'keep', text);
    const r = await lastReply(page);
    expect(r.tag).toMatch(/^Stopped by you at \d\d:\d\d · its background work kept running$/);
    expect(r.header).toMatch(/^Used 3 tools · 21 s in tools · background work running$/);
    expect(r.steps).toEqual([`${BG} Running in the background`, WAIT, `${WAIT} Stopped`]);
    await expect(page.locator('.bg-jobs li button'), 'the kept job keeps its row, with its own Stop').toHaveCount(1);
    await page.locator('.bg-jobs li button').click();
    await expect(page.locator('.bg-jobs li'), 'the row goes').toHaveCount(0);
  });
