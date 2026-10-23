// A minimal headless-Chrome driver over the DevTools protocol, with no dependencies.
// Used by the screenshot tools and the end-to-end checks.

import { spawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How long Chrome may take to open its DevTools port. A fresh CI runner’s first launch, with nothing cached, took
// longer than the 12 s this used to allow (run 39977434749).
const START_MS = 45000;

export async function launch({ port = 9333 } = {}) {
  const profile = join(tmpdir(), `pb-cdp-${process.pid}-${port}`);
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  // What Chrome last said, and whether it ended, to say why when it doesn’t start.
  let said = '';
  chrome.stderr.on('data', (d) => {
    said = (said + d).slice(-2000);
  });
  /** @type {string | null} */
  let ended = null;
  chrome.once('error', (e) => {
    ended = `it couldn’t be run: ${e.message}`;
  });
  chrome.once('exit', (code, signal) => {
    ended ??= `it exited (${signal ?? `code ${code}`})`;
  });
  // A script that exits without close() (a check that throws, say) mustn’t leave its Chrome running.
  const orphan = () => chrome.kill();
  process.once('exit', orphan);
  let target;
  for (const end = Date.now() + START_MS; !target && !ended && Date.now() < end; ) {
    await sleep(200);
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
    } catch {}
  }
  if (!target) {
    chrome.kill();
    const why = ended ?? `its DevTools port, ${port}, didn’t answer within ${START_MS / 1000} s`;
    const last = said.trim() ? `\nChrome’s last output:\n${said.trim()}` : '';
    throw new Error(`Chrome didn’t start: ${why}. It ran ${CHROME}; set CHROME to Chrome’s path if that’s wrong.${last}`);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok) => ws.addEventListener('open', ok, { once: true }));
  let seq = 0;
  const waiting = new Map();
  const listeners = [];
  const logs = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)(m);
      waiting.delete(m.id);
    } else if (m.method) {
      if (m.method === 'Runtime.exceptionThrown') logs.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
        logs.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push(`log: ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
      listeners.forEach((l) => {
        l(m);
      });
    }
  });
  // sessionId: a frame in another process (a sandboxed app), attached with frameSession() below.
  const send = (method, params = {}, sessionId = undefined) =>
    new Promise((ok, fail) => {
      const id = ++seq;
      waiting.set(id, (m) => (m.error ? fail(new Error(`${method}: ${m.error.message}`)) : ok(m.result)));
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const once = (method) =>
    new Promise((ok) => {
      const l = (m) => {
        if (m.method === method) {
          listeners.splice(listeners.indexOf(l), 1);
          ok(m.params);
        }
      };
      listeners.push(l);
    });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`In the page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  // Sandboxed frames run in their own process: attach to each, so the UAT can read and click inside apps.
  const frames = new Map(); // frame id → CDP session id
  listeners.push((m) => {
    if (m.method === 'Target.attachedToTarget' && m.params.targetInfo.type === 'iframe') frames.set(m.params.targetInfo.targetId, m.params.sessionId);
    if (m.method === 'Target.detachedFromTarget') for (const [f, sid] of frames) if (sid === m.params.sessionId) frames.delete(f);
  });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  // Track requests in flight, to explain a page that never finishes loading.
  const inflight = new Map();
  await send('Network.enable');
  listeners.push((m) => {
    if (m.method === 'Network.requestWillBeSent') inflight.set(m.params.requestId, { url: m.params.request.url, at: Date.now() });
    if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') inflight.delete(m.params.requestId);
  });

  const page = {
    send,
    evaluate,
    logs,
    /** The CDP session of a frame in another process, or null when it shares the page’s. */
    frameSession: (frameId) => frames.get(frameId) ?? null,
    /** Calls fn with the params of every CDP event named method. */
    on: (method, fn) => listeners.push((m) => m.method === method && fn(m.params)),
    pending: () => [...inflight.values()].map((r) => `${r.url.replace(/^https?:\/\/[^/]+/, '')} (${Math.round((Date.now() - r.at) / 1000)} s)`),
    async size(width, height, { mobile = width < 768, scale = mobile ? 2 : 1, theme } = {}) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
      await send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }, ...(theme ? [{ name: 'prefers-color-scheme', value: theme }] : [])],
      });
    },
    async goto(url) {
      const loaded = once('Page.loadEventFired');
      await send('Page.navigate', { url });
      let timer;
      const late = new Promise((_, fail) => {
        timer = setTimeout(() => fail(new Error(`The page didn’t load: ${url}`)), 15000);
      });
      await Promise.race([loaded, late]).finally(() => clearTimeout(timer));
      await evaluate('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 120))))');
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
     * computer it comes after the next command (check-all.mjs --lag shows it).
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
    async close() {
      ws.close();
      chrome.kill();
      process.off('exit', orphan);
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
  return page;
}
