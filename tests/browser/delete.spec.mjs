// Delete is just delete (#604, #599): one confirm says what goes, and after it
// the conversation, the session or the persona is gone at once. There’s no Undo, and nothing waits on a window.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { axe } from './remote-hosts.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('delete');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const projectId = () => Object.keys(app.store.state.projects)[0];

/** A persona of its own in a conversation of its own. @param {string} handle */
function withAgent(handle) {
  const p = app.rt.createPersona({ handle, description: 'Checks deleting' });
  const t = app.rt.createThread({ projectId: projectId(), title: `With ${handle}`, personaIds: [p.id] });
  return { p, t, se: arrange.agentIn(app.rt, t.id) };
}

test('deleting a conversation: the confirm says what goes and that it can’t be undone, and it’s gone at once', async ({ page }) => {
  const { p, t, se } = withAgent('convgone');
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await page.getByRole('button', { name: `Actions for ${t.title}` }).click();
  // Delete is in the room’s form in the main menu (#1735).
  await page.getByRole('menuitem', { name: /^Manage room and members/ }).click();
  await page
    .getByRole('dialog', { name: 'Settings' })
    .getByRole('button', { name: /^Delete .+…$/ })
    .click();
  const ask = page.getByRole('alertdialog', { name: `Delete the conversation “${t.title}”?` });
  await expect.soft(ask).toContainText('This erases');
  await expect.soft(ask).toContainText('This can’t be undone.');
  await ask.getByRole('button', { name: 'Delete conversation' }).click();
  await expect.soft(page.locator('#toasts').getByRole('button', { name: /Undo/ }), 'no Undo').toHaveCount(0);
  expect.soft(app.store.state.threads[t.id], 'the conversation is gone').toBeUndefined();
  expect.soft(app.store.state.sessions[se.id], 'its session too').toBeUndefined();
  expect.soft(app.store.state.personas[p.id], 'the persona stays').toBeTruthy();
  expect.soft(arrange.scheduledTimers(app.rt), 'no timer waits to finish it').toBe(0);
  await expect.soft(page).not.toHaveURL(new RegExp(`#/t/${t.id}`));
});

test('deleting a session with @agent /delete removes it at once after its confirm', async ({ page }) => {
  const { p } = withAgent('sesgone');
  const other = app.rt.createPersona({ handle: 'stays' });
  const room = app.rt.createThread({ projectId: projectId(), title: 'Room for a delete', personaIds: [p.id, other.id] });
  const se = arrange.sessionsIn(app.rt, room.id).find((x) => x.personaId === p.id);
  await page.goto(`${app.origin}/#/t/${room.id}`);
  await synced(page, app);
  await page.locator('#composer-input').focus();
  await page.keyboard.type('@sesgone /delete');
  await expect(page.locator('.composer .hint')).toContainText('Enter runs /delete for sesgone');
  await page.keyboard.press('Enter');
  const ask = page.getByRole('alertdialog', { name: 'Delete sesgone’s session?' });
  await expect.soft(ask).toContainText('This can’t be undone.');
  await ask.getByRole('button', { name: 'Delete session' }).click();
  await expect.soft(page.locator(`#agent-row-${se.id}`)).toHaveCount(0);
  expect.soft(app.store.state.sessions[se.id]).toBeUndefined();
  expect.soft(app.store.state.threads[room.id]?.members, 'the room keeps its other agent').toHaveLength(1);
  await expect.soft(page.locator('#toasts').getByRole('button', { name: /Undo/ }), 'no Undo').toHaveCount(0);
});

test('deleting a persona from its sheet takes it and its sessions at once, and the sheet’s list leaves it out', async ({ page }) => {
  const { p, se } = withAgent('gamma');
  await page.goto(`${app.origin}/`);
  await synced(page, app);
  await page.evaluate((pid) => import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', pid)), p.id);
  await page.getByRole('button', { name: 'Delete…' }).click();
  const ask = page.getByRole('alertdialog', { name: 'Delete gamma?' });
  await expect.soft(ask).toContainText('What it remembered: its own memory, in every project');
  await expect.soft(ask).toContainText('Other agents, and their memory');
  await expect.soft(ask).toContainText('This can’t be undone.');
  await ask.getByRole('button', { name: 'Delete gamma' }).click();
  expect.soft(app.store.state.personas[p.id], 'the persona is gone').toBeUndefined();
  expect.soft(app.store.state.sessions[se.id], 'its session too').toBeUndefined();
  const list = page.locator('.dialog .list-rows');
  await expect.soft(list).toContainText('librarian');
  await expect.soft(list).not.toContainText('gamma');
  await expect.soft(page.locator('#toasts').getByRole('button', { name: /Undo/ }), 'no Undo').toHaveCount(0);
});

// #491: an agent on a host loses its memory there too: the confirm says it goes, and every host owes its removal,
// which each is sent when Postbox next connects to it (server/remote/host-forget.mjs).
test('deleting an agent that runs on a host says its memory there goes, and its host’s card shows it until removed', async ({ page }) => {
  const { p } = withAgent('onhost');
  const host = app.rt.addHost({ name: 'build-box.example' });
  app.store.emit('persona', { ...app.rt.persona(p.id), remote: { hostId: host.id } });
  await page.goto(`${app.origin}/`);
  await synced(page, app);
  await page.evaluate((pid) => import('/app/js/sheets.mjs').then((m) => m.openSettings('personas', pid)), p.id);
  await page.getByRole('button', { name: 'Delete…' }).click();
  const ask = page.getByRole('alertdialog', { name: 'Delete onhost?' });
  const goes = ask.locator('.field', { hasText: 'This erases' });
  await expect.soft(goes).toContainText('Its memory on hosts, each the next time Postbox connects there, once the host runs this version');
  await expect.soft(ask.locator('.field', { hasText: 'This stays' })).not.toContainText('host');
  await ask.getByRole('button', { name: 'Delete onhost' }).click();
  await expect.poll(() => app.store.state.hostForgets?.[host.id]).toEqual([p.id]);
  // The host’s card says its memory is still there until the host removes it.
  await page.keyboard.press('Escape');
  await page.evaluate(() => import('/app/js/sheets.mjs').then((m) => m.openSettings('hosts')));
  const card = page.locator(`[data-status="${host.id}"]`);
  await expect.soft(card).toContainText('Postbox still has to ask this host to remove any memory a deleted agent left here.');
  app.store.emit('host.forget', { id: host.id, drop: [p.id] });
  await expect.soft(card).not.toContainText('deleted agent');
  app.store.emit('host', { id: host.id, removed: true });
});

// #1530: a dialog whose body scrolls takes focus there, so a keyboard can scroll it (axe’s scrollable-region-focusable),
// and one that fits isn’t a stop to Tab through. Whether a given dialog scrolls depends on the window and the fonts
// (macOS’s made the delete confirm’s scroll at 375 px, CI’s didn’t), so the body is made to scroll by capping its
// height, and to fit again by taking the cap off: the attribute follows it both ways, as the window or content changes.
test('a dialog body that scrolls can be focused to scroll by keyboard, and one that fits isn’t a tab stop', async ({ page }) => {
  const { t } = withAgent('scrollbody');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await page.getByRole('button', { name: `Actions for ${t.title}` }).click();
  // Delete is in the room’s form in the main menu (#1735).
  await page.getByRole('menuitem', { name: /^Manage room and members/ }).click();
  await page
    .getByRole('dialog', { name: 'Settings' })
    .getByRole('button', { name: /^Delete .+…$/ })
    .click();
  const body = page.getByRole('alertdialog').locator('.d-body');
  await expect(body).toBeVisible();
  const scrolls = () => body.evaluate((b) => b.scrollHeight > b.clientHeight);
  expect(await scrolls(), 'the body fits in a tall window').toBe(false);
  await expect(body).not.toHaveAttribute('tabindex', /.*/);
  await body.evaluate((b) => {
    b.style.maxHeight = '40px';
  });
  expect(await scrolls(), 'capped, the body scrolls').toBe(true);
  await expect(body).toHaveAttribute('tabindex', '0');
  expect((await axe(page)).filter((v) => v.startsWith('scrollable-region-focusable'))).toEqual([]);
  await body.evaluate((b) => {
    b.style.maxHeight = '';
  });
  await expect(body, 'fitting again, it is no tab stop').not.toHaveAttribute('tabindex', /.*/);
});

// #1530: a project folder is one long word to the browser. macOS’s per-user temp folders, as the demo’s are, made the delete
// confirm’s “Files in …” line widen its body past a 375 px window, so the body scrolled sideways, where CI’s /tmp
// paths fit. It wraps instead.
test('a long project folder wraps in the delete confirm at 375 px, rather than widening it', async ({ page }) => {
  // No hyphen or space in it, so nothing gives the browser a place to break the line, and far wider than 375 px in any
  // font: 120 characters at 13 px.
  const folder = `/work/${'h'.repeat(120)}/project`;
  app.store.emit('project', { id: 'pr_long', name: 'Long', folder });
  const t = app.rt.createThread({ projectId: 'pr_long', title: 'Long folder', personaIds: [app.rt.createPersona({ handle: 'longpath' }).id] });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await page.getByRole('button', { name: `Actions for ${t.title}` }).click();
  // Delete is in the room’s form in the main menu (#1735).
  await page.getByRole('menuitem', { name: /^Manage room and members/ }).click();
  await page
    .getByRole('dialog', { name: 'Settings' })
    .getByRole('button', { name: /^Delete .+…$/ })
    .click();
  const body = page.getByRole('alertdialog').locator('.d-body');
  await expect(body).toContainText(folder.slice(0, 20));
  expect(await body.evaluate((b) => b.scrollWidth - b.clientWidth), 'nothing wider than the body').toBeLessThanOrEqual(0);
  expect((await axe(page)).filter((v) => v.startsWith('scrollable-region-focusable'))).toEqual([]);
});
