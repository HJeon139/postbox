// Screenshots every mockup at 375 px and 1280 px, in dark and light, through headless Chrome over the
// DevTools protocol (no dependencies). Then builds one review sheet per page.
// Usage: node tools/shoot.mjs [--baseline] [page-prefix ...]     e.g. node tools/shoot.mjs 03 07
// Retakes go to screenshots/latest/ (ignored by git). --baseline writes the approved set in screenshots/,
// which is committed and only changes when a design change is approved.
import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const baseline = process.argv.includes('--baseline');
const OUT = join(ROOT, 'screenshots', ...(baseline ? [] : ['latest']));
const PORT = 4174,
  DEBUG = 9333;
const WIDTHS = [
  [1280, 900, 1],
  [375, 812, 2],
];
const THEMES = ['dark', 'light'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const pages = (await readdir(join(ROOT, 'mockups'))).filter((f) => /^\d\d-.*\.html$/.test(f) && (!only.length || only.some((p) => f.startsWith(p)))).sort();

const server = await serve(PORT);
const profile = join(tmpdir(), `pb-shoot-${process.pid}`);
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${DEBUG}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try {
    target = (await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json()).find((t) => t.type === 'page');
  } catch {}
}
if (!target) throw new Error('Chrome did not start');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok) => ws.addEventListener('open', ok, { once: true }));
let seq = 0;
const waiting = new Map(),
  listeners = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m);
    waiting.delete(m.id);
  } else if (m.method)
    listeners.forEach((l) => {
      l(m);
    });
});
const send = (method, params = {}) =>
  new Promise((ok, fail) => {
    const id = ++seq;
    waiting.set(id, (m) => (m.error ? fail(new Error(`${method}: ${m.error.message}`)) : ok(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
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
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

await send('Page.enable');
await send('Runtime.enable');
await mkdir(OUT, { recursive: true });

async function capture(url, width, baseH, scale, file) {
  const mobile = width < 768;
  await send('Emulation.setDeviceMetricsOverride', { width, height: baseH, deviceScaleFactor: scale, mobile });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  const loaded = once('Page.loadEventFired');
  await send('Page.navigate', { url });
  await loaded;
  await evaluate('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 150))))');
  // Measure the content with the full-height shell switched off (phone emulation sizes vh differently),
  // then size the viewport to it and pin the shell to that height.
  const contentH = await evaluate(`(() => { const a = document.querySelector('.app'); if (a) a.style.minHeight = '0px';
    const h = Math.ceil(document.documentElement.scrollHeight); return h; })()`);
  // A modal dialog is shown at the device's own height, as a person would see it.
  const modal = await evaluate(`!!document.querySelector('.backdrop')`);
  const h = modal ? baseH : Math.max(baseH, contentH);
  await send('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: scale, mobile });
  await evaluate(`(() => { const a = document.querySelector('.app'); if (a) a.style.minHeight = '${h}px'; })()`);
  await sleep(150);
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(file, Buffer.from(data, 'base64'));
  return h;
}

const made = [];
for (const page of pages) {
  const name = page.replace('.html', '');
  for (const theme of THEMES)
    for (const [w, h, s] of WIDTHS) {
      const file = join(OUT, `${name}-${theme}-${w}.png`);
      const height = await capture(`http://127.0.0.1:${PORT}/mockups/${page}?theme=${theme}&shot=1`, w, h, s, file);
      console.log(`${name}-${theme}-${w}.png  ${w}×${height}`);
    }
  made.push(name);
}

// One review sheet per page: both widths, both themes, side by side.
await mkdir(join(OUT, 'sheets'), { recursive: true });
const sheet = (name) => `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#8a8178;font:13px system-ui;color:#111;padding:20px}
  .r{display:flex;gap:20px;align-items:flex-start} figure{margin:0} figcaption{font-weight:600;margin:0 0 6px}
  img{display:block;border:1px solid #0003}
  .d img{width:640px} .m img{width:300px}
</style><h1 style="margin:0 0 14px;font-size:18px">${name}</h1><div class="r">
  <figure class="d"><figcaption>1280 · dark</figcaption><img src="../${name}-dark-1280.png"></figure>
  <figure class="d"><figcaption>1280 · light</figcaption><img src="../${name}-light-1280.png"></figure>
  <figure class="m"><figcaption>375 · dark</figcaption><img src="../${name}-dark-375.png"></figure>
  <figure class="m"><figcaption>375 · light</figcaption><img src="../${name}-light-375.png"></figure></div>`;
for (const name of made) {
  await writeFile(join(OUT, 'sheets', `${name}.html`), sheet(name));
  await capture(`http://127.0.0.1:${PORT}/${OUT.slice(ROOT.length).replace(/^\//, '')}/sheets/${name}.html`, 1980, 600, 1, join(OUT, 'sheets', `${name}.png`));
  await rm(join(OUT, 'sheets', `${name}.html`));
  console.log(`sheets/${name}.png`);
}

ws.close();
chrome.kill();
server.close();
await rm(profile, { recursive: true, force: true }).catch(() => {});
