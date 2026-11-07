import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayOf, timeOf } from '../app/js/dom.mjs';

// Midnight and noon, a day either side of each daylight change in the US and the EU, and the year’s ends: in this
// process’s own time zone, as the page has.
const TIMES = [
  Date.UTC(2026, 0, 1, 0, 0),
  Date.UTC(2026, 2, 8, 9, 59),
  Date.UTC(2026, 2, 8, 10, 1),
  Date.UTC(2026, 2, 29, 0, 59),
  Date.UTC(2026, 2, 29, 1, 1),
  Date.UTC(2026, 10, 1, 8, 30),
  Date.UTC(2026, 10, 6, 12, 0),
  Date.UTC(2026, 11, 31, 23, 59),
];

test('timeOf and dayOf read as the toLocale*String calls they replaced (#866)', () => {
  for (const ms of TIMES) {
    assert.equal(timeOf(ms), new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }), String(ms));
    assert.equal(dayOf(ms), new Date(ms).toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' }), String(ms));
  }
});

test('timeOf and dayOf make no formatter per call: a switch into a long room calls each once an item (#866)', (t) => {
  const Real = Intl.DateTimeFormat;
  const { toLocaleTimeString, toLocaleDateString } = Date.prototype;
  let made = 0;
  let localeCalls = 0;
  // Counts a formatter made with the constructor, and the toLocale*String calls, which make theirs inside the engine
  // where the constructor never sees it.
  Intl.DateTimeFormat = /** @type {any} */ (
    function DateTimeFormat(/** @type {any[]} */ ...args) {
      made++;
      return new Real(...args);
    }
  );
  Date.prototype.toLocaleTimeString = function (/** @type {any[]} */ ...args) {
    localeCalls++;
    return toLocaleTimeString.apply(this, args);
  };
  Date.prototype.toLocaleDateString = function (/** @type {any[]} */ ...args) {
    localeCalls++;
    return toLocaleDateString.apply(this, args);
  };
  t.after(() => {
    Intl.DateTimeFormat = Real;
    Object.assign(Date.prototype, { toLocaleTimeString, toLocaleDateString });
  });
  for (const ms of TIMES) {
    timeOf(ms);
    dayOf(ms);
  }
  assert.equal(made, 0, 'no formatter built per call');
  assert.equal(localeCalls, 0, 'no toLocale*String per call');
});
