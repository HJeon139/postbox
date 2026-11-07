// Holds view_app’s browser (server/view-app/browser.mjs) open until it’s killed, for
// tests/process/view-app-kill.test.mjs. It uses the headless shell Playwright already installed, and prints “ready”
// once a page with a sandboxed frame has loaded, so Chromium has the processes an agent app gives it.
//
//   node tests/fixtures/view-app-hold.mjs

import { AppBrowser } from '../../server/view-app/browser.mjs';
import { playwrightBrowsers } from './playwright-browsers.mjs';

const b = new AppBrowser({ dir: playwrightBrowsers() });
const browser = await b.browser();
const page = await browser.newPage();
await page.goto(`data:text/html,<p>Held open</p><iframe sandbox="allow-scripts" srcdoc="<p>An app</p>"></iframe>`);
console.log('ready');
setInterval(() => b.touch(), 1000);
