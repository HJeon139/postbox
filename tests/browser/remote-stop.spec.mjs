// What Stop, the agent’s panel, the `!` hint and the persona sheet say of a host (#120), with axe at 1280 and 375 px:
// - Stop says beforehand that the host’s background jobs stop with the turn, never offers to keep them, and a job’s
//   own Stop isn’t offered; the agent’s panel says where it runs, and its Stop says what stops with it;
// - the composer’s `!` hint says it runs on this computer, not on the host;
// - the persona sheet’s Runs on offers this computer or a host, only a host for a backend not on this computer, says
//   what the host’s daemon found, and shows the server’s refusal; Codex’s `auto` reads as Codex’s default;
// - at 375 px the states, cards, notes and the sheet fit.
// The agents list, the rings and the transcript’s turn states are tests/browser/remote-turns.spec.mjs. On the seeded
// room of tests/browser/remote-turns.mjs. Moved from tools/check-remote-stop.mjs (#303).

import { expect, test } from '@playwright/test';
import { allowPageError, failOnPageErrors, synced, windowWidth } from './postbox.mjs';
import { axe, overflowing } from './remote-hosts.mjs';
import { startRemoteTurns } from './remote-turns.mjs';

/** @type {Awaited<ReturnType<typeof startRemoteTurns>>} */
let s;
test.beforeAll(async () => {
  s = await startRemoteTurns('remote-stop');
});
test.afterAll(async () => {
  await s?.app.stop();
});
failOnPageErrors(test);

const NOTE = 'Stop also stops @runner’s background job on host.example.com: a job on a host stops with its turn.';
const words = async (locator) => (await locator.allInnerTexts()).join(' ').replace(/\s+/g, ' ').trim();
const jobRow = (page) => page.locator('.bg-jobs li');
const stopButton = (page) => page.locator('.composer').getByRole('button', { name: 'Stop @runner’s reply', exact: true });
const dialog = (page) => page.locator('.dialog');
const where = (page) => page.getByLabel('Runs on', { exact: true });

async function open(page, thread, ready = page.locator('#composer-input')) {
  await page.goto(`${s.app.origin}/#/t/${thread.id}`);
  await synced(page, s.app);
  await expect(ready).toBeVisible();
}
/** @runner in its DM, with a turn on the host that started a background job. */
async function withJob(page, text) {
  await open(page, s.dm);
  s.app.rt.sendMessage(s.dm.id, { text });
  await expect(jobRow(page), 'the background job row').toBeVisible();
  await expect(page.locator('.stop-note'), 'the note before Stop').toBeVisible();
}
const stopped = () => expect.poll(() => s.app.rt.turns.has(s.runner.id), { message: 'the turn to stop' }).toBe(false);
/** A persona’s sheet, open on its Runs on. */
async function sheet(page, persona) {
  await page.evaluate((id) => import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', id)), persona.id);
  await expect(where(page), 'Runs on').toBeVisible();
}
/** Codex’s sheet, moved to a host whose daemon didn’t find Codex, and saved: the server refuses. */
async function refused(page) {
  await sheet(page, s.cx);
  await where(page).selectOption(s.A.id);
  await expect(page.locator('#pe-where-missing'), 'Codex wasn’t found there').toBeVisible();
  // The page logs the server’s refusal of the save.
  allowPageError(page, /status of 422/);
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#pe-where-err'), 'the server’s refusal').toBeVisible();
}

test('#120 Stop says first that the host’s background jobs stop with the turn, keeps none, and a job has no Stop of its own', async ({ page }) => {
  const { rt, store } = s.app;
  await withJob(page, 'Run the job, please.');
  expect.soft(await words(jobRow(page))).toBe('Background job · Run the whole test suite A job on a host stops with its turn. Stop @runner to stop it.');
  await expect.soft(jobRow(page).getByRole('button'), 'no Stop of its own').toHaveCount(0);
  await expect.soft(page.locator('.stop-note')).toHaveText(NOTE);
  await expect.soft(stopButton(page), 'Stop is described by the note').toHaveAccessibleDescription(NOTE);
  // A job’s own Stop on a remote turn is refused by the runtime too, in the same words.
  await expect(rt.stopJob(s.runner.id, 'bgjob1')).rejects.toThrow(/A job on a host stops with its turn/);
  expect.soft(await axe(page), 'axe, with the note and the job row').toEqual([]);
  await stopButton(page).click();
  await stopped();
  await expect.soft(page.locator('.stop-ask'), 'it never asks whether to keep the jobs').toHaveCount(0);
  expect(store.state.sessions[s.runner.id].stopAsk ?? null).toBe(null);
});

test('#120 the agent’s panel says where it runs, and its Stop says what stops with it', async ({ page }) => {
  await withJob(page, 'Run the job again.');
  await page.locator('.rail .agent-row .agent-btn').filter({ hasText: '@runner' }).click();
  const panel = page.locator('.dialog.quick');
  await expect(panel.locator('.qp-stop-note'), 'the panel’s note').toBeVisible();
  await expect.soft(panel.getByRole('region', { name: 'Where @runner runs' })).toHaveText(/^On host\.example\.com · Connected · last heard from 2 min ago$/);
  await expect.soft(panel.locator('.qp-stop-note')).toHaveText(/a job on a host stops with its turn\.$/);
  expect.soft(await axe(page), 'axe, with the panel open').toEqual([]);
  await panel.locator('.qp-actions').getByRole('button', { name: 'Stop', exact: true }).click();
  await stopped();
});

test('#120 the ! hint says it runs on this computer, in the project’s folder, not on the host', async ({ page }) => {
  await open(page, s.dm);
  await page.locator('#composer-input').fill('!ls');
  await expect(page.locator('[data-mode="shell"]')).toHaveText(
    `Runs in ${s.app.root} on this computer, not on host.example.com, as you, with Enter. The agents read it and its output on their next turn.`,
  );
});

/** Each of Runs on’s choices: its words, whether it’s disabled, and whether it’s chosen. */
const choices = (page) =>
  where(page).evaluate((sel) => [.../** @type {HTMLSelectElement} */ (sel).options].map((o) => [o.textContent, o.disabled, o.selected]));

test('#120 the persona sheet’s Runs on offers this computer or a host', async ({ page }) => {
  await open(page, s.solo);
  await sheet(page, s.coder);
  expect.soft(await choices(page)).toEqual([
    ['This computer', false, false],
    ['host.example.com', false, true],
    ['build.example.com', false, false],
    ['gpu.example.com', false, false],
  ]);
  await expect
    .soft(page.locator('#pe-where-help'))
    .toHaveText(/^Its turns run on host\.example\.com, over your own ssh; Postbox and its tools stay on this computer\.$/);
  await expect.soft(page.locator('label[for="pe-b"]')).toHaveText('Backend');
});

test('#120 Codex runs only on a host, says what the daemon found, and the server’s refusal shows under Runs on', async ({ page }) => {
  await open(page, s.solo);
  await test.step('Codex isn’t on this computer: only a host, and the model reads as Codex’s default', async () => {
    await sheet(page, s.cx);
    await expect(page.locator('#pe-b')).toHaveValue('codex');
    expect.soft((await choices(page))[0]).toEqual(['This computer (Codex isn’t here)', true, false]);
    await expect.soft(page.locator('#pe-b option:checked')).toHaveText('Codex (on a host only)');
    await expect.soft(page.locator('#pe-m')).toHaveValue('auto');
    await expect.soft(page.locator('.field').filter({ has: page.locator('#pe-m') })).toContainText('auto is Codex’s default');
    expect.soft(await axe(page), 'axe, on the persona sheet').toEqual([]);
  });
  await test.step('on a host whose daemon didn’t find Codex, it says so before saving, as the select’s own error', async () => {
    await where(page).selectOption(s.A.id);
    await expect(page.locator('#pe-where-missing')).toHaveText(
      /^Codex wasn’t found on host\.example\.com: Postbox’s daemon looked in \/home\/user\/\.local\/bin, \/usr\/local\/bin\. Install it there, or set its path in the host’s settings\.$/,
    );
    await expect.soft(where(page)).toHaveAttribute('aria-describedby', 'pe-where-help pe-where-missing');
    await expect.soft(where(page)).toHaveAttribute('aria-invalid', 'true');
  });
  await test.step('Save: the server’s refusal shows under Runs on, with focus there, and nothing changes', async () => {
    allowPageError(page, /status of 422/);
    await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#pe-where-err'), 'the server’s refusal').toHaveText(
      /^Codex isn’t installed on host\.example\.com, so this agent can’t run there\./,
    );
    await expect.soft(where(page)).toHaveAttribute('aria-describedby', 'pe-where-help pe-where-missing pe-where-err');
    await expect.soft(where(page), 'focus on Runs on').toBeFocused();
    expect(s.app.rt.persona(s.cx.id).remote.hostId, 'unchanged').toBe(s.B.id);
  });
});

test.describe('at 375 px', () => {
  test.use({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test('#120 at 375 px the states, cards, notes and the sheet fit, and axe finds no violations', async ({ page }) => {
    await test.step('the persona sheet, with Runs on’s error and the server’s refusal', async () => {
      await open(page, s.solo);
      await refused(page);
      // Within the sheet, and the sheet within the window: its tabs row wraps at 375 px.
      const spill = await dialog(page).evaluate((d, w) => {
        const box = d.getBoundingClientRect();
        const f = /** @type {HTMLElement} */ (document.querySelector('#pe-where')?.closest('.field'));
        const out = [f, ...f.querySelectorAll('*')].filter((n) => n.getBoundingClientRect().right > box.right + 1).map((n) => n.className || n.tagName);
        return box.right > w + 1 ? [...out, 'the sheet'] : out;
      }, windowWidth(page));
      expect.soft(spill).toEqual([]);
      expect.soft(await axe(page), 'axe, on the persona sheet').toEqual([]);
    });
    await test.step('the room’s turn states, cards and notes', async () => {
      await open(page, s.room, page.locator(`.transcript [data-key="${s.items.signin.id}"] .host-callout`));
      expect
        .soft(await overflowing(page, '.host-callout, .host-callout button, .host-notice, .stopped-tag, .host-turn, .block.answered, .cmd-where'))
        .toEqual([]);
      expect.soft(await axe(page), 'axe, in the room').toEqual([]);
    });
    await test.step('Stop’s note and the job row', async () => {
      await withJob(page, 'Run the job once more.');
      expect.soft(await overflowing(page, '.stop-note, .bg-jobs li, .job-host')).toEqual([]);
      expect.soft(await axe(page), 'axe, with the note').toEqual([]);
      s.app.rt.stop(s.runner.id);
      await stopped();
    });
  });
});

test('#436 Kiro host privacy is explained in persona setup', async ({ page }) => {
  await open(page, s.solo);
  await sheet(page, s.app.rt.personaByHandle('scout'));
  await expect(page.locator('#pe-where-help')).toContainText(
    'Kiro CLI puts each message in the host’s process arguments, which other users there may be able to read; use a private host for sensitive work.',
  );
});
