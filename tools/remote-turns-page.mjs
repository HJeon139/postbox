// The page tools/check-remote-turns.mjs and tools/check-remote-stop.mjs drive, open at the seeded room
// (tools/remote-turns-kit.mjs) at 1280 px, and what they drive it with: real clicks, a conversation opened as a link
// would, an agent’s row and ring, a reply’s item, axe, what spills past the window, and each case with a time limit.

import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { js, launch } from './cdp.mjs';
import { finish, record } from './harness.mjs';
import { app, CHROME_PORT, room, root } from './remote-turns-kit.mjs';

export const page = await launch({ port: CHROME_PORT });
export const settle = () => page.evaluate('new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 60)); setTimeout(r, 250); })');
export async function click(expr) {
  const r = await page.evaluate(
    `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  assert.ok(r, `Nothing to click: ${expr}`);
  for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type: t, x: r.x, y: r.y, button: t === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  await settle();
}
export const q = (sel) => `document.querySelector(${js(sel)})`;
/** Opens a conversation in the page that’s loaded, as a link would. */
export async function go(threadId) {
  await page.evaluate(`location.hash = '#/t/${threadId}'`);
  await page.waitFor(`document.querySelector('#main.transcript')?.dataset.thread === '${threadId}' && !!document.querySelector('#composer-input')`, {
    label: `the conversation ${threadId}`,
  });
  await settle();
}
export const text = (expr) => page.evaluate(`(${expr})?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`);
export const until = async (fn, label) => {
  for (let i = 0; i < 400; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
/** The text of the agent row for a handle, in the sidebar’s Agents. */
export const row = (handle) => text(`[...document.querySelectorAll('.agent-row')].find((n) => n.querySelector('b')?.textContent === '@${handle}')`);
export const ringLabel = (handle) =>
  page.evaluate(
    `[...document.querySelectorAll('.agent-row')].find((n) => n.querySelector('b')?.textContent === '@${handle}')?.querySelector('pb-ring svg')?.getAttribute('aria-label') ?? ''`,
  );
/** The transcript item of a reply, by its session. */
export const itemOf = (handle) =>
  `[...document.querySelectorAll('.transcript .item')].filter((n) => !n.hidden && n.querySelector('.who b')?.textContent === '@${handle}').at(-1)`;

const AXE = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const AXE_RUN = `axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] })
  .then((r) => r.violations.map((v) => \`\${v.id}: \${v.help} (\${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('; ')})\`))`;
export async function axe() {
  await page.evaluate(`${AXE};0`);
  return page.evaluate(AXE_RUN);
}
/** Elements of a selector that spill past the window’s sides. */
export const overflow = (sel) =>
  page.evaluate(
    `[...document.querySelectorAll(${js(sel)})].filter((n) => { const b = n.getBoundingClientRect(); return b.width && (b.right > innerWidth + 1 || b.left < -1); }).map((n) => n.className || n.tagName)`,
  );

export async function check(name, fn) {
  let timer;
  try {
    const late = new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error('Timed out after 30 s')), 30000);
    });
    await Promise.race([fn(), late]);
    record(true, name);
  } catch (e) {
    record(false, name, e.message);
  } finally {
    clearTimeout(timer);
  }
}

await page.size(1280, 900);
await page.goto(`${app.origin}/#/t/${room.id}`);
await page.waitFor(`!!${q('.agent-row')} && !!${q('.transcript .host-callout')}`, { label: 'the room, its agents and its replies' });
await settle();

/** Says whether the page threw, then closes it and Postbox, removes the data folder, and reports. */
export async function end() {
  const errors = page.logs.filter((l) => l.startsWith('exception'));
  record(!errors.length, 'the page threw no exceptions', errors.join('\n'));
  await page.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
  finish();
}
