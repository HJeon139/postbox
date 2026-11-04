// What the UAT runner records of the inputs it makes that can move the person’s view (facts.probes.inputs,
// tools/uat/probes.mjs; #531), and what it keeps: the driver’s shots and its reads of an app keep the view, and a click
// on an app, a telemetry click and a reload are recorded before they move it. Run against a page that answers each
// expression the way the real page would, and notes what reached it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localRestart } from '../tools/uat/conversation-step.mjs';
import { driver } from '../tools/uat/driver.mjs';
import { keepView, kept } from '../tools/uat/driver-shots.mjs';
import { fault } from '../tools/uat/hosts-watch.mjs';
import { newProbes, recordInput } from '../tools/uat/probes.mjs';
import { telemetryDriver } from '../tools/uat/telemetry-driver.mjs';

const FOLLOWING = { where: 'main', mode: 'following', anchor: '', offset: null, at: null, gap: 0 };
const READING = { where: 'main', mode: 'reading', anchor: 'it_a', offset: 40, at: 40, gap: 900 };

/**
 * A page that notes what reaches it, as what it is, and how many inputs were recorded by then. Each read of the view
 * gives the next of `views`, and the last one after that.
 */
function scriptedPage(facts, { views = [[READING]], frame = null } = {}) {
  /** @type {{ what: string, inputs: number }[]} */
  const calls = [];
  let reads = 0;
  const note = (what) => calls.push({ what, inputs: facts.probes.inputs.length });
  const page = {
    evaluate: async (/** @type {string} */ expr) => {
      if (expr.includes('viewMode')) {
        note('read');
        return views[Math.min(reads++, views.length - 1)];
      }
      if (expr.includes('const before =')) return note('restore');
      if (expr.includes('requestAnimationFrame')) return note('settled');
      if (expr.includes('scrollIntoView')) {
        note('scroll');
        // A shot finds its item gone; a click finds its control.
        return expr.includes("block: 'start'") ? false : { x: 10, y: 10 };
      }
      // Where the app’s frame is, and whether it has loaded.
      if (expr.includes('getBoundingClientRect')) return { x: 0, y: 0 };
      return expr.includes('.appframe iframe');
    },
    send: async (/** @type {string} */ method) => note(method),
    frameOf: async () => frame && { evaluate: async () => frame },
  };
  return { calls, page, what: () => calls.map((c) => c.what) };
}
const recorder = (facts, said = []) =>
  recordInput(
    facts.probes,
    () => 3,
    (l) => said.push(l),
  );

test('kept: a following view that comes back reading has moved', () => {
  assert.equal(kept(FOLLOWING, { ...READING }), false);
  assert.equal(kept(FOLLOWING, { ...FOLLOWING }), true);
});

test('kept: a reading view at the same anchor is kept within 1 px of its offset, and has moved at 2 px', () => {
  assert.equal(kept(READING, { ...READING, offset: 41, at: 41 }), true);
  assert.equal(kept(READING, { ...READING, offset: 42, at: 42 }), false);
  assert.equal(kept(READING, { ...READING, offset: 38, at: 38 }), false);
});

test('a shot that leaves the view moved is recorded, through the driver, as the runner’s at its step, and logged', async () => {
  const facts = { probes: newProbes() };
  const said = [];
  const { page } = scriptedPage(facts, { views: [[FOLLOWING], [READING]] });
  const d = driver(page, { input: recorder(facts, said) });
  assert.equal(await d.shotItem('it_gone', '/nonexistent/shot.png'), null);
  assert.deepEqual(
    facts.probes.inputs.map(({ step, cause, kind, where, before, after }) => ({ step, cause, kind, where, mode: [before.mode, after.mode] })),
    [{ step: 3, cause: 'runner', kind: undefined, where: 'main', mode: ['following', 'reading'] }],
  );
  assert.equal(said.length, 1);
  assert.match(said[0], /^the runner moved the main view: /);
});

test('reading inside an app puts the view back after, and is the runner’s own read, not a recorded click', async () => {
  const facts = { probes: newProbes() };
  const { page, what } = scriptedPage(facts, { frame: { text: 'Inside the app' } });
  const d = driver(page, { input: recorder(facts) });
  assert.deepEqual(await d.appInside('it_app'), { text: 'Inside the app' });
  const w = what();
  assert.equal(w[0], 'read', 'the view read before the app is scrolled to');
  assert.ok(w.indexOf('scroll') > 0, 'the app was scrolled into view, to load');
  assert.deepEqual(w.slice(-3), ['restore', 'settled', 'read'], 'and the view put back after');
  assert.deepEqual(facts.probes.inputs, [], 'nothing recorded: it was kept');
});

test('a click in an app is recorded once, as a runner click, before the first scroll that brings the app into view', async () => {
  const facts = { probes: newProbes() };
  const { calls, page } = scriptedPage(facts, { frame: { x: 5, y: 5 } });
  const d = driver(page, { input: recorder(facts) });
  await d.appClick('it_app', 'Save');
  assert.deepEqual(
    facts.probes.inputs.map((x) => [x.step, x.kind]),
    [[3, 'runner-click']],
  );
  const first = calls.find((c) => c.what === 'scroll');
  assert.equal(first?.inputs, 1, 'recorded before it scrolled');
  assert.ok(
    calls.some((c) => c.what === 'Input.dispatchMouseEvent'),
    'and it clicked',
  );
});

test('an app is brought to the middle of the view to read or click it, since one far off screen loads only there', async () => {
  const exprs = [];
  const page = {
    evaluate: async (/** @type {string} */ expr) => {
      exprs.push(expr);
      return expr.includes('viewMode') ? [READING] : true;
    },
    send: async () => {},
    frameOf: async () => null,
  };
  await driver(page).appInside('it_app');
  assert.ok(exprs.some((e) => /scrollIntoView\(\{ block: 'center' \}\)/.test(e)));
});

test('a telemetry click is recorded as a runner click before it scrolls what it clicks into view', async () => {
  const facts = { probes: newProbes() };
  const order = [];
  const page = {
    evaluate: async (/** @type {string} */ expr) => {
      if (expr.includes('aria-pressed')) return false;
      order.push(`${expr.includes('scrollIntoView') ? 'scroll' : 'other'} after ${facts.probes.inputs.length}`);
      return true;
    },
  };
  await telemetryDriver(page, { input: recorder(facts) }).react('it_a', '🚩');
  assert.deepEqual(
    facts.probes.inputs.map((x) => [x.step, x.kind]),
    [[3, 'runner-click']],
  );
  assert.deepEqual(order, ['scroll after 1']);
});

test('restarting Postbox in a run without hosts records the reload before the page reloads', async () => {
  const facts = { probes: newProbes() };
  const order = [];
  const page = { reload: async () => order.push(`reload after ${facts.probes.inputs.length}`) };
  const postbox = { restart: async () => 1500 };
  await localRestart({ postbox, page, log: () => {}, input: recorder(facts) }, { fault: 'restart-postbox' });
  assert.deepEqual(
    facts.probes.inputs.map((x) => [x.step, x.kind]),
    [[3, 'reload']],
  );
  assert.deepEqual(order, ['reload after 1']);
});

test('restarting Postbox in a host run records the reload before the page reloads', async () => {
  const facts = { probes: newProbes() };
  const order = [];
  const page = { reload: async () => order.push(`reload after ${facts.probes.inputs.length}`) };
  const hr = {
    api: async () => ({ state: { hostStatus: {} } }),
    hosts: [],
    postbox: { restart: async () => 1500 },
    record: { faults: [] },
    placement: {},
    kit: { ev: async () => [] },
    log: () => {},
  };
  await fault(/** @type {any} */ (hr), { fault: 'restart-postbox', target: undefined }, page, recorder(facts));
  assert.deepEqual(
    facts.probes.inputs.map((x) => [x.step, x.kind]),
    [[3, 'reload']],
  );
  assert.deepEqual(order, ['reload after 1']);
});

test('the driver hands its input hook on, for telemetry’s clicks and the reloads', () => {
  const facts = { probes: newProbes() };
  driver({}, { input: recorder(facts) }).input({ kind: 'reload' });
  assert.deepEqual(
    facts.probes.inputs.map((x) => [x.step, x.kind]),
    [[3, 'reload']],
  );
  driver({}).input({ kind: 'reload' });
});

test('a capture that throws keeps its own error when putting the view back throws too; a restore that throws alone is reported', async () => {
  let calls = 0;
  // The first evaluate reads the view, here no transcript; every later one, the restore's, fails.
  const ev = async () => {
    calls++;
    if (calls > 1) throw new Error('The page went away.');
    return [];
  };
  const capture = async () => {
    throw new Error('The capture failed.');
  };
  await assert.rejects(
    keepView(ev, capture, () => {}),
    /The capture failed\./,
  );
  calls = 0;
  await assert.rejects(
    keepView(
      ev,
      async () => 'shot',
      () => {},
    ),
    /The page went away\./,
  );
});
