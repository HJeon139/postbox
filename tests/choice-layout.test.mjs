import assert from 'node:assert/strict';
import test from 'node:test';

test('#673 a choice removed by a re-render is no longer observed', async () => {
  let callback;
  const observed = [];
  const unobserved = [];
  globalThis.ResizeObserver = class {
    constructor(fn) {
      callback = fn;
    }
    observe(target) {
      observed.push(target);
    }
    unobserve(target) {
      unobserved.push(target);
    }
  };
  try {
    const { fitChoiceOptions } = await import('../app/js/choice-layout.mjs');
    const options = { isConnected: false };
    assert.equal(fitChoiceOptions(options), options);
    assert.deepEqual(observed, [options]);
    callback([{ target: options }]);
    assert.deepEqual(unobserved, [options]);
  } finally {
    delete globalThis.ResizeObserver;
  }
});
