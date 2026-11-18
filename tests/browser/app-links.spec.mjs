// #1480: a web link in an agent app opens in a new tab when the person clicks it, and never on the app’s own: a link the
// app clicks by script, with nobody touching it, opens nothing. Postbox’s page stays where it was. One click opens one
// link: a burst, or a timer after the click, opens nothing more. Links within the app’s own page stay in it. In the Claude
// desktop app’s pane, Postbox’s server opens the link instead; here its opener is a stand-in that opens nothing.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { clickApp, frameOf } from './app-pointer.mjs';
import { allowPageError, failOnPageErrors, startPostbox, synced } from './postbox.mjs';

// Its big button is a link. On load it clicks another link by script.
const LINKS = `<main style="padding:12px">
<a id="go" class="btn" href="https://example.invalid/clicked" style="display:block;height:120px">Open the other site</a>
</main>
<script>
postbox.ready.then(() => {
  if (postbox.check) return;
  const a = document.createElement('a');
  a.href = 'https://example.invalid/scripted';
  document.body.appendChild(a);
  a.click();
  postbox.saveState({ scripted: true });
});
</script>`;

// Hands Postbox links itself, the way any app can, past the kit’s own filter.
const post = (url) => `parent.postMessage({ __pb: 1, type: 'open', url: ${JSON.stringify(url)} }, { targetOrigin: '*', includeUserActivation: true })`;

// One click: five links at once, then two more on timers, then it says it’s done. Any later click asks for one more.
const BURST = `<main style="padding:12px"><button id="b" class="btn" style="display:block;height:120px;width:100%">Burst</button></main>
<script>
let clicks = 0;
document.getElementById('b').addEventListener('click', () => {
  if (clicks++) {
    ${post('https://example.invalid/again')};
    return postbox.saveState({ done: true, clicks });
  }
  for (let i = 0; i < 5; i++) ${post('https://example.invalid/burst')};
  setTimeout(() => ${post('https://example.invalid/timer-1s')}, 1000);
  setTimeout(() => { ${post('https://example.invalid/timer-2s')}; postbox.saveState({ done: true }); }, 2000);
});
</script>`;

// Its big button is a javascript: link, which the kit leaves to the app. Its click hands over links that aren’t web
// links, then a web link last: only the last opens.
const SCHEMES = `<main style="padding:12px"><a class="btn" href=" javascript:postbox.saveState({ ran: true })" style="display:block;height:120px">Schemes</a></main>
<script>
addEventListener('click', () => {
  ${post('javascript:void(document.title="opened")')};
  ${post('file:///etc/passwd')};
  ${post(' javascript:void(0)')};
  ${post(' https://example.invalid/leading-space')};
  ${post('https://example.invalid/marker')};
});
</script>`;

// Two links, the first its big button. It counts the clicks it hears, after the kit has handed each link over.
const TWO = `<main style="padding:12px">
<a class="btn" href="https://example.invalid/first" style="display:block;height:120px">First</a>
<a id="second" class="btn" href="https://example.invalid/second" style="display:block;height:60px">Second</a>
</main>
<script>
let clicks = 0;
addEventListener('click', () => postbox.saveState({ clicks: ++clicks }));
</script>`;

// Its big button is a link to a place on its own page. After the kit hears the click, the app hands over a web link.
const IN_PAGE = `<main style="padding:12px">
<a class="btn" href="#end" style="display:block;height:120px">Go to the end</a>
<p id="end">The end</p>
</main>
<script>
addEventListener('click', () => ${post('https://example.invalid/marker')});
</script>`;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** What the server’s stand-in opener was asked to open, URLs in order; a URL with “fail” in it fails to open. */
const ran = [];
test.beforeAll(async () => {
  const openUrl = async ([, args]) => {
    const url = args.at(-1);
    if (url.includes('fail')) throw new Error('the stand-in opener failed');
    ran.push(url);
  };
  app = await startPostbox('app-links', { server: { openUrl } });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
// The click is checked with MessageEvent.userActivation, which only Chromium has (#76).
test.skip(({ browserName }) => browserName !== 'chromium', 'a link’s click is checked with MessageEvent.userActivation (#76)');

/** Opens a new conversation with the app in it, and returns the new tabs opened, as they open. */
async function showApp(page, context, title, code) {
  const { rt } = app;
  const opened = [];
  await context.route('https://example.invalid/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Other</title>' }));
  context.on('page', (p) => opened.push(p));
  const t = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title, personaIds: [arrange.persona(rt, 'librarian').id] });
  const se = arrange.agentIn(rt, t.id);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const id = `${title.toLowerCase().replaceAll(' ', '-')}-${t.id}`;
  rt.toolsFor(se.id).show_app({ id, title, code, permissions: [] });
  await expect(frameOf(page, title), 'the app to load').toHaveAttribute('data-sized', '1');
  return { id, urls: () => opened.map((p) => p.url()) };
}

test('#1480 only a link the person clicks opens, in a new tab, and Postbox’s page stays', async ({ page, context }) => {
  const { id, urls } = await showApp(page, context, 'Links', LINKS);
  await expect.poll(() => app.rt.store.state.apps[id]?.state?.scripted, { message: 'the app clicked its link by script' }).toBe(true);
  const url = page.url();
  expect(urls(), 'the scripted link opened nothing').toHaveLength(0);

  await clickApp(page, 'Links');
  await expect.poll(urls, { message: 'the clicked link opened a tab' }).toEqual(['https://example.invalid/clicked']);
  expect(page.url(), 'Postbox’s page stayed').toBe(url);
  await expect(frameOf(page, 'Links'), 'the app stayed on its page').toHaveAttribute('src', /\/sandbox\/app\//);
});

test('#1480 one click opens one link: a burst and timers after it open nothing more, and the next click opens one', async ({ page, context }) => {
  const { id, urls } = await showApp(page, context, 'Burst', BURST);
  await clickApp(page, 'Burst');
  await expect.poll(() => app.rt.store.state.apps[id]?.state?.done, { message: 'the app’s timers ran' }).toBe(true);
  await clickApp(page, 'Burst');
  await expect.poll(() => app.rt.store.state.apps[id]?.state?.clicks, { message: 'the app heard the second click' }).toBe(2);
  await expect
    .poll(urls, { message: 'the burst’s first link, then the next click’s, and nothing between' })
    .toEqual(['https://example.invalid/burst', 'https://example.invalid/again']);
});

test('#1480 a link that isn’t http or https, or has a space before its scheme, opens nothing', async ({ page, context }) => {
  const { id, urls } = await showApp(page, context, 'Schemes', SCHEMES);
  await clickApp(page, 'Schemes');
  await expect.poll(() => app.rt.store.state.apps[id]?.state?.ran, { message: 'the kit left the javascript: link to the app' }).toBe(true);
  await expect.poll(urls, { message: 'only the web link opened' }).toEqual(['https://example.invalid/marker']);
  await expect(page).not.toHaveTitle('opened');
});

test('#1480 a link to a place on the app’s own page stays in the app', async ({ page, context }) => {
  const { urls } = await showApp(page, context, 'In page', IN_PAGE);
  await clickApp(page, 'In page');
  await expect.poll(urls, { message: 'only the link the app handed over opened, not its own page' }).toEqual(['https://example.invalid/marker']);
  await expect(frameOf(page, 'In page'), 'the app stayed on its page').toHaveAttribute('src', /\/sandbox\/app\//);
});

test('#1480 without MessageEvent.userActivation, an app’s link opens nothing, as its sends wait for you', async ({ page, context }) => {
  // Firefox and Safari have no snapshot of the click in a message (#76): Postbox can’t tell which frame was clicked.
  await page.addInitScript(() => delete MessageEvent.prototype.userActivation);
  const { id, urls } = await showApp(page, context, 'No snapshot', BURST);
  await clickApp(page, 'No snapshot');
  await expect.poll(() => app.rt.store.state.apps[id]?.state?.done, { message: 'the app’s timers ran' }).toBe(true);
  expect(urls(), 'nothing opened').toEqual([]);
});

test.describe('in the Claude desktop app’s pane', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Claude/1.2.3' });

  test('#1480 the server opens one link per click, and a burst and timers after it open nothing more', async ({ page, context }) => {
    ran.length = 0;
    const { id, urls } = await showApp(page, context, 'Burst', BURST);
    await clickApp(page, 'Burst');
    await expect.poll(() => app.rt.store.state.apps[id]?.state?.done, { message: 'the app’s timers ran' }).toBe(true);
    await expect.poll(() => ran, { message: 'the server opened the burst’s first link alone' }).toEqual(['https://example.invalid/burst']);
    expect(urls(), 'the page opened no tab').toEqual([]);
  });

  test('#1480 a second click within moments opens nothing, and says why once', async ({ page, context }) => {
    // The pane opens no tab, so nothing uses up the first click’s activation: a click within its 5 s can’t be told from it.
    ran.length = 0;
    const { id } = await showApp(page, context, 'Two', TWO);
    await clickApp(page, 'Two');
    await expect.poll(() => ran, { message: 'the first link opened' }).toEqual(['https://example.invalid/first']);
    const second = frameOf(page, 'Two').contentFrame().locator('#second');
    await second.click();
    await second.click();
    await expect.poll(() => app.rt.store.state.apps[id]?.state?.clicks, { message: 'the app heard all three clicks' }).toBe(3);
    await expect(page.locator('.toast', { hasText: 'Postbox opens one link per click from an app. Click it again in a moment.' })).toHaveCount(1);
    expect(ran, 'the second link opened nothing').toEqual(['https://example.invalid/first']);
  });

  test('#1480 a link the server couldn’t open says so', async ({ page, context }) => {
    const FAILS = LINKS.replace('https://example.invalid/clicked', 'https://example.invalid/fail');
    await showApp(page, context, 'Fails', FAILS);
    allowPageError(page, /status of 502/);
    await clickApp(page, 'Fails');
    await expect(page.locator('.toast', { hasText: 'That link didn’t open' })).toContainText('the stand-in opener failed');
  });
});
