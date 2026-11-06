// The switch bench’s page side (#508, tools/bench-switch.mjs): where each switch starts and lands, the recorder it arms
// in the page before the click, the click, the key typed after it, the proof that a run timed the long room, and the
// traced switch.

import { writeFile } from 'node:fs/promises';
import { openFresh } from './bench-key-frame.mjs';
import { js, sleep } from './browser.mjs';
import { clearDraft } from './key-frame-measure.mjs';
import { heldStill } from './page-still.mjs';

/** The two projects and three conversations every size seeds. */
export const IDS = {
  projectA: 'pr_sw_short',
  projectB: 'pr_sw_long',
  shortA: 'th_sw_short_a',
  shortB: 'th_sw_short_b',
  long: 'th_sw_long',
  projectC: 'pr_sw_long2',
  long2: 'th_sw_long2',
};
export const LONG_PROJECT = 'Long project';
export const LONG_PROJECT_2 = 'Second long project';
export const SHORT_ITEMS = 20;
/** How long one switch may take before the run fails, in ms. */
const SWITCH_TIMEOUT = 120_000;

/** The two switches: where each starts, and where it lands. */
export const SWITCHES = [
  { name: 'project', label: 'Project switch', from: IDS.shortA, to: IDS.long },
  { name: 'conversation', label: 'Conversation switch', from: IDS.shortB, to: IDS.long },
];
/** ⌃J from one long room to the open ask at the end of a second, in another project: the person’s “Next needs you”. */
export const NEEDS_SWITCH = { name: 'needs', label: 'Next needs you (⌃J)', from: IDS.long, to: IDS.long2 };
export const MEASURES = [
  ['drawn', 'Last item drawn'],
  ['key', 'Key’s next frame'],
];

/**
 * Throws, loudly, unless a run timed the long room: its transcript, with every seeded item drawn and the last one
 * last, as the transcript stood when the timer stopped, and the key typed after the switch in its composer.
 * @param {{ thread: string, keys: number, last: string, composer: string, composerThread: string | null }} read
 * @param {{ thread: string, count: number, last: string }} expected
 */
export function proveRun(read, expected) {
  if (read.thread !== expected.thread) throw new Error(`The run timed ${read.thread}, not the long room ${expected.thread}.`);
  if (read.keys !== expected.count)
    throw new Error(`The long room had ${read.keys.toLocaleString('en-US')} items drawn, not the ${expected.count.toLocaleString('en-US')} seeded.`);
  if (read.last !== expected.last) throw new Error(`The long room’s last item drawn is ${read.last}, not ${expected.last}.`);
  if (read.composer !== 'x' || read.composerThread !== expected.thread)
    throw new Error(`The key typed after the switch isn’t in the long room’s composer (it holds “${read.composer}”, the draft of ${read.composerThread}).`);
}

/**
 * Throws unless a run's element counts measured something: the long room's transcript has elements, and the page has at
 * least as many as its transcript. A count of 0 is an instrument that counted nothing, not a constant DOM.
 * @param {{ page: number, transcript: number }} counts
 */
export function proveCounts({ page, transcript }) {
  if (!(transcript > 0)) throw new Error('The run counted no elements in the long room’s transcript.');
  if (page < transcript)
    throw new Error(`The run counted ${page.toLocaleString('en-US')} elements on the page but ${transcript.toLocaleString('en-US')} in its transcript.`);
}

/** The elements on the page, and in the long room's transcript, once the switch has settled. Runs in the page. */
function countElements(target) {
  const tr = document.querySelector(`#main.transcript[data-thread="${CSS.escape(target)}"]`);
  return { page: document.querySelectorAll('*').length, transcript: tr ? tr.querySelectorAll('*').length : 0 };
}

/**
 * Arms the page, before the click: the click’s pointerdown starts the timer and a frame loop that watches for the
 * target’s last item drawn in its transcript’s visible box; the composer’s first keydown records its next frame; and
 * __switchMounted resolves as soon as the target’s transcript and composer are on the page. Runs in the page.
 */
function arm(target, lastKey, startOnKey) {
  if ('__switch' in window) throw new Error('This document has already timed a switch: open it afresh for each run.');
  const rec = { t0: null, present: null, drawn: null, keyAt: null, keyFrame: null, timed: null };
  /** @type {any} */ (window).__switch = rec;
  const sel = `#main.transcript[data-thread="${CSS.escape(target)}"]`;
  // The transcript on the page when the timer stops, as it was then: what proveRun() checks it timed.
  const snapshot = (tr) => {
    const keyed = [...tr.children].filter((n) => n instanceof HTMLElement && n.dataset.key);
    return { thread: tr.dataset.thread ?? null, keys: keyed.length, last: /** @type {HTMLElement | undefined} */ (keyed.at(-1))?.dataset.key ?? null };
  };
  const drawn = (tr) => {
    if (tr?.dataset.thread !== target) return false;
    const last = tr.querySelector(`:scope > [data-key="${CSS.escape(lastKey)}"]`);
    if (!last) return false;
    const b = last.getBoundingClientRect();
    const v = tr.getBoundingClientRect();
    return b.height > 0 && b.bottom > v.top && b.top < v.bottom;
  };
  const check = () => {
    const tr = document.getElementById('main');
    if (tr && drawn(tr)) {
      rec.present = performance.now();
      requestAnimationFrame(() => {
        rec.drawn = performance.now();
        rec.timed = snapshot(tr);
      });
      return;
    }
    requestAnimationFrame(check);
  };
  const start = () => {
    if (rec.t0 !== null) return;
    rec.t0 = performance.now();
    requestAnimationFrame(check);
  };
  if (startOnKey) addEventListener('keydown', (e) => e.ctrlKey && e.key.toLowerCase() === 'j' && start(), true);
  else addEventListener('pointerdown', start, true);
  addEventListener(
    'keydown',
    (e) => {
      if (rec.keyAt !== null || e.target !== document.getElementById('composer-input')) return;
      rec.keyAt = performance.now();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          rec.keyFrame = performance.now();
        }),
      );
    },
    true,
  );
  /** @type {any} */ (window).__switchMounted = new Promise((ok) => {
    const on = () => !!document.querySelector(sel) && !!document.getElementById('composer-input');
    const mo = new MutationObserver(() => {
      if (!on()) return;
      mo.disconnect();
      ok(true);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  });
}

/** The transcript the timer stopped on, and where the key typed after the switch went, for proveRun(). Runs in the page. */
function readBack(ids) {
  const composer = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('composer-input'));
  return {
    .../** @type {any} */ (window).__switch.timed,
    composer: composer?.value ?? '',
    composerThread: ids.find((id) => localStorage.getItem(`pb-draft-${id}`) === 'x') ?? null,
  };
}

/** The middle of what expr finds, in the window, or an error. */
async function middleOf(page, expr, label) {
  await page.waitFor(`!!(${expr})`, { label });
  const at = await page.evaluate(
    `(() => { const b = (${expr}).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height, vw: innerWidth, vh: innerHeight }; })()`,
  );
  if (!(at.w > 0 && at.h > 0) || at.x < 0 || at.y < 0 || at.x > at.vw || at.y > at.vh)
    throw new Error(`${label} isn’t in the window to click: its middle is at (${at.x}, ${at.y}), ${at.w}×${at.h}.`);
  return { x: at.x, y: at.y };
}

/** ⌃J through Chromium’s input. */
async function ctrlJ(page) {
  for (const type of ['rawKeyDown', 'keyUp'])
    await page.send('Input.dispatchKeyEvent', { type, key: 'j', code: 'KeyJ', modifiers: 2, windowsVirtualKeyCode: 74 });
}

/** A left click through Chromium’s input. */
async function click(page, { x, y }) {
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}

const menuItem = `[...document.querySelectorAll('[role=menu] [role=menuitem]')].find((b) => b.textContent.includes(${js(LONG_PROJECT)}))`;
const railRow = (id) => `document.querySelector('nav.rail a.row[data-thread=${js(id).replace(/"/g, '')}]')`;

/**
 * Opens the switch’s short conversation afresh and holds still: for the project switch, with the places menu open.
 * Returns where the switch’s click goes.
 */
async function prepare(page, origin, sw) {
  await openFresh(page, `${origin}/#/t/${sw.from}`);
  await page.waitFor(`document.getElementById('main')?.dataset.thread === ${js(sw.from)}`, { label: `the short conversation ${sw.from}` });
  // Where the long room’s project opens is its latest conversation, not wherever an earlier run left it.
  await page.evaluate(`localStorage.removeItem('pb-last-${IDS.projectB}')`);
  let target;
  if (sw.name === 'needs') {
    // The person is in the first long room, at its own ask: ⌃J there goes to its agent’s ask first, and the next ⌃J,
    // the one timed, moves on to the other long room’s.
    await page.waitFor(`(${heldStill})()`, { timeout: 120_000, label: 'the first long room to hold still' });
    await ctrlJ(page);
    target = null;
  } else if (sw.name === 'project') {
    await click(page, await middleOf(page, `document.getElementById('places-button')`, 'the places menu button'));
    target = await middleOf(page, menuItem, `the ${LONG_PROJECT} item in the places menu`);
  } else {
    target = await middleOf(page, railRow(sw.to), 'the long room’s row in the rail');
  }
  await page.waitFor(`(${heldStill})()`, { timeout: 30_000, label: 'the page to hold still for two frames' });
  return target;
}

/**
 * One timed switch: arms the page, clicks, types a key into the long room’s composer once its view is on the page,
 * waits for both frames, proves it timed the long room, and returns both times in ms.
 */
export async function timeSwitch(page, origin, sw, expected) {
  const at = await prepare(page, origin, sw);
  await page.evaluate(`(${arm})(${js(sw.to)}, ${js(expected.last)}, ${sw.name === 'needs'})`);
  if (at) await click(page, at);
  else await ctrlJ(page);
  await page.evaluate(`Promise.race([window.__switchMounted, new Promise((r) => setTimeout(() => r(false), ${SWITCH_TIMEOUT}))])`);
  // ⌃J focuses the ask once it’s drawn; a key typed before that would land on the ask, not in the composer.
  if (sw.name === 'needs')
    await page.waitFor(`document.activeElement?.closest('[data-key]')?.dataset.key === ${js(expected.last)}`, {
      timeout: SWITCH_TIMEOUT,
      label: 'the ask ⌃J went to, focused',
    });
  const composer = await middleOf(page, `document.getElementById('composer-input')`, 'the long room’s composer');
  await click(page, composer);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'x', code: 'KeyX', text: 'x', unmodifiedText: 'x', windowsVirtualKeyCode: 88 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88 });
  await page.waitFor(`window.__switch.timed !== null && window.__switch.keyFrame !== null`, {
    timeout: SWITCH_TIMEOUT,
    label: 'the last item drawn and the key’s frame',
  });
  const rec = await page.evaluate('window.__switch');
  proveRun(await page.evaluate(`(${readBack})(${js([IDS.long, IDS.long2, IDS.shortA, IDS.shortB])})`), expected);
  await page.waitFor(`(${heldStill})()`, { timeout: 30_000, label: 'the page to hold still after the switch' });
  const elements = await page.evaluate(`(${countElements})(${js(sw.to)})`);
  proveCounts(elements);
  await page.evaluate(`(${clearDraft})()`);
  return { drawn: rec.drawn - rec.t0, key: rec.keyFrame - rec.t0, elements };
}

const TRACE_CATEGORIES =
  'devtools.timeline,disabled-by-default-devtools.timeline,blink,v8.execute,netlog,disabled-by-default-devtools.timeline.frame,disabled-by-default-v8.cpu_profiler';

/**
 * One more conversation switch, untimed and without the key, under a Chrome trace written to file, with what the page
 * fetched during it from the Network domain beside it (file.requests.json).
 */
export async function traceSwitch(page, origin, expected, file, log) {
  const sw = SWITCHES.find((s) => s.name === 'conversation');
  const at = await prepare(page, origin, sw);
  const events = [];
  const requests = new Map();
  let done = null;
  const complete = new Promise((ok) => {
    done = ok;
  });
  page.on('Tracing.dataCollected', (p) => events.push(...p.value));
  page.on('Tracing.tracingComplete', () => done());
  page.on('Network.requestWillBeSent', (p) =>
    requests.set(p.requestId, { url: p.request.url.replace(origin, ''), method: p.request.method, sent: p.timestamp }),
  );
  page.on('Network.responseReceived', (p) => Object.assign(requests.get(p.requestId) ?? {}, { status: p.response.status, timing: p.response.timing }));
  page.on('Network.loadingFinished', (p) => Object.assign(requests.get(p.requestId) ?? {}, { bytes: p.encodedDataLength, finished: p.timestamp }));
  await page.send('Network.enable');
  await page.send('Tracing.start', { categories: TRACE_CATEGORIES, transferMode: 'ReportEvents' });
  await page.evaluate(`(${arm})(${js(sw.to)}, ${js(expected.last)}, false)`);
  await page.evaluate(`performance.mark('switch-click')`);
  await click(page, at);
  await page.waitFor(`window.__switch.drawn !== null`, { timeout: SWITCH_TIMEOUT, label: 'the last item drawn, traced' });
  await sleep(500);
  const rec = await page.evaluate('window.__switch');
  await page.send('Tracing.end');
  await complete;
  await page.send('Network.disable');
  await writeFile(file, JSON.stringify({ traceEvents: events }));
  await writeFile(`${file}.requests.json`, JSON.stringify({ rec, requests: [...requests.values()] }, null, 2));
  log(`Traced one conversation switch: last item drawn ${(rec.drawn - rec.t0).toFixed(1)} ms; ${events.length} trace events, ${requests.size} requests.`);
}
