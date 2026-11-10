import assert from 'node:assert/strict';
import test from 'node:test';

/** A transcript element as skipOffscreen() uses it: its classes. */
function fakeTranscript() {
  const classes = new Set();
  return {
    classes,
    dataset: /** @type {Record<string, string>} */ ({}),
    classList: {
      add: (/** @type {string} */ c) => classes.add(c),
      remove: (/** @type {string} */ c) => classes.delete(c),
    },
  };
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

for (const windowFirst of [false, true])
  test(`#866 the window holds skipping off, and lets go of it on, whether it came ${windowFirst ? 'before' : 'after'} the view`, () =>
    withCss(true, async () => {
      const { skipOffscreen, holdSkipping, SKIP_CLASS } = await import('../app/js/view-skip.mjs');
      const el = /** @type {any} */ (fakeTranscript());
      if (windowFirst) holdSkipping(el, true);
      skipOffscreen(el);
      holdSkipping(el, true);
      assert.deepEqual([...el.classes], [], 'held: no skipping');
      holdSkipping(el, false);
      assert.deepEqual([...el.classes], [SKIP_CLASS], 'let go: skipping again');
    }));

test('#866 a transcript that never skipped (a panel, a browser without it) doesn’t start when the window lets go', () =>
  withCss(false, async () => {
    const { skipOffscreen, holdSkipping } = await import('../app/js/view-skip.mjs');
    const el = /** @type {any} */ (fakeTranscript());
    skipOffscreen(el);
    holdSkipping(el, true);
    holdSkipping(el, false);
    assert.deepEqual([...el.classes], []);
  }));
