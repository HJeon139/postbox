// view_app (#95; designs/architecture.md, “Agents see their app”) renders a real agent app in the pinned headless
// shell, inline in Postbox’s own page in capture mode: its libraries reach it over the bridge, its pending check
// doesn’t hide it, and the capture reports nothing to Postbox. The size and theme follow the person’s open tab. A page
// that tries to write, or to reach another host, during a capture gets nothing through.

import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { AppBrowser } from '../../server/view-app/browser.mjs';
import { viewApp } from '../../server/view-app/view-app.mjs';
import { viewOf } from '../../server/view-app/view-of.mjs';
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
/** A project in the spec’s own temp folder, where view_app saves its pictures: the demo’s is the clone’s corpus. */
async function project() {
  const folder = join(app.root, 'work');
  await mkdir(folder, { recursive: true });
  if (!app.rt.s.projects.pv) app.store.emit('project', { id: 'pv', name: 'View app', folder });
  return 'pv';
}
test.beforeAll(async () => {
  app = await startPostbox('view-app');
  // The headless shell the specs already installed stands in for Postbox’s own download, and the person agreed.
  const dir = viewOf(app.rt).dir;
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
  const t = rt.createThread({ projectId, title: 'View check', personaIds: [rt.personaByHandle('researcher').id] });
  const se = rt.sessionsIn(t.id)[0];
  const shown = rt.toolsFor(se.id).show_app({ title: 'Price and orders', code: CHART });
  const viewed = [];
  const view = rt.view.bind(rt);
  rt.view = (id) => {
    viewed.push(id);
    view(id);
  };
  try {
    const r = await viewApp(rt, se.id, { appId: shown.appId }, { threadId: () => t.id, endSegment() {}, images: true });
    expect.soft(r.ok, r.message).toBe(true);
    expect.soft(r.message).toMatch(/inline in the conversation, in a 1000 × 680 window, light theme/);
    const png = sizeOf(r.image.data);
    expect.soft(png.png, 'a PNG').toBe(true);
    // The conversation’s column is at most 760 px wide; the app fills it, with its header.
    expect.soft(png.width).toBeGreaterThan(600);
    expect.soft(png.width).toBeLessThanOrEqual(760);
    expect.soft(png.height).toBeGreaterThan(240);
    expect.soft(rt.s.apps[shown.appId].check.status, 'nobody checked it: no tab was open').toBe('pending');
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
  const t = rt.createThread({ projectId, title: 'Window check', personaIds: [rt.personaByHandle('researcher').id] });
  const se = rt.sessionsIn(t.id)[0];
  const shown = rt.toolsFor(se.id).show_app({ title: 'Window', code: '<p style="padding:12px">Sized to your window.</p>' });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await expect.poll(() => viewOf(rt).windowNow(), { timeout: 15_000 }).toMatchObject({ width: 1280, height: 800, theme: 'dark' });
  const r = await viewApp(rt, se.id, { appId: shown.appId }, { threadId: () => t.id, endSegment() {}, images: false });
  expect.soft(r.ok, r.message).toBe(true);
  expect.soft(r.message).toMatch(/in a 1280 × 800 window, dark theme/);
  expect.soft(r.image, 'this backend gets the saved file’s path instead').toBeNull();
});

test('a capture lets through only GETs to its own origin', async () => {
  test.setTimeout(60_000);
  const got = [];
  const server = createServer((req, res) => {
    got.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<div data-capture-item style="width:200px;height:100px">A page that tries to act</div><script>
      Promise.allSettled([
        fetch('/write', { method: 'POST', body: 'x' }),
        fetch('https://example.com/'),
        fetch('/read'),
      ]).then(() => { document.body.dataset.capture = 'ready'; });
    </script>`);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const b = new AppBrowser({ dir: playwrightBrowsers() });
  try {
    const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
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
  } finally {
    await b.close();
    await new Promise((ok) => server.close(ok));
  }
});
