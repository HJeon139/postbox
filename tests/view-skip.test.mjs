import assert from 'node:assert/strict';
import test from 'node:test';

/** A transcript element as skipOffscreen() uses it: its classes and its listeners. */
function fakeTranscript() {
  const classes = new Set();
  /** @type {Map<string, Function>} */
  const listeners = new Map();
  return {
    classes,
    listeners,
    classList: { add: (/** @type {string} */ c) => classes.add(c) },
    addEventListener: (/** @type {string} */ type, /** @type {Function} */ fn) => listeners.set(type, fn),
    removeEventListener: (/** @type {string} */ type) => listeners.delete(type),
  };
}
const noSizes = { observe() {}, unobserve() {} };

test('#712 a browser that never says when a skipped item draws gets no skipping, and no listener', async () => {
  globalThis.HTMLElement = /** @type {any} */ (class {});
  try {
    const { skipOffscreen } = await import('../app/js/view-skip.mjs');
    const el = fakeTranscript();
    skipOffscreen(/** @type {any} */ (el), /** @type {any} */ (noSizes))();
    assert.deepEqual([...el.classes], []);
    assert.deepEqual([...el.listeners.keys()], []);
  } finally {
    delete globalThis.HTMLElement;
  }
});

test('#712 a browser that says when a skipped item draws skips them, and the view watches each item while it’s drawn', async () => {
  globalThis.HTMLElement = /** @type {any} */ (class {});
  /** @type {any} */ (globalThis.HTMLElement.prototype).oncontentvisibilityautostatechange = null;
  try {
    const { skipOffscreen, SKIP_CLASS } = await import('../app/js/view-skip.mjs');
    const el = fakeTranscript();
    const watched = new Set();
    const sizes = { observe: (/** @type {any} */ n) => watched.add(n), unobserve: (/** @type {any} */ n) => watched.delete(n) };
    const stop = skipOffscreen(/** @type {any} */ (el), /** @type {any} */ (sizes));
    assert.deepEqual([...el.classes], [SKIP_CLASS]);
    const item = { parentElement: el };
    const changed = /** @type {Function} */ (el.listeners.get('contentvisibilityautostatechange'));
    changed({ target: item, skipped: false });
    assert.deepEqual([...watched], [item], 'watched once it draws');
    changed({ target: { parentElement: item }, skipped: false });
    assert.deepEqual([...watched], [item], 'only the transcript’s own items');
    changed({ target: item, skipped: true });
    assert.deepEqual([...watched], [item], 'still watched once it’s skipped again: unwatching made the view and the browser take turns');
    stop();
    assert.deepEqual([...el.listeners.keys()], []);
  } finally {
    delete globalThis.HTMLElement;
  }
});
