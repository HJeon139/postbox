// The budget spec (#1166): #1155’s target, held as a gate. Every interaction paints within 100 ms, p95, and the page
// holds at most about 5,000 elements, in rooms the big-room seed generates (#1017) at 1,000, 10,000 and 100,000 items.
// It runs the same in Chromium and Firefox, with only the probes both have (tools/budget-probe.mjs). Off the default
// runs:
//
//   npm run budget                                   every size, in the configured browser
//   POSTBOX_BUDGET_SIZES=1000 npm run budget         one size
//
// What gates where (#1166’s Done when, decided 10 Nov): on CI only the element count fails a run, and every time is
// reported; elsewhere, as on the reference Mac, the times gate too. At 100,000 items only the opening and the element
// count run, since no build opens a room that size in a bounded time until the page fetches by range (B1 to B3).
// Each measure is “pass”, “fail” or “not measured”, and only “pass” passes (tools/budget-stats.mjs). Every measure is
// recorded first and the size’s last test checks them all, so one past its budget doesn’t stop the others.

import { execFileSync } from 'node:child_process';
import { cpus, loadavg } from 'node:os';
import { expect, test } from '@playwright/test';
import { idleFor, paced } from '../../tools/budget-pace.mjs';
import { busy, installProbe, SLOW_KEY_ID, SLOW_KEY_MS, startFrames, stopFrames, THRESHOLD_MS, untilOpen, untilShown } from '../../tools/budget-probe.mjs';
import { elementsVerdict, gapCalibrated, gapVerdict, keyTimes, timedVerdict } from '../../tools/budget-stats.mjs';
import { calibrated } from '../../tools/key-frame-stats.mjs';
import { seedBigRoom } from '../../tools/uat/big-room.mjs';
import { startPostbox } from './postbox.mjs';
import { still } from './view-skipped-fixture.mjs';

const SIZES = (process.env.POSTBOX_BUDGET_SIZES ?? '1000,10000,100000').split(',').map(Number);
/** Sizes at which every measure runs; above it, only the opening and the element count (#1166, 4b). */
const TIMED_UP_TO = 10_000;
const UNTIMED = 'only the opening and the element count run at this size, until the page fetches by range';
/** An opening slower than this fails as over it, and the size’s other measures don’t run. */
const OPEN_CAP_MS = 120_000;
/** On CI only what doesn’t depend on the machine gates (#1166, 4a). */
const TIMES_GATE = !process.env.CI;
const KEYS = { warmup: 10, measured: 40, everyMs: 50 };
const MESSAGES = { count: 20, everyMs: 300 };
const SCROLLS = { count: 20, everyMs: 150 };
const OPENS = 5;
const PLANTED_TASK_MS = 150;
const TEXT = 'the release train leaves on time ';

// Tracing is off: Playwright’s trace snapshot walks the page each action, which would be measured too. Chromium runs
// as its headless shell, as PF-1’s tool does (tools/browser.mjs): its full headless mode, the config’s, presents no
// frame for a key typed into the composer until something else on the page changes, so Event Timing gave every key
// the time to that change, 1 to 2 s here, against 24 ms p95 in the shell. Firefox keeps its own.
test.use({
  trace: 'off',
  channel: async ({ browserName }, use) => use(browserName === 'chromium' ? 'chromium-headless-shell' : undefined),
});

/**
 * @typedef {{ measure: string, size: number, gates: boolean, verdict: string } & Record<string, any>} Line
 * @typedef {{ load: number, cpu: { idle: number, total: number } }} Since
 * @typedef {{ app: Awaited<ReturnType<typeof startPostbox>>, page: import('@playwright/test').Page, big: { id: string },
 *   small: { id: string }, newest: string, size: number, seedMs: number, lines: Line[] }} Room
 */

/** The machine’s CPU time so far, summed over its cores, for the idle share of a run. */
function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const { times } of cpus()) {
    idle += times.idle;
    total += times.idle + times.user + times.nice + times.sys + times.irq;
  }
  return { idle, total };
}

/** @returns {Since} */
const now = () => ({ load: loadavg()[0], cpu: cpuTimes() });

/** The commit measured, or null outside a checkout. */
function commit() {
  try {
    return execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/**
 * Records a measure’s result with the load and CPU idle it ran under, as an annotation and as one `budget:` line.
 * @param {Room} room  @param {string} name  @param {boolean} gates  @param {{ verdict: string } & Record<string, any>} result
 * @param {Since} since
 */
function report(room, name, gates, result, since) {
  const cpu = cpuTimes();
  const idle = (cpu.idle - since.cpu.idle) / Math.max(1, cpu.total - since.cpu.total);
  const line = { measure: name, size: room.size, gates, ...result, conditions: { load: { start: since.load, end: loadavg()[0] }, cpuIdle: idle } };
  const shown = JSON.stringify(line, (_, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v));
  test.info().annotations.push({ type: 'budget', description: shown });
  console.log(`budget: ${shown}`);
  room.lines.push(line);
}

/** In the page: what the probe has recorded. @param {import('@playwright/test').Page} page */
const recorded = (page) => page.evaluate(() => /** @type {any} */ (window).__budget);
const twoFrames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const blur = (page) => page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());

/**
 * Presses the planted slow key and waits for its Event Timing entry, and gives its place in the probe’s keys. Entries
 * come in the order their frames were presented, so once its entry is in, every earlier input’s is too, however busy
 * the page was: a key that’s still without one had none, rather than one that hadn’t arrived.
 * @param {import('@playwright/test').Page} page
 */
async function plantedKey(page) {
  await page.evaluate((id) => document.body.append(Object.assign(document.createElement('button'), { id, textContent: 'Budget probe' })), SLOW_KEY_ID);
  const index = (await recorded(page)).keys.length;
  await page.locator(`#${SLOW_KEY_ID}`).press('a');
  const reported = async () => {
    const rec = await recorded(page);
    return calibrated([rec.keys[index]?.at ?? Number.POSITIVE_INFINITY], rec.entries, SLOW_KEY_MS);
  };
  await expect.poll(reported, { message: `Event Timing to report the planted ${SLOW_KEY_MS} ms key`, timeout: 30_000 }).toBe(true);
  await page.evaluate((id) => document.getElementById(id)?.remove(), SLOW_KEY_ID);
  return index;
}

/** Starts a size’s Postbox, with its big room, a short room to switch from, and a page with the probe in it. */
async function openRoom(size, browser) {
  const app = await startPostbox(`budget-${size}`);
  const projectId = /** @type {any} */ (Object.values(app.rt.s.projects)[0]).id;
  const small = app.rt.createThread({ projectId, title: 'A short room', personaIds: [] });
  seedBigRoom(app.store, small.id, { count: 20 });
  const big = app.rt.createThread({ projectId, title: `${size.toLocaleString('en-US')} items`, personaIds: [] });
  const seeding = Date.now();
  seedBigRoom(app.store, big.id, { count: size, work: true });
  const seedMs = Date.now() - seeding;
  // Inside headless Chromium’s 1280 × 720 window: what lies outside it is never presented, so a key typed in a
  // composer below it gets no Event Timing entry until some other change presents a frame (tools/key-frame-stats.mjs,
  // outsideWindow). At the config’s 900 px the composer sat at 824 px, and every key read as 0.1–0.7 s.
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(installProbe, { threshold: THRESHOLD_MS, slowMs: SLOW_KEY_MS, slowId: SLOW_KEY_ID });
  return { app, page, big, small, newest: app.store.items(big.id).at(-1).id, size, seedMs, lines: [] };
}

/** The probes measure this browser: a planted slow key has its entry, and frames show a planted long task. @param {Room} room */
async function calibrate(room) {
  const { app, page, small } = room;
  const since = now();
  const started = Date.now();
  await page.goto(`${app.origin}/#/t/${small.id}`);
  // The page loads every conversation’s state before it draws one, so its start-up grows with the big room too.
  await expect(page.locator('#main > .item').last(), `the page to start within ${OPEN_CAP_MS / 1000} s`).toBeVisible({ timeout: OPEN_CAP_MS });
  report(room, 'start-up', false, { ms: Date.now() - started, verdict: 'reported' }, since);
  await still(page, 30_000);
  // Event Timing reports in this browser: the planted key gets its entry.
  await plantedKey(page);
  await page.evaluate(startFrames);
  await idleFor(1000);
  const idle = await page.evaluate(stopFrames);
  await page.evaluate(startFrames);
  await twoFrames(page);
  await page.evaluate(busy, PLANTED_TASK_MS);
  await twoFrames(page);
  const longest = Math.max(...(await page.evaluate(stopFrames)).gaps);
  expect(gapCalibrated(idle.gaps, longest, PLANTED_TASK_MS), `idle gaps ${JSON.stringify(idle.gaps.slice(0, 10))}…, planted ${longest}`).toBe(true);
}

/** Opening the room from load, then switching to it from the short room, and the elements it mounts. @param {Room} room */
async function measureOpening(room) {
  const { page, big, small, newest } = room;
  const since = now();
  // A first switch, not timed: the room has to open within the cap before its switches are measured.
  const started = Date.now();
  await page.locator(`.rail a.row[data-thread="${big.id}"]`).click();
  const shown = page.locator(`.transcript[data-thread="${big.id}"] [data-key="${newest}"]`);
  await expect(shown, `the room to open within ${OPEN_CAP_MS / 1000} s`).toBeAttached({ timeout: OPEN_CAP_MS });
  const firstMs = Date.now() - started;
  await still(page, 30_000);
  const times = [];
  const counts = [];
  for (let i = 0; i < OPENS; i++) {
    await page.locator(`.rail a.row[data-thread="${small.id}"]`).click();
    await expect(page.locator(`.transcript[data-thread="${small.id}"]`)).toBeAttached({ timeout: 30_000 });
    await still(page, 30_000);
    await page.locator(`.rail a.row[data-thread="${big.id}"]`).click();
    times.push(await page.evaluate(untilOpen, { threadId: big.id, id: newest }));
    await still(page, 30_000);
    counts.push(await page.evaluate(() => document.getElementsByTagName('*').length));
  }
  report(room, 'opening', TIMES_GATE, { ...timedVerdict(times), firstMs }, since);
  report(room, 'mounted elements', true, elementsVerdict(Math.max(...counts)), since);
}

/**
 * Presses keys at a fixed interval and reports their Event Timing times past the warm-up, and the longest frame gap.
 * @param {Room} room  @param {{ name: string, keys: string[], warmup: number, everyMs: number }} o
 */
async function measureKeys(room, { name, keys, warmup, everyMs }) {
  const { page } = room;
  const since = now();
  const from = (await recorded(page)).keys.length;
  await page.evaluate(startFrames);
  await paced(keys.length, everyMs, (i) => page.keyboard.press(keys[i]));
  await twoFrames(page);
  const frames = await page.evaluate(stopFrames);
  // The planted key ends the run: its entry comes after every measured key’s, and bounds the last one’s.
  const planted = await plantedKey(page);
  const rec = await recorded(page);
  const { values, unmeasured } = keyTimes(rec.keys.slice(from + warmup, planted + 1), rec.entries, THRESHOLD_MS);
  values.pop();
  report(room, name, TIMES_GATE, { ...timedVerdict(values, { unmeasured }), unmeasured }, since);
  report(room, `longest task, ${name}`, TIMES_GATE, gapVerdict(frames.gaps, frames.lengthMs), since);
}

/** Key to paint in the composer. @param {Room} room */
async function measureTyping(room) {
  await room.page.locator('#composer-input').click();
  await still(room.page);
  const count = KEYS.warmup + KEYS.measured;
  const keys = Array.from({ length: count }, (_, i) => (TEXT[i % TEXT.length] === ' ' ? 'Space' : TEXT[i % TEXT.length]));
  await measureKeys(room, { name: 'key to paint', keys, warmup: KEYS.warmup, everyMs: KEYS.everyMs });
  await room.page.locator('#composer-input').fill('');
}

/** A one-screen scroll: Page Up and Page Down on the page, in turn. @param {Room} room */
async function measureScrolling(room) {
  await blur(room.page);
  await still(room.page);
  const keys = Array.from({ length: SCROLLS.count }, (_, i) => (i % 2 === 0 ? 'PageUp' : 'PageDown'));
  await measureKeys(room, { name: 'one-screen scroll', keys, warmup: 0, everyMs: SCROLLS.everyMs });
}

/** A new message while following: from its arrival to the end of the frame that shows it. @param {Room} room */
async function measureMessages(room) {
  const { app, page, big } = room;
  const since = now();
  await blur(page);
  await expect(page.locator('#main.transcript')).toHaveAttribute('data-view-mode', 'following');
  await page.evaluate(startFrames);
  /** @type {number[]} */
  const times = [];
  await paced(MESSAGES.count, MESSAGES.everyMs, async (i) => {
    const it = app.rt.addItem(big.id, { kind: 'user', text: `A new message, ${i + 1} of ${MESSAGES.count}.` });
    times.push(await page.evaluate(untilShown, it.id));
  });
  const frames = await page.evaluate(stopFrames);
  report(room, 'new message', TIMES_GATE, timedVerdict(times), since);
  report(room, 'longest task, new message', TIMES_GATE, gapVerdict(frames.gaps, frames.lengthMs), since);
}

/** Every measure that gates here is within its budget. @param {Room} room */
function checkBudget(room) {
  const missed = room.lines.filter((l) => l.gates && l.verdict !== 'pass').map((l) => `${l.measure}: ${l.verdict}`);
  expect(missed, `measures past their budget, or not measured, at ${room.size.toLocaleString('en-US')} items`).toEqual([]);
}

for (const size of SIZES) {
  test.describe(`@budget ${size.toLocaleString('en-US')} items`, () => {
    test.describe.configure({ mode: 'serial', timeout: 15 * 60_000 });
    /** @type {Room} */
    let room;
    test.beforeAll(async ({ browser, browserName }) => {
      // Seeding 100,000 items takes about a minute on its own, past the default 30 s for a hook.
      test.setTimeout(15 * 60_000);
      room = await openRoom(size, browser);
      test.info().annotations.push({
        type: 'run',
        description: JSON.stringify({ commit: commit(), browser: browserName, version: browser.version(), size, seedMs: room.seedMs }),
      });
    });
    test.afterAll(async () => {
      await room?.page.close();
      await room?.app.stop();
    });
    test('the probes measure this browser', () => calibrate(room));
    test('opening the room, and the elements it mounts', () => measureOpening(room));
    test('key to paint in the composer', () => {
      test.skip(size > TIMED_UP_TO, UNTIMED);
      return measureTyping(room);
    });
    test('a new message while following', () => {
      test.skip(size > TIMED_UP_TO, UNTIMED);
      return measureMessages(room);
    });
    test('a one-screen scroll', () => {
      test.skip(size > TIMED_UP_TO, UNTIMED);
      return measureScrolling(room);
    });
    test('every measure that gates here is within its budget', () => checkBudget(room));
  });
}
