// The composer’s quota line (#442, designs/architecture/adapters.md, “Quota: each backend’s usage, in the composer”):
// one bar per backend the room’s agents run on, with its most-used window and reset time, labeled by backend and never
// in an agent’s row. A backend that reports no quota gets no bar; a stale figure says its age; a window past its reset
// shows no number; a hint that applies takes the line. Figures are made up: recorded ones stay scrubbed.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
const HOUR = 3_600_000;
const resetsAt = Date.now() + 3 * HOUR;
test.beforeAll(async () => {
  app = await startPostbox('quota-line');
  // Fake harnesses: Claude Code and Codex report a quota with each turn, as theirs do; Kiro reports none.
  const backend = (name, quota) =>
    arrange.withAdapter(app.rt, {
      name,
      folderFor: async () => app.root,
      async deliver(_session, _message, ctx) {
        if (quota) ctx.quota?.(quota);
        ctx.text('Done.');
      },
    });
  backend('claude-code', {
    status: 'ok',
    windows: [
      { name: '5 h', used: 0.42, resetsAt },
      { name: '7 d', used: 0.1, resetsAt: resetsAt + 24 * HOUR },
    ],
  });
  backend('codex', { status: 'ok', windows: [{ name: '7 d', used: 0.07, resetsAt }] });
  backend('kiro-cli', null);
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

let count = 0;
/** A room with an agent on each backend, each having answered once, open at 1280 px. */
async function room(page, backends = ['claude-code', 'codex', 'kiro-cli']) {
  const n = ++count;
  const personas = backends.map((backend, i) => app.rt.createPersona({ handle: `q${n}x${i}`, backend }));
  const t = app.rt.createThread({ projectId: Object.keys(app.store.state.projects)[0], title: `Quota ${n}`, personaIds: personas.map((p) => p.id) });
  app.rt.sendMessage(t.id, { text: personas.map((p) => `@${p.handle}`).join(' ') + ' go' });
  // Each agent answered once, so each harness has had its turn to report.
  await expect.poll(() => app.store.items(t.id).filter((i) => i.kind === 'agent' && i.text === 'Done.').length).toBe(backends.length);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  return t;
}
const line = (page) => page.locator('.composer .quota-line');
const bar = (page, backend) => line(page).getByRole('meter', { name: new RegExp(`^${backend} quota`) });

test('#442 one bar per backend in the room, with its most-used window and reset time; Kiro reports none', async ({ page }) => {
  await room(page);
  await expect(bar(page, 'Claude Code')).toHaveAttribute('aria-valuenow', '42');
  await expect(bar(page, 'Claude Code')).toContainText(/Claude Code · 5 h 42% · resets /);
  await expect(bar(page, 'Codex')).toHaveAttribute('aria-valuenow', '7');
  await expect(line(page).getByRole('meter'), 'no bar for a backend that reports no quota').toHaveCount(2);
  await expect(line(page)).not.toContainText('Kiro');
  // Per backend, not per agent: the agents’ rows show no quota figure.
  await expect(page.locator('.agent-row')).not.toContainText('42%');
});

test('#442 a room’s bars are only its own backends’', async ({ page }) => {
  await room(page, ['codex']);
  await expect(bar(page, 'Codex')).toBeVisible();
  await expect(line(page).getByRole('meter')).toHaveCount(1);
});

test('#442 a hint takes the line while you type, and the bars come back when the draft is empty', async ({ page }) => {
  await room(page);
  await expect(bar(page, 'Claude Code')).toBeVisible();
  await page.locator('#composer-input').focus();
  await page.keyboard.insertText('Is it done?');
  await expect(page.locator('.composer .hint')).toContainText('Replying to');
  await expect(line(page)).toBeHidden();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await expect(bar(page, 'Claude Code')).toBeVisible();
});

test('#442 a figure seen long ago says its age, and a window past its reset shows no number', async ({ page }) => {
  await room(page, ['claude-code', 'codex']);
  app.store.emit('quota', {
    id: 'codex',
    backend: 'codex',
    host: null,
    status: 'ok',
    windows: [{ name: '7 d', used: 0.3, resetsAt }],
    seenAt: Date.now() - 2 * HOUR,
  });
  app.store.emit('quota', {
    id: 'claude-code',
    backend: 'claude-code',
    host: null,
    status: 'ok',
    windows: [{ name: '5 h', used: 0.9, resetsAt: Date.now() - 60_000 }],
    seenAt: Date.now(),
  });
  await synced(page, app);
  await expect(bar(page, 'Codex')).toContainText('as of 2 h ago');
  await expect(bar(page, 'Codex')).toHaveClass(/stale/);
  await expect(bar(page, 'Claude Code')).toContainText('reset');
  await expect(bar(page, 'Claude Code')).not.toContainText('90%');
});
