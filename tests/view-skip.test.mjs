import assert from 'node:assert/strict';
import test from 'node:test';

/** A transcript element as skipOffscreen() uses it: its classes. */
function fakeTranscript() {
  const classes = new Set();
  return { classes, classList: { add: (/** @type {string} */ c) => classes.add(c) } };
}

/** Runs fn with a CSS.supports that answers `supported`. @param {boolean} supported @param {() => Promise<void>} fn */
async function withCss(supported, fn) {
  globalThis.CSS = /** @type {any} */ ({
    supports: (/** @type {string} */ p, /** @type {string} */ v) => supported && p === 'content-visibility' && v === 'auto',
  });
  try {
    await fn();
  } finally {
    delete globalThis.CSS;
  }
}

test('#712 a browser without content-visibility gets no skipping', () =>
  withCss(false, async () => {
    const { skipOffscreen } = await import('../app/js/view-skip.mjs');
    const el = fakeTranscript();
    skipOffscreen(/** @type {any} */ (el));
    assert.deepEqual([...el.classes], []);
  }));

test('#712 a browser with content-visibility skips the transcript’s items off screen', () =>
  withCss(true, async () => {
    const { skipOffscreen, SKIP_CLASS } = await import('../app/js/view-skip.mjs');
    const el = fakeTranscript();
    skipOffscreen(/** @type {any} */ (el));
    assert.deepEqual([...el.classes], [SKIP_CLASS]);
  }));
