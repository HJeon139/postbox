// view_app (#95; designs/architecture/view-app.md, “Agents see their app”) renders a real agent app in the pinned headless
// shell, inline in Postbox’s own page in capture mode: its libraries reach it over the bridge, its pending check
// doesn’t hide it, and the capture reports nothing to Postbox. The size, the conversation’s width beside the rail and
// any pane, and the theme follow the person’s open tab. A page that tries to write, or to reach another host, during a
// capture gets nothing through.

import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { AppBrowser } from '../../server/view-app/browser.mjs';
import { answerIn } from '../../server/view-app/consent.mjs';
import { SCANS } from '../../tools/uat/doc-query-probe.mjs';
import * as arrange from '../arrange.mjs';
import { playwrightBrowsers } from '../fixtures/playwright-browsers.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

const CHART = `<h2 style="margin:8px 0">Orders fall as price rises</h2><div id="c"></div><script>
postbox.ready.then(async () => {
  const d3 = await postbox.load('d3');
  const svg = d3.select('#c').append('svg').attr('width', 640).attr('height', 240).attr('id', 'drawn');
  svg.selectAll('circle').data([210, 180, 140, 120, 90, 60]).join('circle')
    .attr('cx', (d, i) => 60 + i * 100).attr('cy', (d) => 240 - d).attr('r', 9).attr('fill', 'var(--s1)');
});
</script>`;
/** A PNG’s width and height, from its IHDR chunk. @param {string} base64 */
const sizeOf = (base64) => {
  const b = Buffer.from(base64, 'base64');
  return { png: b.subarray(1, 4).toString() === 'PNG', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
};

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** A project in the spec’s own temp folder, where view_app saves its pictures: the demo’s is in its data folder. */
async function project() {
  const folder = join(app.root, 'work');
  await mkdir(folder, { recursive: true });
  if (!app.rt.store.state.projects.pv) app.store.emit('project', { id: 'pv', name: 'View app', folder });
  return 'pv';
}
test.beforeAll(async () => {
  app = await startPostbox('view-app');
  // The headless shell the specs already installed stands in for Postbox’s own download, and the person agreed.
  const dir = arrange.viewOf(app.rt).dir;
  const shell = new AppBrowser({ dir: playwrightBrowsers() });
  test.skip(shell.status() !== 'ready', 'Playwright’s headless shell isn’t installed');
  await mkdir(dir, { recursive: true });
  const { browsers } = JSON.parse(await (await import('node:fs/promises')).readFile(join(shell.pkg ?? '', 'browsers.json'), 'utf8'));
  const rev = browsers.find((b) => b.name === 'chromium-headless-shell').revision;
  await symlink(join(playwrightBrowsers(), `chromium_headless_shell-${rev}`), join(dir, `chromium_headless_shell-${rev}`));
  await writeFile(join(dir, 'consent.json'), JSON.stringify({ answer: 'allowed', at: Date.now() }));
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('an agent sees its D3 app rendered inline before its check has run, and the capture reports nothing to Postbox', async () => {
  test.setTimeout(90_000);
  const { rt } = app;
  const projectId = await project();
  const t = rt.createThread({ projectId, title: 'View check', personaIds: [arrange.persona(rt, 'researcher').id] });
  const se = arrange.agentIn(rt, t.id);
  const shown = rt.toolsFor(se.id).show_app({ title: 'Price and orders', code: CHART });
  const viewed = [];
  const view = rt.view.bind(rt);
  rt.view = (id) => {
    viewed.push(id);
    view(id);
  };
  try {
    const r = await arrange.viewApp(rt, se.id, { appId: shown.appId }, { threadId: () => t.id, endSegment() {}, images: true });
    expect.soft(r.ok, r.message).toBe(true);
    expect.soft(r.message).toMatch(/inline in the conversation, in a 1000 × 680 window, light theme/);
    const png = sizeOf(r.image.data);
    expect.soft(png.png, 'a PNG').toBe(true);
    // At 1000 px, beside the rail, the app fills the conversation, with its header: 1000 − 248 − 48 px of padding.
    expect.soft(png.width).toBe(704);
    expect.soft(png.height).toBeGreaterThan(240);
    expect.soft(rt.store.state.apps[shown.appId].check.status, 'nobody checked it: no tab was open').toBe('pending');
    expect.soft(viewed, 'the capture page never reported a thread as viewed').toEqual([]);
  } finally {
    rt.view = view;
  }
});

test('the capture uses the size and theme the person’s open Postbox tab reports', async ({ page }) => {
  test.setTimeout(90_000);
  const { rt } = app;
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${app.origin}/`);
  await synced(page, app);
  const projectId = await project();
  const t = rt.createThread({ projectId, title: 'Window check', personaIds: [arrange.persona(rt, 'researcher').id] });
  const se = arrange.agentIn(rt, t.id);
  const shown = rt.toolsFor(se.id).show_app({ title: 'Window', code: '<p style="padding:12px">Sized to your window.</p>' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await expect.poll(() => arrange.viewOf(rt).windowNow(), { timeout: 15_000 }).toMatchObject({ width: 1280, height: 800, theme: 'dark' });
  const r = await arrange.viewApp(rt, se.id, { appId: shown.appId }, { threadId: () => t.id, endSegment() {}, images: false });
  expect.soft(r.ok, r.message).toBe(true);
  expect.soft(r.message).toMatch(/in a 1280 × 800 window, dark theme/);
  expect.soft(r.image, 'this backend gets the saved file’s path instead').toBeNull();
});

/** A local server that records each request it gets, and answers with `page(otherPort)`. */
async function recorder(page = () => '') {
  const got = [];
  const server = createServer((req, res) => {
    got.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' });
    res.end(page());
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  return { got, port, close: () => new Promise((ok) => server.close(ok)) };
}

test('the tab’s report of its window reads the conversation’s width without a query over the whole document', async ({ page }) => {
  // The report runs every 10 s while a conversation is open, so its cost mustn’t grow with the page (#564-b1).
  const { rt } = app;
  const projectId = await project();
  const t = rt.createThread({ projectId, title: 'Report check', personaIds: [arrange.persona(rt, 'researcher').id] });
  await page.setViewportSize({ width: 1000, height: 680 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  // The conversation beside the rail at 1000 px: 1000 − 248. The app in it is 704, after the transcript’s padding.
  await expect.poll(() => arrange.viewOf(rt).windowNow().column, { timeout: 15_000 }).toBe(752);
  arrange.viewOf(rt).window = null;
  const queries = await page.evaluate(async (names) => {
    const seen = [];
    const real = names.map((name) => [name, Document.prototype[name]]);
    for (const [name, fn] of real)
      Document.prototype[name] = function (sel) {
        if (this === document) seen.push(`${name} ${String(sel).slice(0, 80)}`);
        return fn.call(this, sel);
      };
    // The tab reports at once when it’s shown again (app/js/main.mjs).
    document.dispatchEvent(new Event('visibilitychange'));
    for (const [name, fn] of real) Document.prototype[name] = fn;
    return seen;
  }, SCANS);
  expect.soft(queries, 'whole-document queries in one view report').toEqual([]);
  await expect.poll(() => arrange.viewOf(rt).windowNow().column, { timeout: 15_000 }).toBe(752);
});

test('a capture shows the app with its check’s note, as the person sees it, and the app itself while its check is pending', async ({ page }) => {
  test.setTimeout(60_000);
  const { rt, store } = app;
  const projectId = await project();
  const t = rt.createThread({ projectId, title: 'Note check', personaIds: [arrange.persona(rt, 'researcher').id] });
  const se = arrange.agentIn(rt, t.id);
  const shown = rt.toolsFor(se.id).show_app({ title: 'Noted', code: '<p style="padding:12px">Small print.</p>' });
  const item = rt.store.items(t.id).find((x) => x.block?.id === shown.appId);
  const capture = `${app.origin}/?nocheck&capture=${item.id}&thread=${t.id}`;
  await page.goto(capture);
  await expect(page.locator('[data-capture="ready"]')).toBeAttached({ timeout: 15_000 });
  await expect(page.locator('[data-capture-item] iframe.app-iframe'), 'pending: the app, not “Checking the app…”').toBeVisible();
  const problems = [{ code: 'small-text', message: 'Text under 12 px.' }];
  store.emit('app', { ...rt.s.apps[shown.appId], check: { status: 'note', attempt: 1, problems, notes: true } });
  await page.goto(capture);
  await expect(page.locator('[data-capture="ready"]')).toBeAttached({ timeout: 15_000 });
  await expect(page.locator('[data-capture-item] .app-note')).toContainText('Shown with notes for researcher: Text under 12 px.');
});

test('the picture is as wide as the app the person sees, beside the rail by default and beside an open pane', async ({ page }) => {
  test.setTimeout(120_000);
  const { rt } = app;
  const projectId = await project();
  const t = rt.createThread({ projectId, title: 'Width check', personaIds: [arrange.persona(rt, 'researcher').id] });
  const se = arrange.agentIn(rt, t.id);
  const shown = rt.toolsFor(se.id).show_app({ title: 'Width', code: '<p style="padding:12px">As wide as yours.</p>' });
  const ctx = { threadId: () => t.id, endSegment() {}, images: true };
  /** The app’s width in the person’s page, and in view_app’s picture, once the tab has reported this window. */
  const both = async (width, height, hash) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${app.origin}/#/t/${t.id}${hash}`);
    await synced(page, app);
    const frame = page.locator('.transcript .appframe').first();
    await expect(frame).toBeVisible();
    await expect.poll(() => arrange.viewOf(rt).windowNow().width, { timeout: 15_000 }).toBe(width);
    const seen = Math.round((await frame.boundingBox())?.width ?? 0);
    const r = await arrange.viewApp(rt, se.id, { appId: shown.appId }, ctx);
    expect(r.ok, r.message).toBe(true);
    return { seen, sent: sizeOf(r.image.data).width };
  };
  const laptop = await both(1000, 680, '');
  expect.soft(laptop.sent, 'beside the rail, at 1000 × 680').toBe(laptop.seen);
  expect.soft(laptop.seen, 'the rail takes its room').toBe(704);
  const pane = await both(1280, 800, '?work');
  expect.soft(pane.sent, 'beside the open Work pane, at 1280 × 800').toBe(pane.seen);
  // With no tab’s report, the page lays the conversation out beside the rail at 1000 × 680, as the person above saw it.
  await page.goto('about:blank');
  arrange.viewOf(rt).window = null;
  const r = await arrange.viewApp(rt, se.id, { appId: shown.appId }, ctx);
  expect.soft(sizeOf(r.image.data).width, 'no tab open: 1000 × 680 beside the rail').toBe(laptop.seen);
});

test('a capture lets through only GETs to its own origin', async () => {
  test.setTimeout(60_000);
  // Another address on this computer, which a GET could reach if the guard checked only the method.
  const other = await recorder();
  const own = await recorder(
    () => `<div data-capture-item style="width:200px;height:100px">A page that tries to act</div><script>
      Promise.allSettled([
        fetch('/write', { method: 'POST', body: 'x' }),
        fetch('http://127.0.0.1:${other.port}/elsewhere'),
        fetch('/read'),
      ]).then(() => { document.body.dataset.capture = 'ready'; });
    </script>`,
  );
  const got = own.got;
  const b = new AppBrowser({ dir: playwrightBrowsers() });
  try {
    const port = own.port;
    const png = await b.capture({ origin: `http://127.0.0.1:${port}`, threadId: 't', itemId: 'i', width: 800, height: 600, theme: 'light' });
    expect.soft(png.length).toBeGreaterThan(0);
    expect
      .soft(
        got.filter((x) => x.startsWith('POST')),
        'no write reached the server',
      )
      .toEqual([]);
    expect
      .soft(
        got.some((x) => x.startsWith('GET /read')),
        'a GET to its own origin still goes through',
      )
      .toBe(true);
    expect.soft(other.got, 'nothing reached another origin, even a GET').toEqual([]);
  } finally {
    await b.close();
    await own.close();
    await other.close();
  }
});

test('a person who hasn’t answered sees the download card, and Not now is kept and shown on it', async ({ page }) => {
  test.setTimeout(60_000);
  const { rt } = app;
  const consent = join(arrange.viewOf(rt).dir, 'consent.json');
  await rm(consent, { force: true });
  try {
    const projectId = await project();
    const t = rt.createThread({ projectId, title: 'Ask check', personaIds: [arrange.persona(rt, 'researcher').id] });
    const se = arrange.agentIn(rt, t.id);
    const shown = rt.toolsFor(se.id).show_app({ title: 'Asked', code: '<p>Not yet seen.</p>' });
    const r = await arrange.viewApp(rt, se.id, { appId: shown.appId }, { threadId: () => t.id, endSegment() {}, images: true });
    expect.soft(r.waiting, r.message).toBe(true);
    await page.goto(`${app.origin}/#/t/${t.id}`);
    await synced(page, app);
    const card = page.getByRole('group', { name: '@researcher asks to see its app' });
    await expect(card).toContainText('Download Chromium (about 200 MB on disk) so agents can see their apps?');
    await card.getByRole('button', { name: 'Not now' }).click();
    await expect(card).toContainText('Not downloaded. Agents can’t see their apps.');
    expect.soft(answerIn(arrange.viewOf(rt).dir)).toBe('declined');
    const again = await arrange.viewApp(rt, se.id, { appId: shown.appId }, { threadId: () => t.id, endSegment() {}, images: true });
    expect.soft(again.message).toMatch(/chose not to download the browser/);
  } finally {
    await writeFile(consent, JSON.stringify({ answer: 'allowed', at: Date.now() }));
  }
});
