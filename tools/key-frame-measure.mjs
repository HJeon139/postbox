// PF-1’s key-to-frame measurement on one open conversation (#508, designs/508/requirements.md, PF-1): it clicks the
// composer, waits for the page to hold still, then types keys at a steady interval through Chromium’s input, as a
// person’s keyboard does, and reads two times for each key:
// - Event Timing: the composer’s keydown, keypress and input entries (PerformanceObserver type “event”,
//   durationThreshold 16), from the key’s event to the frame that showed it. This decides PF-1’s p95.
// - The next frame: the keydown’s timeStamp to the second requestAnimationFrame after it, a cross-check of our own.
// It drives the page tools/browser.mjs opens, so the bench (tools/bench-key-frame.mjs) and the UAT runner share it.

import { execFileSync } from 'node:child_process';
import { arch, cpus, release, type } from 'node:os';
import { sleep } from './browser.mjs';
import { keyDurations, outsideWindow } from './key-frame-stats.mjs';
import { heldStill } from './page-still.mjs';

/** The smallest durationThreshold Chromium allows, and the one PF-1 measures at. */
export const EVENT_THRESHOLD = 16;
const TEXT = 'the release train leaves on time and the changelog says what shipped ';

/**
 * @typedef {{ evaluate: (expr: string) => Promise<any>, send: (method: string, params?: any) => Promise<any>,
 *   waitFor: (expr: string, o?: { timeout?: number, label?: string }) => Promise<boolean> }} Page
 */

/** Starts recording in the page: each composer keydown’s time and next frame, and its Event Timing entries. */
function record(threshold) {
  const rec = { keys: [], frames: [], entries: [] };
  /** @type {any} */ (window).__keyFrame = rec;
  const composer = () => document.getElementById('composer-input');
  addEventListener(
    'keydown',
    (e) => {
      if (e.target !== composer()) return;
      const at = e.timeStamp;
      rec.keys.push(at);
      requestAnimationFrame(() => requestAnimationFrame(() => rec.frames.push(performance.now() - at)));
    },
    true,
  );
  const names = new Set(['keydown', 'keypress', 'input']);
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const target = /** @type {any} */ (e).target;
      if (names.has(e.name) && target === composer()) rec.entries.push({ name: e.name, startTime: e.startTime, duration: e.duration });
    }
  }).observe(/** @type {any} */ ({ type: 'event', durationThreshold: threshold }));
}

/** Empties the draft, as the setup before a run, not as part of what it measures, and after it. */
export function clearDraft() {
  const ta = /** @type {HTMLTextAreaElement} */ (document.getElementById('composer-input'));
  ta.value = '';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Clicks the composer’s middle with the mouse, as a person does before typing. @param {Page} page */
async function clickComposer(page) {
  await page.waitFor(`!!document.getElementById('composer-input')`, { label: 'the composer' });
  const at = await page.evaluate(
    `(() => { const b = document.getElementById('composer-input').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
}

/** One key, down and up, through Chromium’s input. @param {Page} page  @param {string} ch  a lowercase letter or a space */
async function press(page, ch) {
  const isSpace = ch === ' ';
  const key = { key: ch, code: isSpace ? 'Space' : `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, ...key });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

/** Until the page has drawn two more frames. @param {Page} page */
const frames = (page) => page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');

/**
 * Types warmup keys and then keys into the open conversation’s composer, one every intervalMs, and returns each
 * measured key’s Event Timing time and next-frame time, in ms.
 * @param {Page} page  @param {{ keys?: number, warmup?: number, intervalMs?: number, threshold?: number }} [o]
 */
export async function measureKeys(page, { keys = 200, warmup = 20, intervalMs = 50, threshold = EVENT_THRESHOLD } = {}) {
  await clickComposer(page);
  const shown = await page.evaluate(
    `(() => { const b = document.getElementById('composer-input').getBoundingClientRect(); return { rect: { top: b.top, bottom: b.bottom, left: b.left, right: b.right }, window: { width: outerWidth, height: outerHeight } }; })()`,
  );
  const hidden = outsideWindow(shown.rect, shown.window);
  if (hidden) throw new Error(`${hidden} Size the window with page.size() before measuring.`);
  await page.evaluate(`(${clearDraft})()`);
  await page.waitFor(`(${heldStill})()`, { timeout: 30_000, label: 'the page to hold still for two frames' });
  await page.evaluate(`(${record})(${Number(threshold)})`);
  const total = warmup + keys;
  const start = Date.now();
  for (let i = 0; i < total; i++) {
    await sleep(Math.max(0, start + i * intervalMs - Date.now()));
    await press(page, TEXT[i % TEXT.length]);
  }
  await frames(page);
  // Event Timing reports an entry only after the frame that showed its key; give the last ones time to arrive.
  await sleep(500);
  const rec = await page.evaluate('window.__keyFrame');
  if (rec.keys.length !== total) throw new Error(`The composer heard ${rec.keys.length} of ${total} keys; is it focused?`);
  const measured = rec.keys.slice(warmup);
  const { values, below } = keyDurations(measured, rec.entries, threshold);
  return { eventTiming: values, nextFrame: rec.frames.slice(warmup), below };
}

/** The commit measured: HEAD’s short hash, with “+changes” when the tree differs from it. @param {string} root */
export function commitOf(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const head = git('rev-parse', '--short=8', 'HEAD');
  return git('status', '--porcelain').length ? `${head}+changes` : head;
}

/** The machine, without its name or any home path: os, arch, cpu model, Node and Chromium. @param {Page} page */
export async function machineOf(page) {
  const { product } = await page.send('Browser.getVersion');
  return {
    os: `${type()} ${release()}`,
    arch: arch(),
    cpu: cpus()[0]?.model ?? 'unknown',
    node: process.version,
    chromium: String(product).replace(/^[^/]*\//, ''),
  };
}
