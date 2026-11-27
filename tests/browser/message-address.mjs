// What the #168 specs share (message-address.spec.mjs and message-address-pane.spec.mjs): a long room, and whether a
// message has been gone to.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';

/** A room of 60 messages with @researcher, the first far above the end. @param {any} app @param {string} title */
export function longRoom(app, title) {
  const { rt } = app;
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const t = rt.createThread({ projectId, title, personaIds: [arrange.persona(rt, 'researcher').id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  const items = [];
  for (let i = 0; i < 60; i++)
    items.push(
      i % 2
        ? arrange.post(rt, t.id, { kind: 'agent', sessionId: se.id, handle: 'researcher', text: `Reply ${i}: ${'what it found. '.repeat(12)}`, status: 'done' })
        : arrange.post(rt, t.id, { kind: 'user', text: `Message ${i}: carry on.` }),
    );
  return { t, se, items };
}

/** Whether the message is drawn in view, and focus is in it. */
export const landed = (page, id) =>
  page.evaluate((key) => {
    const node = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (!node) return 'not drawn';
    const r = node.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return 'not in view';
    return node.contains(document.activeElement) ? 'landed' : 'not focused';
  }, id);

/** Whether the message is what’s on top at its own middle, not under Work or anything else. */
export const uncovered = (page, id) =>
  page.evaluate((key) => {
    const r = document.querySelector(`[data-key="${CSS.escape(key)}"]`)?.getBoundingClientRect();
    return Boolean(r) && !!document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20))?.closest(`[data-key="${CSS.escape(key)}"]`);
  }, id);

/**
 * Records, in the page, what moves the conversation’s scroll box around a press of End (#1884): End after going to a
 * message sometimes doesn’t scroll at all on CI, and never did locally. Add it before the page loads. It keeps the last
 * 400 entries, read only when End misses (readOnPast): our writes to the box with where they came from, its scroll
 * events, keys and whether End’s default was prevented, focus, pointer downs and address changes, and each frame for
 * 500 ms after End. The parts run in the page, so each is self-contained and gets what it shares from recorder().
 * @param {import('@playwright/test').Page} page
 */
export const recordEnd = (page) =>
  page.addInitScript({
    content: `if (window.top === window) {
      const r = (${recorder})();
      (${recordWrites})(r);
      (${recordEvents})(r, (end) => (${watchFrames})(r, end));
    }`,
  });

/** What the record’s parts share: its ring of entries, and how to name the box, an element and a write’s caller. */
function recorder() {
  /** @type {string[]} */
  const ring = [];
  Object.defineProperty(window, '__endRecord', { value: ring });
  const sizeOf = (/** @type {Element} */ s) => `${s.clientWidth}x${s.clientHeight}`;
  return {
    sizeOf,
    /** The box’s size at its last scroll event or resize, as view-state.mjs keeps it in v.size. */
    sizeSeen: '',
    note(/** @type {string} */ what) {
      ring.push(`${Math.round(performance.now())} ${what}`);
      if (ring.length > 400) ring.shift();
    },
    root: () => document.scrollingElement,
    where: (/** @type {Element | null} */ s) => (s ? `top ${Math.round(s.scrollTop)} of ${s.scrollHeight}, ${sizeOf(s)}` : 'no box'),
    named(/** @type {any} */ el) {
      if (el?.nodeType !== 1) return String(el?.nodeName);
      const item = el.closest('[data-key]');
      return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${item ? ` in ${item.dataset.key}` : ''}`;
    },
    /** The four frames above the wrapper that called this, without the page’s origin. */
    caller: () =>
      (new Error().stack ?? '')
        .split('\n')
        .slice(3, 7)
        .map((line) =>
          line
            .trim()
            .replace(/^at /, '')
            .replace(/https?:\/\/[^/]+/g, ''),
        )
        .join(' < '),
  };
}

/** Our writes to the box: scrollTop, scrollTo and scrollBy on it or the window, and any scrollIntoView. @param {any} r */
function recordWrites(r) {
  const top = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop'));
  Object.defineProperty(Element.prototype, 'scrollTop', {
    ...top,
    set(value) {
      if (this !== r.root()) return top.set?.call(this, value);
      const was = top.get?.call(this);
      top.set?.call(this, value);
      r.note(`set scrollTop ${Math.round(was)} → ${Math.round(value)}, now ${Math.round(top.get?.call(this))} @ ${r.caller()}`);
    },
  });
  for (const name of /** @type {const} */ (['scrollTo', 'scrollBy', 'scrollIntoView'])) {
    const own = /** @type {Function} */ (Element.prototype[name]);
    Element.prototype[name] = function (/** @type {any[]} */ ...args) {
      if (name === 'scrollIntoView' || this === r.root()) r.note(`${r.named(this)}.${name}(${JSON.stringify(args)}) @ ${r.caller()}`);
      return own.apply(this, args);
    };
  }
  for (const name of /** @type {const} */ (['scrollTo', 'scrollBy'])) {
    const own = /** @type {Function} */ (window[name]);
    window[name] = (/** @type {any[]} */ ...args) => {
      r.note(`window.${name}(${JSON.stringify(args)}) @ ${r.caller()}`);
      return own.apply(window, args);
    };
  }
}

/** The box’s scroll events and resizes, focus, pointer downs, address changes and keys; End starts watch. */
function recordEvents(/** @type {any} */ r, /** @type {(end: KeyboardEvent) => void} */ watch) {
  const scrolled = (/** @type {Event} */ e) => {
    const s = r.root();
    if (e.target !== document || !s) return;
    r.sizeSeen = r.sizeOf(s);
    r.note(`scroll, ${r.where(s)}`);
  };
  addEventListener('scroll', scrolled, { capture: true, passive: true });
  addEventListener('resize', () => {
    const s = r.root();
    if (s) r.sizeSeen = r.sizeOf(s);
    r.note(`resize ${innerWidth}x${innerHeight}, ${r.where(s)}`);
  });
  for (const type of ['focusin', 'focusout', 'pointerdown']) addEventListener(type, (e) => r.note(`${type} ${r.named(e.target)}`), true);
  addEventListener('hashchange', () => r.note(`hashchange ${location.hash}`));
  const pressed = (/** @type {KeyboardEvent} */ e) => {
    r.note(`keydown ${e.key} on ${r.named(e.target)}, top ${Math.round(r.root()?.scrollTop ?? -1)}`);
    if (e.key === 'End') watch(e);
  };
  addEventListener('keydown', pressed, true);
}

/**
 * Each frame for 500 ms after End: End’s default once it’s dispatched, then each view as view-publish.mjs writes it
 * (following or reading, the anchor, the smooth jump to the end), the box, and whether its size changed since its last
 * scroll or resize, what heard() in view-state.mjs compares (v.size against sizeOf(s)). pinned isn’t on the page: a
 * write’s caller says whether a jump’s hold made it.
 * @param {any} r @param {KeyboardEvent} end
 */
function watchFrames(r, end) {
  const views = () =>
    [...document.querySelectorAll('[data-view-mode]')]
      .map((el) => {
        const d = /** @type {HTMLElement} */ (el).dataset;
        return `${d.viewMode}${d.viewAnchor ? ` at ${d.viewAnchor} ${d.viewOffset}` : ''}${d.viewMoving ? `, moving ${d.viewMoving}` : ''}`;
      })
      .join('; ');
  const start = performance.now();
  let first = true;
  const frame = (/** @type {number} */ now) => {
    if (first) r.note(`End’s default prevented: ${end.defaultPrevented}`);
    first = false;
    const s = r.root();
    const size = s ? r.sizeOf(s) : '';
    r.note(`frame: ${views()}; ${r.where(s)}${size === r.sizeSeen ? '' : `, size ${size} since the last scroll’s ${r.sizeSeen}`}`);
    if (now - start < 500) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/**
 * Presses End and waits for the message to go out of view: reading on past it. Not retried (#1884): on a miss, the
 * record recordEnd() kept is printed, attached and annotated, then the miss fails the test.
 * @param {import('@playwright/test').Page} page @param {string} id
 */
export async function readOnPast(page, id) {
  await page.keyboard.press('End');
  await expect
    .poll(() => landed(page, id), { message: 'read on past it' })
    .toBe('not in view')
    .catch(async (/** @type {Error} */ err) => {
      const record = await page
        .evaluate(() => /** @type {any} */ (window).__endRecord?.join('\n') ?? '(not recording: call recordEnd before the page loads)')
        .catch((/** @type {Error} */ e) => `(no page: ${e.message})`);
      // The list reporter prints a failed test’s output, so the record is in CI’s log, not only in its JSON report.
      console.log(`Around End (#1884):\n${record}`);
      await test.info().attach('around End (#1884)', { body: record, contentType: 'text/plain' });
      test.info().annotations.push({ type: 'around End (#1884)', description: record });
      throw err;
    });
}
