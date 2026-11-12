// Screenshots the real app: plays the demo (tools/demo.mjs) in headless Chromium and captures every scene
// at 1280 and 375 px in dark and light, plus a sheet per scene with its four versions.
//
//   node tools/shoot-app.mjs              → screenshots/latest/app/ (ignored by git)
//   node tools/shoot-app.mjs --baseline   → screenshots/app/ (ignored by git, but the README’s picture)
//
// It takes pictures and checks nothing: axe-core runs on the same scenes and variants in
// tests/browser/demo-a11y.spec.mjs, CI’s gate on the demo.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../server/index.mjs';
import { launch, sleep } from './browser.mjs';
import { play } from './demo.mjs';
import { demoUI } from './demo-ui.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const baseline = process.argv.includes('--baseline');
const OUT = join(ROOT, 'screenshots', ...(baseline ? ['app'] : ['latest', 'app']));
// PB_PORT moves it, so sessions working in parallel don’t collide.
const PORT = Number(process.env.PB_PORT ?? 4281);
const VARIANTS = [
  ['dark', 1280, 900, 1],
  ['light', 1280, 900, 1],
  ['dark', 375, 812, 2],
  ['light', 375, 812, 2],
];

await mkdir(join(OUT, 'sheets'), { recursive: true });
const dataDir = join(tmpdir(), `pb-shoot-app-${process.pid}`);
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
const origin = `http://127.0.0.1:${PORT}`;
// The driver stays on the current thread at desktop size so agent apps get checked there; the shooter,
// a second browser, captures each variant without running checks of its own.
const driver = await launch();
const page = await launch();
let hash = '#/';
let loads = 0;
const settle = async () => {
  // Wait for app frames to finish checking and loading, and for streaming text to paint.
  await page
    .waitFor(
      `![...document.querySelectorAll('.app-placeholder')].some((p) => /Checking/.test(p.textContent))
    && [...document.querySelectorAll('iframe.app-iframe')].every((f) => f.dataset.sized)
    && !document.querySelector('.md-math:not(.rendered)')`,
      { timeout: 15000 },
    )
    .catch(async () => {
      const why = await page
        .evaluate(
          `JSON.stringify({ katex: typeof katex, unrendered: document.querySelectorAll('.md-math:not(.rendered)').length, frames: [...document.querySelectorAll('iframe')].map((f) => (f.className || 'diagram') + (f.dataset.sized ? ' sized' : ' waiting')), scripts: [...document.scripts].map((x) => x.src.split('/').pop()).filter(Boolean) })`,
        )
        .catch((e) => e.message);
      console.log(`  (some frames or math didn’t finish loading: ${why})\n  pending: ${page.pending().join(', ')}`);
    });
  await sleep(900);
};

const ui = demoUI(page);

async function goto(theme, w, h, scale) {
  await page.size(w, h, { theme, scale });
  // A changing query string forces a full load; a hash-only change wouldn’t fire the load event.
  await page.goto(`${origin}/?nocheck&v=${++loads}${hash}`);
  await settle();
}
async function drive(h) {
  await driver.size(1280, 900, { theme: 'dark' });
  await driver.goto(`${origin}/?v=${++loads}${h}`);
}

const shots = [];
let scene = 'the first scene';
const STOP_AFTER = process.env.STOP_AFTER;
try {
  await drive(hash);
  await play({
    origin,
    speed: 0.3,
    log: (m) => console.log(`· ${m}`),
    view: async (h) => {
      hash = h;
      await drive(h);
    },
    shot: async (name, { prepare } = {}) => {
      scene = name;
      for (const [theme, w, h, scale] of VARIANTS) {
        await goto(theme, w, h, scale);
        if (prepare) await prepare(ui);
        const file = join(OUT, `${name}-${theme}-${w}.png`);
        const height = await page.shoot(file, { width: w, baseH: h, scale });
        console.log(`  ${name}-${theme}-${w}.png  ${w}×${height}`);
      }
      shots.push(name);
      scene = `the scene after ${name}`;
      if (STOP_AFTER && name === STOP_AFTER) throw new Error(`Stopped after ${name}, as asked.`);
    },
  });
} catch (e) {
  console.error(`Stopped: ${e.message}`);
  // CI goes on past this step, as the spec is the gate on the demo: a warning in the run’s summary says where the pictures stop.
  if (process.env.GITHUB_ACTIONS) {
    const message = `${shots.length} scenes have screenshots and the rest have none. ${e.message}`
      .replace(/%/g, '%25')
      .replace(/\r/g, '%0D')
      .replace(/\n/g, '%0A');
    console.log(`::warning title=Screenshots stopped at ${scene}::${message}`);
  }
  console.error(page.logs.slice(-15).join('\n'));
  console.error(
    await page
      .evaluate(
        `JSON.stringify({ url: location.href, frames: [...document.querySelectorAll('iframe')].map((f) => f.className + ' ' + f.getAttribute('src')), placeholders: [...document.querySelectorAll('.app-placeholder')].map((p) => p.textContent.slice(0, 80)) })`,
      )
      .catch((x) => x.message),
  );
  process.exitCode = 1;
}

// Sheets: the app’s four versions of each scene.
for (const name of shots) {
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#8a8178;font:13px system-ui;color:#111;padding:20px}
    .r{display:flex;gap:20px;align-items:flex-start;margin-bottom:24px} figure{margin:0} figcaption{font-weight:600;margin:0 0 6px} img{display:block;border:1px solid #0003}
    .d img{width:640px} .m img{width:300px}</style>
    <h1 style="margin:0 0 14px;font-size:18px">${name}</h1>
    <div class="r"><figure class="d"><figcaption>App · 1280 · dark</figcaption><img src="../${name}-dark-1280.png"></figure></div>
    <div class="r"><figure class="d"><figcaption>App · 1280 · light</figcaption><img src="../${name}-light-1280.png"></figure>
      <figure class="m"><figcaption>App · 375 · dark</figcaption><img src="../${name}-dark-375.png"></figure>
      <figure class="m"><figcaption>App · 375 · light</figcaption><img src="../${name}-light-375.png"></figure></div>`;
  const sheetFile = join(OUT, 'sheets', `${name}.html`);
  await writeFile(sheetFile, html);
  await page.size(1360, 700, { scale: 1 });
  await page.goto(`file://${sheetFile}`);
  await page.shoot(join(OUT, 'sheets', `${name}.png`), { width: 1360, baseH: 700, scale: 1 });
  await rm(sheetFile);
  console.log(`  sheets/${name}.png`);
}

const errors = [...driver.logs, ...page.logs].filter((l) => !/api\/stream|ERR_INCOMPLETE_CHUNKED|503|ERR_CONNECTION_REFUSED/.test(l));
if (errors.length) console.log(`\nBrowser errors:\n${[...new Set(errors)].join('\n')}`);
await page.close();
await driver.close();
await app.close();
await rm(dataDir, { recursive: true, force: true });
