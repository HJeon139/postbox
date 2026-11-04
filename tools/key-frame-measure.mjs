// PF-1’s key-to-frame measurement on one open conversation (#508, designs/508/requirements.md, PF-1): it clicks the
// composer, waits for the page to hold still, then types keys at a steady interval through Chromium’s input, as a
// person’s keyboard does, and reads two times for each key:
// - Event Timing: the composer’s keydown, keypress and input entries (PerformanceObserver type “event”,
//   durationThreshold 16), from the key’s event to the frame that showed it. This decides PF-1’s p95.
// - The next frame: the keydown’s timeStamp to the second requestAnimationFrame after it, a cross-check of our own.
// It drives the page tools/browser.mjs opens, so the bench (tools/bench-key-frame.mjs) and the UAT runner share it.

import { execFileSync } from 'node:child_process';
import { arch, cpus, loadavg, release, type } from 'node:os';
import { sleep } from './browser.mjs';
import { calibrated, keyDurations, outsideWindow } from './key-frame-stats.mjs';
import { heldStill } from './page-still.mjs';

/** The smallest durationThreshold Chromium allows, and the one PF-1 measures at. */
export const EVENT_THRESHOLD = 16;
/**
 * How long the first warm-up key, the calibration key, waits in its keydown on purpose: well over one frame, so
 * Event Timing must report it if the observer measures this composer.
 */
export const CALIBRATION_MS = 40;
const TEXT = 'the release train leaves on time and the changelog says what shipped ';

/**
 * @typedef {{ evaluate: (expr: string) => Promise<any>, send: (method: string, params?: any) => Promise<any>,
 *   waitFor: (expr: string, o?: { timeout?: number, label?: string }) => Promise<boolean> }} Page
 */

/**
 * Starts recording in the page: each composer keydown’s time and next frame, and its Event Timing entries. The first
 * keydown waits calibrationMs, so the run can prove the observer sees this composer (calibrated()).
 */
function record(threshold, calibrationMs) {
  // An earlier run’s listener and observer would still be recording into this document, so its keys would count twice.
  if ('__keyFrame' in window) throw new Error('This document is already recording: open the room afresh for each run.');
  const rec = { keys: [], frames: [], entries: [] };
  /** @type {any} */ (window).__keyFrame = rec;
  const composer = () => document.getElementById('composer-input');
  addEventListener(
    'keydown',
    (e) => {
      if (e.target !== composer()) return;
      const at = e.timeStamp;
      rec.keys.push(at);
      if (rec.keys.length === 1) {
        const until = performance.now() + calibrationMs;
        while (performance.now() < until) {
          // The calibration key’s wait: a busy loop, as a slow handler would be.
        }
      }
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

/**
 * The browser window’s size, as Chromium reports it. The page’s outerWidth and outerHeight follow mobile emulation,
 * so a phone-sized page in a smaller window would read as fitting. @param {Page} page
 */
async function windowSize(page) {
  const { windowId } = await page.send('Browser.getWindowForTarget');
  const { bounds } = await page.send('Browser.getWindowBounds', { windowId });
  return { width: bounds.width, height: bounds.height };
}

/** Until the page has drawn two more frames. @param {Page} page */
const frames = (page) => page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');

/**
 * Types warmup keys and then keys into the open conversation’s composer, one every intervalMs, and returns each
 * measured key’s Event Timing time and next-frame time, in ms.
 * @param {Page} page  @param {{ keys?: number, warmup?: number, intervalMs?: number, threshold?: number }} [o]
 */
export async function measureKeys(page, { keys = 200, warmup = 20, intervalMs = 50, threshold = EVENT_THRESHOLD } = {}) {
  if (warmup < 1) throw new Error('A run needs at least one warm-up key: the first is the calibration key.');
  await clickComposer(page);
  const shown = await page.evaluate(
    `(() => { const b = document.getElementById('composer-input').getBoundingClientRect(); return { rect: { top: b.top, bottom: b.bottom, left: b.left, right: b.right } }; })()`,
  );
  const hidden = outsideWindow(shown.rect, await windowSize(page));
  if (hidden) throw new Error(`${hidden} Size the window with page.size() before measuring.`);
  await page.evaluate(`(${clearDraft})()`);
  await page.waitFor(`(${heldStill})()`, { timeout: 30_000, label: 'the page to hold still for two frames' });
  await page.evaluate(`(${record})(${Number(threshold)}, ${CALIBRATION_MS})`);
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
  // A key the page stops from typing draws nothing, so it would read as a fast one.
  const typed = Array.from({ length: total }, (_, i) => TEXT[i % TEXT.length]).join('');
  const draft = await page.evaluate(`document.getElementById('composer-input').value`);
  if (draft !== typed) throw new Error(`The composer holds ${String(draft ?? '').length} of the ${total} characters typed.`);
  if (!calibrated(rec.keys, rec.entries, CALIBRATION_MS)) {
    throw new Error('Event Timing recorded no entry for the calibration key; the observer isn’t measuring this composer.');
  }
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

/** The machine, without its name or any home path: os, arch, cpu model and Node. */
export function hostOf() {
  return { os: `${type()} ${release()}`, arch: arch(), cpu: cpus()[0]?.model ?? 'unknown', node: process.version };
}

/** The machine as hostOf() gives it, and Chromium’s version. @param {Page} page */
export async function machineOf(page) {
  const { product } = await page.send('Browser.getVersion');
  return { ...hostOf(), chromium: String(product).replace(/^[^/]*\//, '') };
}

/**
 * The conditions a run measured under, which its numbers depend on: the one-minute load average when it started and
 * when it ended, whether Chromium ran headless, the window’s size and the device scale.
 * @param {Page} page  @param {number} loadAtStart  loadavg()[0] when the run started
 */
export async function conditionsOf(page, loadAtStart) {
  const shown = await page.evaluate('({ agent: navigator.userAgent, scale: devicePixelRatio })');
  return {
    load: { start: loadAtStart, end: loadavg()[0] },
    headless: /HeadlessChrome/.test(shown.agent),
    window: await windowSize(page),
    scale: shown.scale,
  };
}
