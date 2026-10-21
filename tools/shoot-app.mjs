// Screenshots the real app: plays the demo (tools/demo.mjs) in headless Chrome and captures every scene
// at 1280 and 375 px in dark and light, plus a sheet per scene that puts the approved mockup beside the app.
//
//   node tools/shoot-app.mjs              → screenshots/latest/app/ (ignored by git)
//   node tools/shoot-app.mjs --baseline   → screenshots/app/, the approved set
//
// Every variant is also checked with axe-core for WCAG 2.1 A and AA problems; any violation fails the
// run and is listed in axe.json beside the screenshots. AXE=0 skips it.

import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../server/index.mjs';
import { launch, sleep } from './cdp.mjs';
import { play } from './demo.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const baseline = process.argv.includes('--baseline');
const OUT = join(ROOT, 'screenshots', ...(baseline ? ['app'] : ['latest', 'app']));
const PORT = 4281;
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
const driver = await launch({ port: 9341 });
const page = await launch({ port: 9344 });
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
page.attach = async (rel) => {
  const { root } = await page.send('DOM.getDocument', {});
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.composer input[type=file]' });
  if (nodeId) await page.send('DOM.setFileInputFiles', { nodeId, files: [resolve(ROOT, rel)] });
  await sleep(600);
};

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

// axe runs in the app page. Agent apps are sandboxed frames with an opaque origin, which it can’t enter;
// their own pre-display check covers labels, contrast and overflow inside them.
const AXE = process.env.AXE === '0' ? null : await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8').catch(() => null);
if (!AXE && process.env.AXE !== '0') console.log('axe-core isn’t installed, so accessibility checks are skipped. Run npm install.');
const AXE_RUN = `axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] })
  .then((r) => r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) })))`;
const violations = [];
async function audit(name, theme, w) {
  if (!AXE) return;
  // The screenshot made the viewport tall for a moment; let frames resize back first.
  await sleep(300);
  await page.evaluate(`${AXE};0`);
  for (const v of await page.evaluate(AXE_RUN)) violations.push({ scene: name, variant: `${theme}-${w}`, ...v });
}

const shots = [];
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
      for (const [theme, w, h, scale] of VARIANTS) {
        await goto(theme, w, h, scale);
        if (prepare) await prepare(page);
        const file = join(OUT, `${name}-${theme}-${w}.png`);
        const height = await page.shoot(file, { width: w, baseH: h, scale });
        console.log(`  ${name}-${theme}-${w}.png  ${w}×${height}`);
        await audit(name, theme, w);
      }
      shots.push(name);
      if (STOP_AFTER && name === STOP_AFTER) throw new Error(`Stopped after ${name}, as asked.`);
    },
  });
} catch (e) {
  console.error(`Stopped: ${e.message}`);
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

// Sheets: the approved mockup beside the app (1280, dark), then the app’s four versions.
const exists = (p) =>
  access(p).then(
    () => true,
    () => false,
  );
for (const name of shots) {
  const mock = join(ROOT, 'screenshots', `${name}-dark-1280.png`);
  const _rel = (p) => p.replace(OUT + '/', '../');
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#8a8178;font:13px system-ui;color:#111;padding:20px}
    .r{display:flex;gap:20px;align-items:flex-start;margin-bottom:24px} figure{margin:0} figcaption{font-weight:600;margin:0 0 6px} img{display:block;border:1px solid #0003}
    .d img{width:640px} .m img{width:300px}</style>
    <h1 style="margin:0 0 14px;font-size:18px">${name}</h1>
    <div class="r">${(await exists(mock)) ? `<figure class="d"><figcaption>Approved mockup · 1280 · dark</figcaption><img src="${'file://' + mock}"></figure>` : ''}
      <figure class="d"><figcaption>App · 1280 · dark</figcaption><img src="../${name}-dark-1280.png"></figure></div>
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

if (AXE) {
  await writeFile(join(OUT, 'axe.json'), JSON.stringify(violations, null, 2));
  if (violations.length) {
    console.log(`\nAccessibility (axe-core): ${violations.length} violation${violations.length === 1 ? '' : 's'}, listed in ${join(OUT, 'axe.json')}`);
    for (const v of violations) console.log(`  ${v.scene} ${v.variant}  ${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.join('\n    ')}`);
    process.exitCode = 1;
  } else console.log('\nAccessibility (axe-core): no violations.');
}

const errors = [...driver.logs, ...page.logs].filter((l) => !/api\/stream|ERR_INCOMPLETE_CHUNKED|503|ERR_CONNECTION_REFUSED/.test(l));
if (errors.length) console.log(`\nBrowser errors:\n${[...new Set(errors)].join('\n')}`);
await page.close();
await driver.close();
await app.close();
await rm(dataDir, { recursive: true, force: true });
