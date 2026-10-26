// Holds a page of tools/browser.mjs open until it’s killed, for tests/process/browser-kill.test.mjs: started with
// `detached`, as the UAT runner starts its Chromium, or without, as the screenshot tools do. A sandboxed frame gives
// Chromium the processes an agent app does. It prints “ready” once the page has loaded.
//
//   node tests/fixtures/browser-hold.mjs [detached]

import { launch } from '../../tools/browser.mjs';

const page = await launch({ detached: process.argv[2] === 'detached' });
await page.goto(`data:text/html,<p>Held open</p><iframe sandbox="allow-scripts" srcdoc="<p>An app</p>"></iframe>`);
console.log('ready');
setInterval(() => {}, 1000);
