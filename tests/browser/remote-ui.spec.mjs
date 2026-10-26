// The remote-hosts UI (#120) in one running Postbox, at 1280 and at 375 px, with axe and nothing running off the
// window:
// - an agent placed on a host: its ring says where it runs and the connection, and at 1280 its row in the agents list
//   says it too;
// - the Work view of its conversation has the host’s one line: its files there aren’t recorded;
// - Settings has a Hosts tab with the host’s card, and the tabs row fits the window at 375 px (it wraps);
// - the persona sheet’s Runs on names the host the agent runs on.
// With a fake host manager (tests/browser/remote-hosts.mjs) and no turn run: the Work view is fed two recorded Claude
// Code turns (tests/fixtures/claude-code/ledger-*.jsonl) as turns on the host. Moved from tools/check-remote-ui.mjs (#303).

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createStreamMapper } from '../../server/adapters/claude-stream.mjs';
import { failOnPageErrors, synced } from './postbox.mjs';
import { axe, overflowing, startRemote } from './remote-hosts.mjs';

/** @type {Awaited<ReturnType<typeof startRemote>>['app']} */
let app;
let host;
let persona;
let conv;
const MIN = 60_000;
const NOTE = 'Files on host.example.com aren’t recorded: Postbox lists the ones @builder edited there, with no diff and no Restore.';

const fixture = (name) =>
  readFileSync(new URL(`../fixtures/claude-code/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

/** A recorded turn, through the real stream mapper into the ledger, as a turn @builder ran on the host. */
async function hostTurn(se, i, name) {
  const { rt, store } = app;
  const turn = { id: `turn_remote_${i + 1}`, threadId: conv.id, startedAt: Date.now(), remote: { hostId: host.id } };
  // What the runtime keeps on the session for a host turn: its folder on the host. The turn is over (done).
  rt.updateSession(se.id, { remoteTurn: { hostId: host.id, turn: `host-${turn.id}`, rtTurn: turn.id, folder: '/workspace/rec', state: 'done' } });
  const ledger = rt.ledger;
  ledger.startTurn(turn, { se: store.state.sessions[se.id], folder: null, projectFolder: app.root });
  const m = createStreamMapper(
    {
      text() {},
      activity() {},
      status() {},
      compaction() {},
      toolUse: (u) => ledger.toolUse(turn, u),
      toolResult: (r) => ledger.toolResult(turn, r),
      taskEnded: (x) => ledger.taskEnded(turn, x),
      usage: (u) => ledger.usage(turn, u),
    },
    { now: () => Date.now() },
  );
  for (const e of fixture(name)) m.push(e);
  await ledger.endTurn(turn, { status: 'done' });
  await ledger.idle();
}

test.beforeAll(async () => {
  const started = await startRemote('remote-ui');
  app = started.app;
  const { rt, store } = app;
  host = rt.addHost({ name: 'host.example.com' });
  // The welcome as the daemon sends it (shared/remote-protocol.mjs), trimmed: Claude Code found there.
  const welcome = {
    version: '0.18.0',
    home: '/home/user',
    node: { version: '22.12.0', path: '/usr/bin/node' },
    harnesses: [{ name: 'claude-code', path: '/usr/bin/claude', version: '2.1.300' }],
    problems: [],
    turns: [],
  };
  started.hosts.set(host.id, { state: 'connected', failure: null, welcome, lastHeard: Date.now() - 2 * MIN, name: host.name });
  store.emit('project', { id: 'pr_remote', name: 'Remote', folder: app.root });
  persona = rt.createPersona({ handle: 'builder', backend: 'claude-code', remote: { hostId: host.id } });
  conv = rt.createThread({ projectId: 'pr_remote', title: 'Remote build', personaIds: [persona.id] });
  const se = rt.sessionsIn(conv.id).find((x) => x.personaId === persona.id);
  for (const [i, name] of ['ledger-edits', 'ledger-push'].entries()) await hostTurn(se, i, name);
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

async function open(page, hash = `#/t/${conv.id}`) {
  await page.goto(`${app.origin}/${hash}`);
  await synced(page, app);
  await expect(page.locator('#composer-input'), 'the conversation').toBeVisible();
}
const dialog = (page) => page.locator('.dialog');
/** That axe finds nothing, and nothing a selector finds runs off the window, there. */
async function clean(page, selector, where) {
  expect.soft(await axe(page), `axe, ${where}`).toEqual([]);
  expect.soft(await overflowing(page, selector), `nothing runs off the window, ${where}`).toEqual([]);
}

for (const width of [1280, 375]) {
  test.describe(`at ${width} px`, () => {
    if (width < 768) test.use({ viewport: { width, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

    test(`#120 the agent’s ring says it runs on the host, connected${width > 767 ? ', and so does its row' : ''}`, async ({ page }) => {
      await open(page);
      // Every ring of @builder’s that shows, wherever the page puts it at this width.
      const rings = page.getByRole('img', { name: /^@builder: / }).filter({ visible: true });
      await expect(rings, 'a ring for @builder shows').not.toHaveCount(0);
      for (const label of await rings.evaluateAll((rs) => rs.map((r) => r.getAttribute('aria-label'))))
        expect.soft(label).toMatch(/; on host\.example\.com, connected, last heard from 2 min ago$/);
      if (width > 767)
        await expect
          .soft(page.locator('.rail .agent-row').filter({ hasText: '@builder' }))
          .toContainText(/On host\.example\.com · Connected · last heard from 2 min ago/);
      await clean(page, '.agent-row, .ringstrip, header.topbar *', 'in the conversation');
    });

    test('#120 the Work view has the host’s line', async ({ page }) => {
      await open(page, `#/t/${conv.id}?work`);
      await expect(page.locator('#work-pane .work-host-note')).toHaveText(NOTE);
      await clean(page, '#work-pane, #work-pane *', 'in the Work view');
    });

    test('#120 Settings has a Hosts tab with the host, and its tabs row fits the window', async ({ page }) => {
      await open(page);
      await page.evaluate(() => import('/app/js/sheets.mjs').then((m) => m.openSettings('hosts')));
      await expect(dialog(page).locator(`[data-host="${host.id}"]`), 'the host’s card').toContainText('host.example.com');
      await expect.soft(dialog(page).getByRole('tab', { selected: true })).toHaveText('Hosts');
      const tabs = await dialog(page).evaluate((d) => {
        const box = d.getBoundingClientRect();
        const row = /** @type {HTMLElement} */ (d.querySelector('.tabs'));
        const out = [...row.querySelectorAll('[role=tab]')]
          .filter((t) => t.getBoundingClientRect().right > box.right + 1 || t.getBoundingClientRect().left < box.left - 1)
          .map((t) => t.textContent);
        if (row.scrollWidth > row.clientWidth + 1) out.push(`the row scrolls by ${row.scrollWidth - row.clientWidth} px`);
        return out;
      });
      expect.soft(tabs, 'every tab within the sheet').toEqual([]);
      await clean(page, '.dialog, .dialog *', 'on the Hosts tab');
    });

    test('#120 the persona sheet’s Runs on names the host', async ({ page }) => {
      await open(page);
      await page.evaluate((id) => import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', id)), persona.id);
      const where = page.locator('#pe-where');
      await expect(where, 'Runs on').toBeVisible();
      await expect.soft(where.locator('option:checked'), 'the one chosen').toHaveText(['host.example.com']);
      await expect.soft(page.locator('#pe-where-help')).toHaveText(/^Its turns run on host\.example\.com, over your own ssh;/);
      await clean(page, '.dialog, .dialog *', 'on the persona sheet');
    });
  });
}
