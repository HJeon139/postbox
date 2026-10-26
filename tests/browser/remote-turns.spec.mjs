// Agents whose turns run on a host (#120), with axe at 1280 px:
// - the agents list and each ring say where an agent runs, when Postbox last heard from the host, and the
//   connection in words: Connected, Reconnecting, Disconnected (working) and Disconnected (idle);
// - the transcript shows each turn state in words: “Sign-in needed on <host>” and “Interrupted on <host>”, each with
//   Resume, which goes through the runtime’s resumeRemote and starts with why the last turn stopped; a hung turn’s
//   note; Lost, with no Retry; a stop the host hasn’t confirmed; and a replayed reply once, not twice;
// - permission cards a host ended say how: expired with nobody answering, canceled by the agent, or ended unrecorded;
// - a Kiro CLI turn on a host shows its warning as a notice, and a `!` command says it ran on this computer.
// Stop, the agent’s panel, the `!` hint, the persona sheet’s Runs on, and 375 px are tests/browser/remote-stop.spec.mjs.
// On the seeded room of tests/browser/remote-turns.mjs. Moved from tools/check-remote-turns.mjs (#303).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, synced } from './postbox.mjs';
import { axe } from './remote-hosts.mjs';
import { HUNG, startRemoteTurns } from './remote-turns.mjs';

/** @type {Awaited<ReturnType<typeof startRemoteTurns>>} */
let s;
test.beforeAll(async () => {
  s = await startRemoteTurns('remote-turns');
});
test.afterAll(async () => {
  await s?.app.stop();
});
failOnPageErrors(test);

async function open(page) {
  await page.goto(`${s.app.origin}/#/t/${s.room.id}`);
  await synced(page, s.app);
  await expect(item(page, s.items.signin).getByRole('alert'), 'the room’s replies').toBeVisible();
}
/** An agent’s row in the sidebar’s Agents, and its ring there. */
const row = (page, handle) => page.locator('.rail .agent-row').filter({ has: page.locator('.agent-btn b', { hasText: new RegExp(`^@${handle}$`) }) });
const ring = (page, handle) => row(page, handle).getByRole('img', { name: new RegExp(`^@${handle}: `) });
/** A transcript item, by the item the seed made. */
const item = (page, it) => page.locator(`.transcript [data-key="${it.id}"]`);

test('#120 the agents list says each remote agent’s host, when it was last heard from, and the connection in words', async ({ page }) => {
  await open(page);
  await expect.soft(row(page, 'coder')).toContainText('On host.example.com · Connected · last heard from 2 min ago');
  await expect.soft(row(page, 'tester')).toContainText('On gpu.example.com · Reconnecting · last heard from 5 min ago');
  await expect.soft(row(page, 'builder')).toContainText('On build.example.com · Disconnected (working) · last heard from 40 min ago');
  await expect.soft(row(page, 'builder')).toContainText('Lost: Postbox can’t reach build.example.com, and the turn may still run there');
  await expect.soft(row(page, 'idler')).toContainText('On build.example.com · Disconnected (idle) · last heard from 40 min ago');
  await expect.soft(row(page, 'coder')).toContainText('Sign-in needed on host.example.com');
  await expect.soft(row(page, 'stopper')).toContainText('Stopping on host.example.com: Postbox waits for the host to confirm');
  // Codex’s `auto`, and a Claude model a Codex persona kept, read as Codex’s default.
  await expect.soft(row(page, 'cx')).toContainText('Codex’s default · medium effort');
  await expect.soft(row(page, 'cx')).not.toContainText('Opus');
});

test('#120 each ring’s label says where its agent runs and the connection, not by color alone', async ({ page }) => {
  await open(page);
  await test.step('as each host stands', async () => {
    await expect
      .soft(ring(page, 'builder'))
      .toHaveAttribute(
        'aria-label',
        /^@builder: Idle, (?:\d+% of context used|context unknown); on build\.example\.com, disconnected \(working\), last heard from 40 min ago$/,
      );
    await expect.soft(ring(page, 'coder')).toHaveAttribute('aria-label', /; on host\.example\.com, connected, last heard from 2 min ago$/);
  });
  await test.step('a change to the host’s status reaches the rings and the rows without a session change', async () => {
    const was = s.hosts.status(s.C.id);
    s.hosts.set(s.C.id, { state: 'connected', failure: null, welcome: null, lastHeard: Date.now(), name: s.C.name });
    await expect(row(page, 'tester')).toContainText('On gpu.example.com · Connected · last heard from just now');
    await expect(ring(page, 'tester')).toHaveAttribute('aria-label', /connected, last heard from just now/);
    s.hosts.set(s.C.id, was);
  });
});

test('#120 the turn states read in words in the transcript: Sign-in needed and Interrupted with Resume, hung, Lost', async ({ page }) => {
  await open(page);
  const { signin, interrupted, hung, lost } = s.items;
  await expect
    .soft(item(page, signin).getByRole('alert'))
    .toHaveText(/^Sign-in needed on host\.example\.com · Sign in there, then resume @coder\. Resume it once you’ve signed in\.\s*Resume$/);
  await expect
    .soft(item(page, interrupted).getByRole('alert'))
    .toHaveText(
      /^Interrupted on host\.example\.com · The agent’s process there ended without finishing its turn\. It was interrupted again after Postbox resumed it, so it waits for you\.\s*Resume$/,
    );
  await expect.soft(item(page, hung).locator('.stopped-tag')).toHaveText(HUNG);
  await expect
    .soft(item(page, lost).getByRole('alert'))
    .toHaveText(
      /^Lost: Postbox can’t reach build\.example\.com · The connection to build\.example\.com gave up\. The turn may still be running there\. Postbox attaches to it again once the host is back\.$/,
    );
  // Retry would start over on the host, not resume: it isn’t offered for any of them.
  await expect.soft(page.locator('.host-callout').getByRole('button', { name: /Retry/ })).toHaveCount(0);
  await expect
    .soft(page.locator('.host-turns'))
    .toHaveText(
      /^@stopper · Stopping on host\.example\.com: Postbox asked it to stop, and waits for the host to confirm\. It may still run there until then\.$/,
    );
});

test('#120 a replayed reply shows once, with its name, and a Kiro turn’s warning is a notice above it', async ({ page }) => {
  await open(page);
  const { replaced, replay } = s.items;
  const scouts = page
    .locator('.transcript .item')
    .filter({ visible: true })
    .filter({ hasText: /I read the README|@scout/ });
  await expect.soft(scouts, 'one reply from @scout').toHaveCount(1);
  await expect.soft(item(page, replaced), 'the replaced part doesn’t show').toBeHidden();
  await expect.soft(item(page, replay).locator('.who'), 'it names its speaker').toContainText('@scout');
  const notice = item(page, replay).getByRole('note', { name: 'Other users on the host can read this message' });
  await expect.soft(notice).toHaveText(/^Other users on the host can read this message Kiro CLI takes its message as a command-line argument/);
  // The notice isn’t folded into the steps, and isn’t counted as a tool.
  await expect.soft(item(page, replay).locator('details.activity summary')).toHaveText('Read 1 file · 0.0 s in tools');
});

test('#120 permission cards a host ended say how: nobody answered in time, canceled by the agent, or ended unrecorded', async ({ page }) => {
  await open(page);
  // The answered cards in the room, in order: the three a host ended, and nothing else.
  await expect(page.locator('.transcript .block.answered .answered-note')).toHaveText([
    'Expired: nobody answered in time',
    'Canceled by the agent',
    'Ended: Postbox couldn’t save the expiry',
  ]);
});

test('#120 a ! command run while the agent works on a host says it ran on this computer, once', async ({ page }) => {
  await open(page);
  const cmd = item(page, s.items.command);
  await expect.soft(cmd.locator('.cmd-where')).toHaveText(['Ran on this computer, not on host.example.com.']);
  // Its output starts with the command’s, without the line the runtime put first for the agents.
  await expect.soft(cmd.locator('.cmd-out')).toHaveText('On branch main');
});

test('#120 axe finds no violations in the room at 1280 px', async ({ page }) => {
  await open(page);
  expect(await axe(page)).toEqual([]);
});

// Last: it resumes @coder, so the room no longer shows Sign-in needed.
test('#120 Resume calls the runtime’s resume, which starts with why the last turn stopped, and Resume goes', async ({ page }) => {
  const { rt, store } = s.app;
  await open(page);
  const before = s.delivered.length;
  const resume = page.getByRole('button', { name: 'Resume @coder on host.example.com', exact: true });
  await resume.click();
  await expect.poll(() => s.delivered.length, { message: 'the resumed turn' }).toBeGreaterThan(before);
  const d = /** @type {(typeof s.delivered)[number]} */ (s.delivered.at(-1));
  expect.soft(d.remote, 'it ran through the remote path').toBe(true);
  expect
    .soft(d.context.join('\n'))
    .toMatch(/^\[Postbox\] Your last turn on host\.example\.com stopped before it finished, because the sign-in on that host had run out\./);
  expect.soft(d.text).toMatch(/The person asked you to resume/);
  await expect(resume, 'Resume goes').toHaveCount(0);
  await expect.poll(() => rt.turns.has(s.ses.coder.id), { message: 'the turn to end' }).toBe(false);
  expect(store.state.sessions[s.ses.coder.id].remoteTurn.state).toBe('done');
});
