// #712: the UAT runner scrolls to an item the way the page does, through the page's own jumpTo (app/js/view-jump.mjs),
// so the item it lands on stays put while the items it passed draw at their real sizes. A stand-in page records each
// expression tools/uat/driver.mjs sends; node:test's mock timers stand in for the driver's waits.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { driver } from '../tools/uat/driver.mjs';

const JUMP = /\(await import\('\/app\/js\/view-jump\.mjs'\)\)\.jumpTo\(/;

/** A page that answers what the driver asks of it, and keeps every expression it was sent. */
function standIn() {
  const sent = [];
  const answer = (expr) => {
    if (expr.includes('getBoundingClientRect')) return { x: 10, y: 10, width: 100, height: 100 };
    return true;
  };
  const frame = { evaluate: async () => ({ x: 5, y: 5 }) };
  const page = {
    evaluate: async (expr) => {
      sent.push(expr);
      return answer(expr);
    },
    frameOf: async () => frame,
    send: async () => ({ data: '' }),
  };
  return { page, sent };
}

/** Runs fn with the driver's sleeps run at once. @param {import('node:test').TestContext} t */
async function fast(t, fn) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let done = false;
  const run = fn().finally(() => {
    done = true;
  });
  while (!done) {
    await new Promise((r) => setImmediate(r));
    t.mock.timers.runAll();
  }
  return run;
}

test('clickAt scrolls to what it clicks with the page’s jumpTo, not its own scrollIntoView', async (t) => {
  const { page, sent } = standIn();
  await fast(t, () => driver(page).clickAt(`document.querySelector('#x')`, 'x'));
  assert.match(sent[0], JUMP);
  assert.doesNotMatch(sent.join('\n'), /scrollIntoView/);
});

test('appClick brings the app’s item into view with the page’s jumpTo, centered', async (t) => {
  const { page, sent } = standIn();
  await fast(t, () => driver(page).appClick('it_app', 'Go'));
  const jumps = sent.filter((e) => JUMP.test(e));
  // Its own scroll, and one in each of the two appContext reads around it.
  assert.equal(jumps.length, 3);
  for (const e of jumps) {
    assert.match(e, /"it_app"/);
    assert.match(e, /, "center"\)/);
  }
  assert.doesNotMatch(sent.join('\n'), /scrollIntoView/);
});

test('shotItem puts the item at the top with the page’s jumpTo, then clears the sticky top bar', async (t) => {
  const { page, sent } = standIn();
  const dir = mkdtempSync(join(tmpdir(), 'uat-jump-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await fast(t, () => driver(page).shotItem('it_a', join(dir, 'a.png')));
  assert.match(sent[0], /jumpTo\(n, "start"\); scrollBy\(0, -\(/);
  assert.doesNotMatch(sent.join('\n'), /scrollIntoView/);
});
