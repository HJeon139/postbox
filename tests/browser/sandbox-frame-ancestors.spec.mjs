// #992: the sandbox pages (an app’s version and the Mermaid page) can be framed only by Postbox’s own page. Their
// policy names the origin the request came to in frame-ancestors, so apps and diagrams still draw on a Postbox page
// opened at 127.0.0.1 or at localhost, in the transcript and in reviews, and a page on another origin (the other
// spelling, or another port) that frames one gets a frame whose content never runs.
//
// A page on another origin is played by page.route: the browser asks for it at that origin and the test answers, so
// it carries no policy of its own, and only the sandbox page’s header can refuse the frame. Chromium treats a page the
// test answers as a public site’s, and its Local Network Access checks refuse that page any frame of a loopback
// address before asking for it, header or not. Those checks are turned off here, so the spec tests the header alone,
// as it is in a browser without them, and in Chromium for a page in the local address space (another server on this
// computer). Each case checks the sandbox page was asked for and answered, so a refusal before that can’t pass it.
//
// Once the frame has fired load, the test reads the document it holds from Playwright: a refused frame holds the
// browser’s error page (Chromium’s chrome-error://chromewebdata/, Firefox’s empty URL), so the sandbox page and its
// scripts never ran. A message it didn’t send can’t serve alone: a cross-origin frame’s first message can reach the
// page after its load event, so its absence proves little. The case where the page frames its own origin shows the
// frame holding the sandbox page and its first message heard, and without the header every refused case does too.

import { expect, test } from '@playwright/test';
import { allowPageError, failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let port = 0;
let drawer;

test.beforeAll(async () => {
  app = await startPostbox('sandbox-frame-ancestors', { demo: false });
  port = Number(new URL(app.origin).port);
  app.store.emit('project', { id: 'pr_frames', name: 'Framed', folder: app.root });
  drawer = app.rt.createPersona({ handle: 'drawer' });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);
test.use({
  launchOptions: [
    async ({ browserName }, use) => use(browserName === 'chromium' ? { args: ['--disable-features=LocalNetworkAccessChecks'] } : {}),
    { scope: 'worker' },
  ],
});

const at = (host, p = port) => `http://${host}:${p}`;

/** A conversation with an app, a diagram, and a review with a diagram in it, as an agent shows them. */
function room(id) {
  const { rt } = app;
  const thread = rt.createThread({ projectId: 'pr_frames', title: `Frames ${id}`, personaIds: [drawer.id] });
  const session = rt.sessionsIn(thread.id)[0];
  const tools = rt.toolsFor(session.id);
  tools.show_app({ id, title: `App ${id}`, code: `<main style="padding:12px"><h2>Drawn ${id}</h2></main>` });
  const diagram = `\`\`\`mermaid\ngraph TD\n  A${id} --> B${id}\n\`\`\``;
  rt.addItem(thread.id, {
    kind: 'agent',
    sessionId: session.id,
    personaId: session.personaId,
    handle: session.handle,
    text: `The flow:\n\n${diagram}\n`,
    status: 'done',
  });
  tools.show_block({
    block: {
      id: `rv-md-${id}`,
      type: 'review',
      version: 1,
      title: 'The plan',
      fallback: 'Review the plan.',
      format: 'markdown',
      content: `# Plan\n\n${diagram}\n`,
    },
  });
  return { thread, tools };
}

for (const host of ['127.0.0.1', 'localhost'])
  test(`#992: apps and diagrams draw on Postbox’s page at ${host}, in the transcript and in reviews`, async ({ page }) => {
    const id = `drawn-${host.replace(/\W/g, '')}`;
    const { thread, tools } = room(id);
    await page.goto(`${at(host)}/#/t/${thread.id}`);
    await synced(page, app);
    await expect.poll(() => app.rt.s.apps[id].check.status, { message: 'the page checked the app in its frame', timeout: 30_000 }).toBe('passed');
    // Shown once the check has passed, as tests/browser/app-review-reload.spec.mjs does: a review shown while its app
    // is being checked keeps saying so here after the check passes.
    tools.show_block({ block: { id: `rv-app-${id}`, type: 'review', version: 1, title: 'The app', fallback: 'Review the app.', format: 'app', appId: id } });
    await synced(page, app);
    const shown = page.frameLocator(`.app-holder iframe.app-iframe[title="App ${id}"]`);
    await expect.soft(shown.getByRole('heading', { name: `Drawn ${id}` }), 'the app in the transcript').toBeVisible();
    const reviewed = page.locator('.rv-box iframe.app-iframe');
    await reviewed.scrollIntoViewIfNeeded();
    await expect.soft(reviewed, 'the app in its review').toHaveAttribute('data-sized', '1');
    const diagrams = page.locator('figure.diagram iframe');
    await expect.soft(diagrams, 'the reply’s diagram and the review’s').toHaveCount(2);
    for (const d of await diagrams.all()) {
      await d.scrollIntoViewIfNeeded();
      await expect.soft(d, 'a diagram drew in its frame').toHaveAttribute('data-sized', '1');
    }
  });

/**
 * Opens a page at `pageOrigin` that the test serves, frames `src` in it, and waits for the frame’s load event. Gives
 * back the frame as Playwright sees it, the statuses the server answered `src` with, and the messages the page has
 * heard from the frame.
 * @param {import('@playwright/test').Page} page @param {string} pageOrigin @param {string} src
 */
async function frameFrom(page, pageOrigin, src) {
  await page.route(`${pageOrigin}/outside`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Another site</title><p>Another site</p>' }),
  );
  await page.goto(`${pageOrigin}/outside`);
  /** @type {number[]} */
  const answered = [];
  page.on('response', (r) => r.url() === src && answered.push(r.status()));
  await page.evaluate(
    (src) =>
      new Promise((loaded) => {
        const probe = document.createElement('iframe');
        /** @type {any} */ (window).heard = [];
        addEventListener('message', (e) => e.source === probe.contentWindow && /** @type {any} */ (window).heard.push(JSON.stringify(e.data)));
        probe.addEventListener('load', loaded, { once: true });
        probe.src = src;
        document.body.append(probe);
      }),
    src,
  );
  const frame = await (await page.locator('iframe').elementHandle())?.contentFrame();
  if (!frame) throw new Error(`No frame for ${src}`);
  return { frame, answered, heard: () => page.evaluate(() => /** @type {any} */ (window).heard) };
}

const PATHS = [
  ['an app', '/sandbox/app/framed/1?theme=dark', /"type":"hello"/],
  ['an app’s check', '/sandbox/app/framed/1?theme=dark&check', /"type":"hello"/],
  ['a diagram', '/sandbox/mermaid?theme=dark', /^{"__pbd":1,"type":"ready"}$/],
];

test.describe('#992: framed from outside Postbox’s page', () => {
  test.beforeAll(() => room('framed'));

  for (const host of ['127.0.0.1', 'localhost'])
    for (const [kind, path, first] of PATHS)
      test(`a page at Postbox’s own origin, ${host}, runs ${kind} it frames, so a refusal below is the header’s`, async ({ page }) => {
        const src = at(host) + path;
        const { frame, answered, heard } = await frameFrom(page, at(host), src);
        expect(answered, 'the server answered it').toEqual([200]);
        expect(frame.url(), 'the frame holds the sandbox page').toBe(src);
        await expect.poll(heard, { message: 'its script ran and posted its first message' }).toContainEqual(expect.stringMatching(first));
      });

  const OUTSIDE = [
    { name: 'Postbox at localhost, from 127.0.0.1', page: () => at('127.0.0.1'), sandbox: () => at('localhost') },
    { name: 'Postbox at 127.0.0.1, from localhost', page: () => at('localhost'), sandbox: () => at('127.0.0.1') },
    { name: 'Postbox at 127.0.0.1, from another port of 127.0.0.1', page: () => at('127.0.0.1', port + 1), sandbox: () => at('127.0.0.1') },
    { name: 'Postbox at localhost, from another port of localhost', page: () => at('localhost', port + 1), sandbox: () => at('localhost') },
  ];
  for (const c of OUTSIDE)
    for (const [kind, path] of PATHS)
      test(`${c.name}: ${kind} never runs`, async ({ page, browserName }) => {
        // Firefox reports the refusal on the framing page’s console; Chromium doesn’t, to Playwright.
        allowPageError(page, /frame-ancestors/);
        const { frame, answered, heard } = await frameFrom(page, c.page(), c.sandbox() + path);
        expect(answered, 'the browser asked for the sandbox page and got it, so what refused it was its header').toEqual([200]);
        expect(frame.url(), 'the frame holds the browser’s error page, not the sandbox page').toBe(
          browserName === 'firefox' ? '' : 'chrome-error://chromewebdata/',
        );
        expect.soft(await heard(), 'and nothing came from it').toEqual([]);
      });
});
