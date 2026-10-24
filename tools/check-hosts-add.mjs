// Checks a host just added to the Hosts tab of Settings (#120) in headless Chrome, with the real host manager
// (server/remote/hosts.mjs) rather than a fake: with no token on this computer it says Not installed at once, and its
// card offers Install…, which has focus, so the next step is the next key press. Checked at 375 and 1280 px, with axe.
//
//   node tools/check-hosts-add.mjs
//
// It starts its own fresh Postbox (demo mode) over a new data folder, so no host has a token and nothing dials ssh:
// the check never installs. PB_PORT and PB_CHROME_PORT move the ports (4930 and 9530 by default). It reports through
// tools/harness.mjs.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { launch, sleep } from './cdp.mjs';
import { record as check, finish, ports } from './harness.mjs';

const { PORT, CHROME_PORT } = await ports(4930, 9530);
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-hosts-add-'));
// No hosts option: the server makes the real manager, keeping tokens in dataDir, which has none.
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true, claudeHome: dataDir });

// axe, as tools/shoot-app.mjs runs it: WCAG 2.1 A and AA.
const AXE = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8').catch(() => null);
const AXE_RUN = `axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] })
  .then((r) => r.violations.map((v) => v.id + ' (' + v.impact + '): ' + v.help + ' at ' + v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')))`;

/** @type {any} */
let page = null;
const js = JSON.stringify;
const text = (/** @type {string} */ sel) => page.evaluate(`document.querySelector(${js(sel)})?.textContent.replace(/\\s+/g, ' ').trim() ?? null`);
const focused = () => page.evaluate('document.activeElement?.id ?? null');

/** Adds a host as a person does, by typing its destination and pressing Add host or Enter; returns its id. */
async function add(name, how) {
  const before = new Set(Object.keys(app.store.state.hosts ?? {}));
  await page.evaluate(`(() => { const el = document.getElementById('ho-add'); el.focus(); el.value = ${js(name)};
    el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  if (how === 'enter') await page.evaluate(`document.getElementById('ho-add').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  else await page.evaluate(`(() => { const b = document.getElementById('ho-add-btn'); b.focus(); b.click(); })()`);
  for (let i = 0; i < 80 && Object.keys(app.store.state.hosts ?? {}).length === before.size; i++) await sleep(50);
  return Object.keys(app.store.state.hosts ?? {}).find((id) => !before.has(id)) ?? '';
}

/** A host just added: Not installed, Install… on its card with focus, and nothing dialed. */
async function justAdded(id, name, how) {
  await page.waitFor(`!!document.getElementById(${js(`ho-${id}-install`)})`, { label: `Install… for ${name}` });
  check(app.store.state.hostStatus?.[id]?.state === 'not-installed', `${how}: the manager says ${name} isn’t installed`, js(app.store.state.hostStatus?.[id]));
  check(/Not installed/.test((await text(`[data-host="${id}"] .status-tag`)) ?? ''), `${how}: its card says Not installed`);
  check(
    /isn’t installed on .+ yet/.test((await text(`[data-status="${id}"] .callout`)) ?? ''),
    `${how}: and says to install it first`,
    (await text(`[data-status="${id}"]`)) ?? '',
  );
  await page.waitFor(`document.activeElement?.id === ${js(`ho-${id}-install`)}`, { label: 'focus on Install…' }).catch(() => {});
  check((await focused()) === `ho-${id}-install`, `${how}: Install… has focus`, String(await focused()));
}

/** axe, and nothing wider than the window, at both widths; back at 1280 after. */
async function audit(label) {
  for (const [w, ht] of [
    [375, 812],
    [1280, 900],
  ]) {
    await page.size(w, ht);
    await sleep(250);
    const wide = await page.evaluate(
      `[...document.querySelectorAll('.dialog *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1 && el.offsetParent !== null).map((el) => el.tagName + '.' + el.className).slice(0, 3)`,
    );
    check(!wide.length, `${label}: nothing runs off the window at ${w} px`, wide.join(', '));
    if (AXE) {
      const v = await page.evaluate(AXE_RUN);
      check(!v.length, `${label}: no axe violations at ${w} px`, v.join('\n'));
    }
  }
}

try {
  page = await launch({ port: CHROME_PORT });
  await page.size(1280, 900);
  await page.goto(`${app.origin}/`);
  await page.waitFor(`!!document.querySelector('.app')`, { label: 'the app' });
  if (AXE) await page.evaluate(`${AXE};0`);
  else check(false, 'axe-core is installed', 'Run npm install.');
  await page.evaluate(`import('/app/js/sheets.mjs').then((m) => m.openSettings('hosts'))`);
  await page.waitFor(`!!document.getElementById('ho-add')`, { label: 'the Hosts tab' });

  const first = await add('build.example.com', 'button');
  check(Boolean(first), 'Add host adds it');
  await justAdded(first, 'build.example.com', 'Add host');
  await audit('a host just added');

  const second = await add('user@host.example.com', 'enter');
  check(Boolean(second), 'Enter in the field adds it');
  await justAdded(second, 'user@host.example.com', 'Enter');
  await audit('two hosts just added');

  // Install… opens the confirm, which installs nothing until its own Install is pressed (the check stops there).
  await page.evaluate(`document.getElementById(${js(`ho-${second}-install`)}).click()`);
  await page.waitFor(`!!document.querySelector('.ho-install-text')`, { label: 'the install confirm' });
  check(/Install Postbox’s host program on user@host\.example\.com\?/.test((await text('.ho-install-text')) ?? ''), 'Install… asks first');
  await audit('the install confirm for a host just added');

  const errors = page.logs.filter((/** @type {string} */ l) => !/api\/stream|ERR_INCOMPLETE_CHUNKED/.test(l));
  check(!errors.length, 'no errors in the browser console', errors.join('\n'));
} catch (e) {
  check(false, 'the check ran to the end', e?.stack ?? String(e));
} finally {
  await page?.close().catch(() => {});
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
finish();
