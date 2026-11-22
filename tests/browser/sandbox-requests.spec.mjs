// #1272: nothing in a sandbox page reads Postbox’s files across origins, so they need no access-control-allow-origin.
// An agent app (with the kit, a chart, a bundled library and a bundled image) and a Mermaid diagram draw, and every
// request a sandbox frame makes is recorded: none is for /kit/ or the stylesheet, and the only ones for /media/ are
// images, which a browser loads without asking the server for a cross-origin read.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let drawer;

test.beforeAll(async () => {
  app = await startPostbox('sandbox-requests', { demo: false });
  app.store.emit('project', { id: 'pr_req', name: 'Requests', folder: app.root });
  drawer = app.rt.createPersona({ handle: 'drawer' });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

// An app that uses what a sandbox page could fetch: the kit and its charts, a bundled library and a bundled image.
const CODE = `<main style="padding:12px">
<h2>Requests</h2>
<img src="/media/reactions/reaction-approve-64.png" alt="Approve" width="32" height="32">
<div id="chart" style="width:320px;height:180px"></div>
<p id="lib">loading</p>
<script>
  postbox.charts.line(document.getElementById('chart'), { x: [1, 2, 3], series: [{ name: 'a', values: [1, 3, 2] }] });
  postbox.load('d3').then((d3) => { document.getElementById('lib').textContent = 'd3 ' + typeof d3.select; });
</script>
</main>`;

test('#1272 an app and a diagram draw with no cross-origin read of /kit/, the stylesheet or /media/', async ({ page }) => {
  /** @type {{ url: string, type: string }[]} */
  const fromSandbox = [];
  page.on('request', (r) => {
    const frame = r.frame();
    if (frame !== page.mainFrame() && new URL(frame.url() || 'about:blank', app.origin).pathname.startsWith('/sandbox/'))
      fromSandbox.push({ url: new URL(r.url()).pathname, type: r.resourceType() });
  });
  const { rt } = app;
  const thread = rt.createThread({ projectId: 'pr_req', title: 'Requests', personaIds: [drawer.id] });
  const session = arrange.agentIn(rt, thread.id);
  rt.toolsFor(session.id).show_app({ id: 'req-app', title: 'Requests app', code: CODE });
  arrange.post(rt, thread.id, {
    kind: 'agent',
    sessionId: session.id,
    personaId: session.personaId,
    handle: session.handle,
    text: 'The flow:\n\n```mermaid\ngraph TD\n  A --> B\n```\n',
    status: 'done',
  });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  const shown = page.frameLocator('.app-holder iframe.app-iframe[title="Requests app"]');
  await expect(shown.locator('#lib'), 'the bundled library loaded').toHaveText('d3 function', { timeout: 30_000 });
  await expect(shown.locator('#chart svg'), 'the chart drew').toBeVisible();
  await expect(shown.getByRole('img', { name: 'Approve' }), 'the bundled image showed').toBeVisible();
  await expect(page.locator('figure.diagram iframe'), 'the diagram drew').toHaveAttribute('data-sized', '1');

  expect(fromSandbox.length, 'the sandbox pages’ requests were recorded').toBeGreaterThan(0);
  const read = fromSandbox.filter((r) => r.url.startsWith('/kit/') || r.url.endsWith('workbench.css'));
  expect(read, 'no sandbox page asks for the kit or the stylesheet').toEqual([]);
  const media = fromSandbox.filter((r) => r.url.startsWith('/media/'));
  expect(media.length, 'the image came from /media/').toBeGreaterThan(0);
  expect(
    media.filter((r) => r.type !== 'image'),
    'every /media/ request is an image’s',
  ).toEqual([]);
});
