// The budget spec’s probes in the page (#1166; its design note, §2). Only what Chromium and Firefox
// both have: Event Timing, performance.now() around requestAnimationFrame, and the page’s own EventSource. It runs as
// an init script, before the app loads, so it hears the first event; it changes nothing the app does.

/** The observer’s threshold: Event Timing reports nothing under it, and 16 ms is its least. */
export const THRESHOLD_MS = 16;
/** How long the planted key’s listener holds the page, so a run can prove Event Timing reports in this browser. */
export const SLOW_KEY_MS = 60;
/** The test-only element that key is pressed on. */
export const SLOW_KEY_ID = 'zz-budget-slow';

/**
 * Installed with page.addInitScript. window.__budget then holds every key pressed, with whether a frame ran after it;
 * every Event Timing entry for a key or a click; when each item.add event reached the page, by item id; and a frame
 * loop that can be started and stopped around a measure.
 * @param {{ threshold: number, slowMs: number, slowId: string }} o
 */
export function installProbe({ threshold, slowMs, slowId }) {
  const rec = {
    /** @type {{ at: number, framed: boolean, key: string }[]} */ keys: [],
    /** @type {{ at: number }[]} */ clicks: [],
    /** @type {{ name: string, startTime: number, duration: number }[]} */ entries: [],
    /** @type {Record<string, number>} */ arrived: {},
    /** @type {{ gaps: number[], last: number, start: number, on: boolean } | null} */ loop: null,
  };
  /** @type {any} */ (window).__budget = rec;
  const names = new Set(['keydown', 'keypress', 'pointerdown', 'pointerup', 'click']);
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (names.has(e.name)) rec.entries.push({ name: e.name, startTime: e.startTime, duration: e.duration });
  }).observe(/** @type {any} */ ({ type: 'event', durationThreshold: threshold, buffered: true }));
  addEventListener(
    'keydown',
    (e) => {
      const key = { at: e.timeStamp, framed: false, key: e.key };
      rec.keys.push(key);
      requestAnimationFrame(() => {
        key.framed = true;
      });
      if (/** @type {HTMLElement | null} */ (e.target)?.id !== slowId) return;
      const until = performance.now() + slowMs;
      while (performance.now() < until) {
        // The planted key’s wait: a busy loop, as a slow handler would be.
      }
    },
    true,
  );
  addEventListener('click', (e) => rec.clicks.push({ at: e.timeStamp }), true);
  /** @param {string} data */
  const stamp = (data) => {
    const id = JSON.parse(data)?.item?.id;
    if (id) rec.arrived[id] = performance.now();
  };
  // When each item.add reached the page: this listener is added before the app’s own, so it runs first.
  const add = EventSource.prototype.addEventListener;
  EventSource.prototype.addEventListener = function (type, listener, options) {
    if (type === 'item.add') add.call(this, type, (/** @type {MessageEvent} */ e) => stamp(e.data), options);
    return add.call(this, type, listener, options);
  };
}

/** In the page: starts the frame loop, which records the gap before each frame. */
export function startFrames() {
  const rec = /** @type {any} */ (window).__budget;
  const loop = { gaps: /** @type {number[]} */ ([]), last: performance.now(), start: performance.now(), on: true };
  rec.loop = loop;
  const tick = () => {
    if (!loop.on) return;
    const now = performance.now();
    loop.gaps.push(now - loop.last);
    loop.last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** In the page: stops the frame loop, and gives its gaps, the last one up to now, and how long it ran. */
export function stopFrames() {
  const loop = /** @type {any} */ (window).__budget.loop;
  loop.on = false;
  // The time since the last frame is a gap too: a long task that runs to the end of the measure still counts.
  const end = performance.now();
  return { gaps: [...loop.gaps, end - loop.last], lengthMs: end - loop.start };
}

/**
 * In the page: how long from an item’s arrival to the end of the first frame that has its node in the transcript. A
 * frame without it counts as waiting. The end is a task posted from that frame, after its paint.
 * @param {string} id
 */
export function untilShown(id) {
  const rec = /** @type {any} */ (window).__budget;
  return new Promise((resolve) => {
    const check = () => {
      const at = rec.arrived[id];
      if (at === undefined || !document.querySelector(`#main [data-key="${CSS.escape(id)}"]`)) return requestAnimationFrame(check);
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve(performance.now() - at);
      channel.port2.postMessage(null);
    };
    requestAnimationFrame(check);
  });
}

/**
 * In the page: how long from the last click to the end of the first frame that shows the item in the transcript of
 * the given conversation.
 * @param {{ threadId: string, id: string }} o
 */
export function untilOpen({ threadId, id }) {
  const rec = /** @type {any} */ (window).__budget;
  return new Promise((resolve) => {
    const check = () => {
      const node = document.querySelector(`.transcript[data-thread="${CSS.escape(threadId)}"] [data-key="${CSS.escape(id)}"]`);
      if (!node) return requestAnimationFrame(check);
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve(performance.now() - rec.clicks.at(-1).at);
      channel.port2.postMessage(null);
    };
    requestAnimationFrame(check);
  });
}

/** In the page: busies it for ms, as a long task would. @param {number} ms */
export function busy(ms) {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // A planted long task, for the frame probe’s calibration.
  }
}
