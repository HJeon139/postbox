// The headless Chromium the UAT runner and the screenshot tools drive: Playwright’s library on the Chromium build its
// version pins (designs/architecture.md, “Browser checks on Playwright Test”). Playwright talks to it over a pipe, and
// its headless shell exits when that pipe closes, so a script that’s SIGKILLed leaves no browser behind. Chromium’s
// full headless mode, the one the specs run, doesn’t: with a page open it outlived its killed script, on macOS with
// Chromium 156, as Chrome on a DevTools port did under tools/cdp.mjs. The callers read and drive the page through
// the DevTools protocol (send), as they did there.

import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A value as a JavaScript literal, to put in code the page runs. JSON alone leaves `<`, `>`, U+2028 and U+2029 as they
 * are, so they’re escaped as `\uXXXX`, which reads back as the same string (#343). Use it, not `JSON.stringify`, for
 * every value spliced into a `page.evaluate` or `page.waitFor` expression.
 * @param {unknown} value
 */
export const js = (value) => String(JSON.stringify(value)).replace(/[<>\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

// How long Chromium may take to start. A fresh CI runner’s first launch, with nothing cached, took longer than the
// 12 s the old driver allowed (run 39977434749).
const START_MS = 45000;

/**
 * Starts Playwright’s headless Chromium and opens its page. detached: the script owns SIGINT, SIGTERM and SIGHUP,
 * and Chromium stays up through them for a script that still needs its page to clean up (tools/uat-run.mjs).
 * Playwright runs it in a process group of its own, so a terminal’s Ctrl-C doesn’t reach it either. Otherwise the
 * first of those signals closes it, and the script exits.
 * @param {{ detached?: boolean }} [o]
 */
export async function launch({ detached = false } = {}) {
  /** @type {import('@playwright/test').Browser} */
  let browser;
  try {
    browser = await chromium.launch({
      timeout: START_MS,
      handleSIGINT: !detached,
      handleSIGTERM: !detached,
      handleSIGHUP: !detached,
      // An agent app’s sandboxed frame in a process of its own, as Chrome runs it for a person: the headless shell
      // otherwise runs it in the page’s, where a busy app would slow Postbox’s page with it.
      args: ['--site-per-process'],
    });
  } catch (e) {
    throw new Error(`Chromium didn’t start: ${String(e.message).split('\n')[0]}. npx playwright install chromium downloads the one Playwright pins.`);
  }
  // No viewport or color scheme of Playwright’s: size() sets them, as a check asks.
  const context = await browser.newContext({ viewport: null, colorScheme: null, reducedMotion: null });
  const pw = await context.newPage();
  const cdp = await context.newCDPSession(pw);
  const send = (method, params = {}) => cdp.send(method, params).catch((e) => Promise.reject(new Error(`${method}: ${e.message}`)));
  const logs = [];
  cdp.on('Runtime.exceptionThrown', (p) => logs.push(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`));
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') logs.push(`console.error: ${p.args.map((a) => a.value ?? a.description).join(' ')}`);
  });
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error') logs.push(`log: ${p.entry.text} ${p.entry.url ?? ''}`);
  });
  await send('Runtime.enable');
  await send('Log.enable');
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`In the page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  // Track requests in flight, to explain a page that never finishes loading.
  const inflight = new Map();
  pw.on('request', (r) => inflight.set(r, { url: r.url(), at: Date.now() }));
  for (const done of /** @type {const} */ (['requestfinished', 'requestfailed'])) pw.on(done, (r) => inflight.delete(r));

  const page = {
    send,
    evaluate,
    logs,
    /** The frame of the iframe that expr finds, to read and click inside an agent app, or null. */
    async frameOf(expr) {
      const handle = await pw.evaluateHandle(expr);
      const frame = (await handle.asElement()?.contentFrame()) ?? null;
      await handle.dispose();
      return frame;
    },
    pending: () => [...inflight.values()].map((r) => `${r.url.replace(/^https?:\/\/[^/]+/, '')} (${Math.round((Date.now() - r.at) / 1000)} s)`),
    async size(width, height, { mobile = width < 768, scale = mobile ? 2 : 1, theme } = {}) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
      await pw.emulateMedia({ reducedMotion: 'no-preference', colorScheme: theme ?? null });
    },
    async goto(url) {
      await pw.goto(url, { waitUntil: 'load', timeout: 15000 }).catch((e) => {
        throw new Error(`The page didn’t load: ${url} (${String(e.message).split('\n')[0]})`);
      });
      await evaluate('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 120))))');
    },
    /** Reloads the page and waits for the new document to load, so nothing after it reads the old one. */
    async reload() {
      await pw.reload({ waitUntil: 'load', timeout: 15000 }).catch(() => {
        throw new Error('The page didn’t load again after a reload.');
      });
    },
    async waitFor(expr, { timeout = 15000, label = expr } = {}) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        try {
          if (await evaluate(expr)) return true;
        } catch {}
        await sleep(150);
      }
      throw new Error(`Timed out waiting for: ${label}`);
    },
    /**
     * Waits until Postbox’s page has applied the server’s events up to seq (its store’s state.seq). A change made
     * on the server reaches the page over its event stream, which nothing orders with this protocol: on a busy
     * computer it comes after the next command (POSTBOX_STREAM_LAG shows it).
     */
    synced(seq, { timeout = 15000 } = {}) {
      return page.waitFor(`import('/app/js/client.mjs').then(({ client }) => client.seq >= ${Number(seq)})`, {
        timeout,
        label: `the page to hear the server’s event ${seq}`,
      });
    },
    /** Screenshot the full content height (the app shell is pinned to that height while capturing). */
    async shoot(file, { width, baseH, scale }) {
      const mobile = width < 768;
      const modal = await evaluate(`!!document.querySelector('.backdrop')`);
      const contentH = modal
        ? baseH
        : await evaluate(
            `(() => { const a = document.querySelector('.app'); if (a) a.style.minHeight = '0px'; return Math.ceil(document.documentElement.scrollHeight); })()`,
          );
      const h = Math.max(baseH, contentH);
      await send('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: scale, mobile });
      await evaluate(
        `(() => { const a = document.querySelector('.app'); if (a) a.style.minHeight = '${h}px'; document.documentElement.classList.add('shot'); })()`,
      );
      await sleep(250);
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(file, Buffer.from(data, 'base64'));
      await send('Emulation.setDeviceMetricsOverride', { width, height: baseH, deviceScaleFactor: scale, mobile });
      await evaluate(
        `(() => { const a = document.querySelector('.app'); if (a) a.style.minHeight = ''; document.documentElement.classList.remove('shot'); })()`,
      );
      return h;
    },
    /** Closes Chromium, and resolves once it has exited. */
    close: () => browser.close(),
  };
  return page;
}
