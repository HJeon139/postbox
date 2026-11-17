// Runs the flexible-apps prototype’s network probe app in Google Chrome (designs/prototypes/flexible-apps.md), with a
// fresh profile, against a Postbox you started with the mock librarian and tools/probe-site.mjs. It signs in to the
// stand-in site, asks the librarian for the probe, waits for what the app published, then clicks its popup button and
// its link, and prints what happened as JSON.
// Run: node tools/probe-apps-chrome.mjs [--postbox http://localhost:4517] [--other http://127.0.0.1:4518] [--popup]
//   [--thread <a librarian conversation’s title>]

import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const POSTBOX = opt('--postbox', 'http://localhost:4517');
const OTHER = opt('--other', 'http://127.0.0.1:4518');
const popup = args.includes('--popup');
const TITLE = opt('--thread', 'Catalog tour');

// Playwright turns Chrome’s popup blocker off by default; a person’s Chrome has it on.
const browser = await chromium.launch({ channel: 'chrome', headless: true, ignoreDefaultArgs: ['--disable-popup-blocking'] });
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const opened = [];
context.on('page', (p) => opened.push(p));
const page = await context.newPage();
await page.goto(`${OTHER}/login`);
await page.goto(`${POSTBOX}/`);
const state = () => page.evaluate(() => fetch('/api/state').then((r) => r.json()));
const thread = Object.values((await state()).state.threads).find((t) => t.title === TITLE);
await page.goto(`${POSTBOX}/#/t/${thread.id}`);
const before = new Set(Object.keys((await state()).state.apps));
await page.evaluate(
  ([id, text]) => fetch(`/api/threads/${id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }),
  [thread.id, popup ? 'net probe popup' : 'net probe'],
);
let app = null;
for (let i = 0; i < 60 && !app?.published?.results; i++) {
  await page.waitForTimeout(500);
  app = Object.values((await state()).state.apps).find((a) => a.id.startsWith('net-probe') && !before.has(a.id)) ?? null;
}
await page.waitForTimeout(popup ? 3000 : 500);
const banner = await page.evaluate(() => [...document.body.children].some((el) => el.textContent === 'An app changed this page'));
const url = page.url();
let clicked = null;
if (app && !popup) {
  const frame = page.frameLocator(`iframe[src*="/sandbox/app/${app.id}/"]`).first();
  const n = opened.length;
  // An app frame takes no pointer events until the pointer is over it (app/js/app-pointer.mjs), so move there first,
  // as a person’s mouse does, then click.
  const press = async (sel) => {
    const el = frame.locator(sel);
    await el.scrollIntoViewIfNeeded();
    const b = await el.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
    await page.waitForTimeout(150);
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(1200);
  };
  await press('#pop');
  await press('#lnk');
  clicked = { newPages: opened.slice(n).map((p) => p.url()), postboxStillAt: page.url(), postboxUrlBefore: url };
}
console.log(
  JSON.stringify(
    {
      browser: `Google Chrome ${browser.version()}`,
      appId: app?.id ?? null,
      published: app?.published ?? null,
      bannerOnPostboxPage: banner,
      // A “csrf” note means the app’s own request, with no click, got past Postbox’s origin and token checks.
      csrfNoteTaken: Boolean(app?.notes?.some((n) => n.action === 'csrf')),
      popupsWithoutClick: popup ? opened.map((p) => p.url()) : undefined,
      postboxUrlAfterProbes: url,
      clicked,
    },
    null,
    2,
  ),
);
await browser.close();
